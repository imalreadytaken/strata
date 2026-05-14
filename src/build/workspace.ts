/**
 * Build Bridge — per-build workdir scaffolding.
 *
 * `setupBuildWorkspace` creates `<buildsDir>/<sessionId>-<timestamp>/` and
 * materialises the four artefacts Claude Code reads on startup:
 *   - AGENTS.md  (constitution, copied verbatim)
 *   - PLAN.md    (the user's approved plan)
 *   - USER_CONTEXT.md (rendered from live capability + proposal state)
 *   - existing_capabilities/<name>/  (read-only meta+migrations snapshot)
 * Then runs `git init` + initial commit so the integration phase has a
 * rollback target.
 *
 * See `openspec/changes/add-build-workspace/specs/build-workspace/spec.md`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { CapabilityRegistry } from "../capabilities/types.js";
import type { Logger } from "../core/logger.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";

export interface BuildContext {
  /** Short label, mirrors `proposals.title`. */
  requestedTitle: string;
  /** One-sentence description; mirrors `proposals.summary`. */
  requestedSummary: string;
  /** Optional `proposals.rationale`. */
  rationale?: string;
}

export interface BuildWorkspaceHandle {
  workdir: string;
  agentsMdPath: string;
  planMdPath: string;
  userContextMdPath: string;
  existingCapabilitiesDir: string;
  /** SHA of the initial commit; orchestrator diffs against this for change detection. */
  gitInitialCommit: string;
}

export interface SetupBuildWorkspaceOptions {
  sessionId: string;
  planContents: string;
  buildContext: BuildContext;
  /** Constitution text. Caller supplies; we don't read from disk to keep this testable. */
  agentsMdSource: string;
  /** Root for build workdirs, typically `config.paths.buildsDir`. */
  buildsDir: string;
  capabilities: CapabilityRegistry;
  proposalsRepo: ProposalsRepository;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  logger: Logger;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

export interface RenderUserContextOptions {
  capabilityRegistryRepo: CapabilityRegistryRepository;
  proposalsRepo: ProposalsRepository;
  buildContext: BuildContext;
  now?: () => Date;
}

/**
 * Pure-ish: reads from the two repos but does no FS IO. Returns the
 * USER_CONTEXT.md body.
 */
export async function renderUserContext(
  opts: RenderUserContextOptions,
): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const timestamp = now().toISOString();

  const activeCaps = await opts.capabilityRegistryRepo.findMany({
    status: "active",
  });
  const pendingProposals = await opts.proposalsRepo.findMany({
    status: "pending",
  });

  const lines: string[] = [];
  lines.push(`# Strata user context (build triggered ${timestamp})`, "");

  lines.push("## Active capabilities", "");
  if (activeCaps.length === 0) {
    lines.push("(none yet)");
  } else {
    lines.push("| name | version | primary_table |");
    lines.push("|---|---|---|");
    for (const c of activeCaps) {
      lines.push(`| ${c.name} | ${c.version} | ${c.primary_table} |`);
    }
  }
  lines.push("");

  lines.push("## Pending proposals", "");
  if (pendingProposals.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of pendingProposals) {
      lines.push(`- #${p.id} (${p.source} / ${p.kind}): ${p.title}`);
    }
  }
  lines.push("");

  lines.push("## This build", "");
  lines.push(`- title: ${opts.buildContext.requestedTitle}`);
  lines.push(`- summary: ${opts.buildContext.requestedSummary}`);
  if (opts.buildContext.rationale) {
    lines.push(`- rationale: ${opts.buildContext.rationale}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Create and populate a fresh build workdir. Returns a handle the caller
 * (orchestrator) uses to launch the Claude Code runner and later integrate
 * the result.
 */
export async function setupBuildWorkspace(
  opts: SetupBuildWorkspaceOptions,
): Promise<BuildWorkspaceHandle> {
  const log = opts.logger.child({ module: "build.workspace" });
  const now = opts.now ?? (() => new Date());
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const workdir = path.join(opts.buildsDir, `${opts.sessionId}-${stamp}`);

  await mkdir(workdir, { recursive: true });

  const agentsMdPath = path.join(workdir, "AGENTS.md");
  await writeFile(agentsMdPath, opts.agentsMdSource, "utf8");

  const planMdPath = path.join(workdir, "PLAN.md");
  await writeFile(planMdPath, opts.planContents, "utf8");

  const userContextMdPath = path.join(workdir, "USER_CONTEXT.md");
  const renderOpts: RenderUserContextOptions = {
    capabilityRegistryRepo: opts.capabilityRegistryRepo,
    proposalsRepo: opts.proposalsRepo,
    buildContext: opts.buildContext,
  };
  if (opts.now) renderOpts.now = opts.now;
  const userContext = await renderUserContext(renderOpts);
  await writeFile(userContextMdPath, userContext, "utf8");

  const existingCapabilitiesDir = path.join(workdir, "existing_capabilities");
  await mkdir(existingCapabilitiesDir, { recursive: true });

  for (const [name, loaded] of opts.capabilities) {
    const destRoot = path.join(existingCapabilitiesDir, name);
    await mkdir(destRoot, { recursive: true });
    // meta.json
    await copyFile(loaded.metaPath, path.join(destRoot, "meta.json"));
    // migrations/ — copy whole dir if present.
    const srcMigrations = path.join(loaded.path, "migrations");
    if (existsSync(srcMigrations)) {
      await cp(srcMigrations, path.join(destRoot, "migrations"), {
        recursive: true,
      });
    }
  }

  const gitInitialCommit = gitInitWorkdir(workdir);
  log.info("build workspace ready", {
    workdir,
    sessionId: opts.sessionId,
    commit: gitInitialCommit,
  });

  return {
    workdir,
    agentsMdPath,
    planMdPath,
    userContextMdPath,
    existingCapabilitiesDir,
    gitInitialCommit,
  };
}

/**
 * Recursively remove the workdir. Idempotent — calling on a missing dir
 * does not throw.
 */
export async function cleanupBuildWorkspace(
  handle: BuildWorkspaceHandle,
): Promise<void> {
  await rm(handle.workdir, { recursive: true, force: true });
}

function gitInitWorkdir(workdir: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Strata",
    GIT_AUTHOR_EMAIL: "strata@local",
    GIT_COMMITTER_NAME: "Strata",
    GIT_COMMITTER_EMAIL: "strata@local",
  };
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  run(["init", "-q"]);
  // Ensure a known default branch — avoids depending on the user's git config.
  try {
    run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  } catch {
    /* older git versions handle the default via init.defaultBranch; ignore */
  }
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial workspace"]);
  return run(["rev-parse", "HEAD"]);
}
