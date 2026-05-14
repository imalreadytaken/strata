/**
 * Build Bridge — plan + decompose phases.
 *
 * Each phase = render a prompt template + invoke the runner + collect the
 * known on-disk artefacts. Phases are pure transport over the runner; the
 * orchestrator owns retry / validation / integration semantics.
 *
 * See `openspec/changes/add-build-phases/specs/build-phases/spec.md`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { runClaudeCode, type RunClaudeCodeOptions, type StreamJsonEvent } from "./claude_code_runner.js";

// ---------- types ---------------------------------------------------------

export interface PlanPhaseResult {
  planMd: string;
  sessionId: string | null;
  exitCode: number;
  eventCount: number;
  stderr: string;
}

export interface DecomposePhaseResult {
  changeIds: string[];
  sessionId: string | null;
  exitCode: number;
  eventCount: number;
  stderr: string;
}

export interface PlanProposal {
  title: string;
  summary: string;
  rationale?: string;
}

type RunnerPassthroughOptions = Pick<
  RunClaudeCodeOptions,
  "workdir" | "maxTurns" | "env" | "signal" | "spawn"
>;

export interface RunPlanPhaseOptions extends RunnerPassthroughOptions {
  proposal: PlanProposal;
  capabilitiesList: string[];
  /** Optional sink for raw events (the orchestrator's progress forwarder). */
  onEvent?: (event: StreamJsonEvent) => void;
  /** Resume an earlier plan-phase Claude session id. */
  resumeSessionId?: string;
}

export interface RunDecomposePhaseOptions extends RunnerPassthroughOptions {
  extraInstructions?: string;
  onEvent?: (event: StreamJsonEvent) => void;
  resumeSessionId?: string;
}

// ---------- prompt templates ---------------------------------------------

export const PLAN_PROMPT_TEMPLATE = `You are inside a Strata build workdir as the plan-phase agent.

The user has asked Strata to add a new capability:
- title: {{title}}
- summary: {{summary}}
- rationale: {{rationale}}

The currently active capabilities are:
{{capabilitiesList}}

Your job:

1. Read AGENTS.md, USER_CONTEXT.md, and any existing_capabilities/ directories so you understand the platform's rules and the user's setup.
2. Write a single file at PLAN.md in the working directory describing the smallest reasonable capability that satisfies the user's intent. Include:
   - the proposed capability \`name\` (kebab/snake-case)
   - the \`primary_table\` schema (columns + types + constraints) following AGENTS.md (money in INTEGER minor units, ISO 8601 TEXT timestamps, the 7 mandatory business-row columns)
   - the \`ingest_event_types\` the pipeline will accept
   - one or two example user messages and the structured rows they'd produce
3. STOP once PLAN.md is on disk. Do NOT generate migration SQL, pipeline code, or extract prompts in this phase — that is for the decompose / apply phases.

If the user's request is ambiguous, write PLAN.md with explicit questions in a "## Open questions" section instead of guessing.`;

export function renderPlanPrompt(opts: {
  proposal: PlanProposal;
  capabilitiesList: string[];
}): string {
  const caps =
    opts.capabilitiesList.length === 0
      ? "(none yet)"
      : opts.capabilitiesList.map((c) => `- ${c}`).join("\n");
  return PLAN_PROMPT_TEMPLATE.replace("{{title}}", opts.proposal.title)
    .replace("{{summary}}", opts.proposal.summary)
    .replace("{{rationale}}", opts.proposal.rationale ?? "")
    .replace("{{capabilitiesList}}", caps);
}

// The §7.4 prompt verbatim.
export const DECOMPOSE_PROMPT_TEMPLATE = `You are decomposing a user-approved PLAN.md into atomic OpenSpec changes.

Read PLAN.md carefully. Then for each atomic unit of work, run /opsx:propose
with a clear description. Each change should:

- Be implementable in ~3-5 minutes by Claude Code
- Have clear dependencies (schema before pipeline before skill, etc.)
- Be independently verifiable

Typical decomposition for a new capability:
1. Schema + meta.json + migration (depends on: nothing)
2. Ingest pipeline + extract_prompt (depends on: 1)
3. Agent skill (depends on: 1, 2)
4. Dashboard widgets (depends on: 1, optional)
5. Cron jobs (depends on: 1, 2, optional)

For schema evolution, typical decomposition:
1. New migration ALTER TABLE
2. Updated extract_prompt
3. Updated pipeline
4. Re-extraction job registration
5. Updated dashboard (if affected)

After creating all changes, write CHANGES_SUMMARY.md with:
- Ordered list of change IDs
- One-line description for each
- Dependency markers

{{extraInstructions}}`;

export function renderDecomposePrompt(opts: { extraInstructions?: string } = {}): string {
  return DECOMPOSE_PROMPT_TEMPLATE.replace(
    "{{extraInstructions}}",
    opts.extraInstructions ?? "",
  );
}

// ---------- runners -------------------------------------------------------

/** Wrap caller's onEvent + capture session_id from the first `system` event. */
function wrapWithSessionCapture(
  onEvent: ((event: StreamJsonEvent) => void) | undefined,
): { wrapped: (event: StreamJsonEvent) => void; getSessionId: () => string | null } {
  let sessionId: string | null = null;
  return {
    wrapped: (event) => {
      if (sessionId === null && event.type === "system") {
        const r = event.raw as Record<string, unknown>;
        const id = r.session_id ?? r.id;
        if (typeof id === "string" && id.length > 0) sessionId = id;
      }
      if (onEvent) onEvent(event);
    },
    getSessionId: () => sessionId,
  };
}

export async function runPlanPhase(
  opts: RunPlanPhaseOptions,
): Promise<PlanPhaseResult> {
  const prompt = renderPlanPrompt({
    proposal: opts.proposal,
    capabilitiesList: opts.capabilitiesList,
  });
  const sess = wrapWithSessionCapture(opts.onEvent);
  const runnerOpts: RunClaudeCodeOptions = {
    workdir: opts.workdir,
    prompt,
    mode: "explore",
    maxTurns: opts.maxTurns,
    onEvent: sess.wrapped,
  };
  if (opts.resumeSessionId) runnerOpts.resumeSessionId = opts.resumeSessionId;
  if (opts.env) runnerOpts.env = opts.env;
  if (opts.signal) runnerOpts.signal = opts.signal;
  if (opts.spawn) runnerOpts.spawn = opts.spawn;
  const handle = runClaudeCode(runnerOpts);
  const result = await handle.result;

  const planPath = path.join(opts.workdir, "PLAN.md");
  let planMd = "";
  if (existsSync(planPath)) {
    try {
      planMd = await readFile(planPath, "utf8");
    } catch {
      planMd = "";
    }
  }

  return {
    planMd,
    sessionId: sess.getSessionId(),
    exitCode: result.exitCode,
    eventCount: result.eventCount,
    stderr: result.stderr,
  };
}

export async function runDecomposePhase(
  opts: RunDecomposePhaseOptions,
): Promise<DecomposePhaseResult> {
  const prompt = renderDecomposePrompt(opts);
  const sess = wrapWithSessionCapture(opts.onEvent);
  const runnerOpts: RunClaudeCodeOptions = {
    workdir: opts.workdir,
    prompt,
    mode: "propose",
    maxTurns: opts.maxTurns,
    onEvent: sess.wrapped,
  };
  if (opts.resumeSessionId) runnerOpts.resumeSessionId = opts.resumeSessionId;
  if (opts.env) runnerOpts.env = opts.env;
  if (opts.signal) runnerOpts.signal = opts.signal;
  if (opts.spawn) runnerOpts.spawn = opts.spawn;
  const handle = runClaudeCode(runnerOpts);
  const result = await handle.result;

  const changesDir = path.join(opts.workdir, "openspec", "changes");
  let changeIds: string[] = [];
  if (existsSync(changesDir)) {
    try {
      changeIds = readdirSync(changesDir)
        .filter((name) => {
          if (name === "archive") return false;
          const full = path.join(changesDir, name);
          try {
            return statSync(full).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      changeIds = [];
    }
  }

  return {
    changeIds,
    sessionId: sess.getSessionId(),
    exitCode: result.exitCode,
    eventCount: result.eventCount,
    stderr: result.stderr,
  };
}
