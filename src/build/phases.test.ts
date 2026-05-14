import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { spawn as nodeSpawn } from "node:child_process";
import {
  PLAN_PROMPT_TEMPLATE,
  DECOMPOSE_PROMPT_TEMPLATE,
  renderDecomposePrompt,
  renderPlanPrompt,
  runDecomposePhase,
  runPlanPhase,
} from "./phases.js";

// ------------------------------------------------------------------------
// Fake spawn — minimal copy from claude_code_runner.test.ts. Lets us drive
// a runner without `claude` installed.
// ------------------------------------------------------------------------

interface FakeChildOptions {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
}

function makeFakeSpawn(opts: FakeChildOptions): typeof nodeSpawn {
  return ((..._args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      stdout: EventEmitter & { setEncoding?: (enc: string) => void };
      stderr: EventEmitter & { setEncoding?: (enc: string) => void };
      kill: (sig?: NodeJS.Signals) => boolean;
    };
    child.pid = 12345;
    child.exitCode = null;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding?: () => void };
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as EventEmitter & { setEncoding?: () => void };
    stderr.setEncoding = () => {};
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;
    queueMicrotask(() => {
      for (const chunk of opts.stdoutChunks ?? []) stdout.emit("data", chunk);
      for (const chunk of opts.stderrChunks ?? []) stderr.emit("data", chunk);
      child.exitCode = opts.exitCode ?? 0;
      child.emit("exit", opts.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

// ------------------------------------------------------------------------
// Prompt renderers
// ------------------------------------------------------------------------

describe("renderPlanPrompt", () => {
  it("substitutes title / summary / rationale / capabilitiesList", () => {
    const out = renderPlanPrompt({
      proposal: {
        title: "Track weight",
        summary: "Track body weight over time.",
        rationale: "Health monitoring.",
      },
      capabilitiesList: ["expenses", "moods"],
    });
    expect(out).toContain("Track weight");
    expect(out).toContain("Track body weight over time.");
    expect(out).toContain("Health monitoring.");
    expect(out).toContain("- expenses");
    expect(out).toContain("- moods");
    expect(out).not.toContain("{{");
  });

  it("renders (none yet) when capabilitiesList is empty", () => {
    const out = renderPlanPrompt({
      proposal: { title: "x", summary: "y" },
      capabilitiesList: [],
    });
    expect(out).toContain("(none yet)");
  });

  it("PLAN_PROMPT_TEMPLATE references PLAN.md and STOP", () => {
    expect(PLAN_PROMPT_TEMPLATE).toContain("PLAN.md");
    expect(PLAN_PROMPT_TEMPLATE.toLowerCase()).toContain("stop");
  });
});

describe("renderDecomposePrompt", () => {
  it("carries the §7.4 directives", () => {
    const out = renderDecomposePrompt();
    expect(out).toContain("PLAN.md");
    expect(out).toContain("atomic OpenSpec changes");
    expect(out).toContain("Typical decomposition for a new capability");
  });

  it("substitutes extraInstructions when supplied", () => {
    const out = renderDecomposePrompt({
      extraInstructions: "Note: skip dashboard for V1.",
    });
    expect(out).toContain("Note: skip dashboard for V1.");
  });

  it("leaves no placeholders when extraInstructions omitted", () => {
    const out = renderDecomposePrompt();
    expect(out).not.toContain("{{");
  });

  it("DECOMPOSE_PROMPT_TEMPLATE matches the §7.4 expectations", () => {
    expect(DECOMPOSE_PROMPT_TEMPLATE).toContain("CHANGES_SUMMARY.md");
  });
});

// ------------------------------------------------------------------------
// runPlanPhase
// ------------------------------------------------------------------------

describe("runPlanPhase", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-phases-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns empty planMd when no PLAN.md is written", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"system","session_id":"sess-abc"}\n'],
      exitCode: 0,
    });
    const result = await runPlanPhase({
      workdir: tmp,
      maxTurns: 1,
      proposal: { title: "x", summary: "y" },
      capabilitiesList: [],
      spawn: fakeSpawn,
    });
    expect(result.planMd).toBe("");
    expect(result.sessionId).toBe("sess-abc");
    expect(result.exitCode).toBe(0);
  });

  it("returns the pre-existing PLAN.md content", async () => {
    writeFileSync(path.join(tmp, "PLAN.md"), "# Plan\n\nHello.\n");
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"result"}\n'],
      exitCode: 0,
    });
    const result = await runPlanPhase({
      workdir: tmp,
      maxTurns: 1,
      proposal: { title: "x", summary: "y" },
      capabilitiesList: ["expenses"],
      spawn: fakeSpawn,
    });
    expect(result.planMd).toBe("# Plan\n\nHello.\n");
  });

  it("captures session_id from the first system event", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [
        '{"type":"system","session_id":"plan-1"}\n',
        '{"type":"system","session_id":"plan-2"}\n',
      ],
      exitCode: 0,
    });
    const result = await runPlanPhase({
      workdir: tmp,
      maxTurns: 1,
      proposal: { title: "x", summary: "y" },
      capabilitiesList: [],
      spawn: fakeSpawn,
    });
    expect(result.sessionId).toBe("plan-1");
  });

  it("forwards events to the caller's onEvent", async () => {
    const seen: string[] = [];
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [
        '{"type":"assistant","content":"hi"}\n',
        '{"type":"result"}\n',
      ],
      exitCode: 0,
    });
    await runPlanPhase({
      workdir: tmp,
      maxTurns: 1,
      proposal: { title: "x", summary: "y" },
      capabilitiesList: [],
      spawn: fakeSpawn,
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen).toEqual(["assistant", "result"]);
  });
});

// ------------------------------------------------------------------------
// runDecomposePhase
// ------------------------------------------------------------------------

describe("runDecomposePhase", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-phases-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns [] when openspec/changes/ does not exist", async () => {
    const fakeSpawn = makeFakeSpawn({ stdoutChunks: [], exitCode: 0 });
    const result = await runDecomposePhase({
      workdir: tmp,
      maxTurns: 1,
      spawn: fakeSpawn,
    });
    expect(result.changeIds).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("returns child directory names sorted; excludes archive", async () => {
    mkdirSync(path.join(tmp, "openspec", "changes", "add-foo"), { recursive: true });
    mkdirSync(path.join(tmp, "openspec", "changes", "add-bar"), { recursive: true });
    mkdirSync(path.join(tmp, "openspec", "changes", "archive"), { recursive: true });
    writeFileSync(path.join(tmp, "openspec", "changes", "stray.txt"), "");
    const fakeSpawn = makeFakeSpawn({ stdoutChunks: [], exitCode: 0 });
    const result = await runDecomposePhase({
      workdir: tmp,
      maxTurns: 1,
      spawn: fakeSpawn,
    });
    expect(result.changeIds).toEqual(["add-bar", "add-foo"]);
  });

  it("captures sessionId from system event", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"system","session_id":"decomp-1"}\n'],
      exitCode: 0,
    });
    const result = await runDecomposePhase({
      workdir: tmp,
      maxTurns: 1,
      spawn: fakeSpawn,
    });
    expect(result.sessionId).toBe("decomp-1");
  });
});
