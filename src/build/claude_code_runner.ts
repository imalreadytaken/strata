/**
 * Build Bridge — Claude Code subprocess runner.
 *
 * Spawns the `claude` CLI with `--output-format stream-json`, parses each
 * line into a typed `StreamJsonEvent`, forwards events to `opts.onEvent`,
 * and resolves with `{ exitCode, eventCount, stderr }` when the process
 * exits.
 *
 * The parser is pure — caller-injectable `spawn` lets every test run
 * without `claude` actually being installed.
 *
 * See `openspec/changes/add-claude-code-runner/specs/claude-code-runner/spec.md`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const ALLOWED_TOOLS = "Read,Write,Edit,Bash,Glob,Grep,TodoWrite";
const DENY_TOOLS = "WebFetch,WebSearch";
const DEFAULT_KILL_GRACE_MS = 5000;

const KNOWN_TYPES = new Set([
  "assistant",
  "user",
  "tool_use",
  "tool_result",
  "thinking",
  "system",
  "result",
]);

export type StreamJsonEvent =
  | { type: "assistant"; raw: Record<string, unknown> }
  | { type: "user"; raw: Record<string, unknown> }
  | { type: "tool_use"; raw: Record<string, unknown> }
  | { type: "tool_result"; raw: Record<string, unknown> }
  | { type: "thinking"; raw: Record<string, unknown> }
  | { type: "system"; raw: Record<string, unknown> }
  | { type: "result"; raw: Record<string, unknown> }
  | { type: "parse_error"; raw: string; error: string }
  | { type: "unknown"; raw: unknown };

export type RunMode = "explore" | "apply" | "propose";

export interface RunClaudeCodeOptions {
  workdir: string;
  prompt: string;
  mode: RunMode;
  maxTurns: number;
  resumeSessionId?: string;
  onEvent: (event: StreamJsonEvent) => void;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Injectable spawn — defaults to node:child_process.spawn. */
  spawn?: typeof nodeSpawn;
}

export interface RunClaudeCodeResult {
  exitCode: number;
  eventCount: number;
  stderr: string;
}

export interface RunHandle {
  /** Process id when known. May be undefined for fake spawners. */
  pid: number | undefined;
  result: Promise<RunClaudeCodeResult>;
  /**
   * Internal: the underlying child process. Exposed so `abortRunClaudeCode`
   * can send signals without consumers reaching into private state.
   */
  child: ChildProcessWithoutNullStreams;
}

/**
 * Pure stream-json parser. Splits `leftover + chunk` on newline; partial
 * lines roll into the returned `leftover`. Empty lines are skipped;
 * malformed lines surface as `parse_error` events rather than throwing.
 */
export function parseStreamJsonLines(
  chunk: string,
  leftover: string,
): { events: StreamJsonEvent[]; leftover: string } {
  const combined = leftover + chunk;
  const parts = combined.split("\n");
  const nextLeftover = parts.pop() ?? "";
  const events: StreamJsonEvent[] = [];
  for (const part of parts) {
    const trimmed = part.replace(/\r$/, "");
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      events.push({
        type: "parse_error",
        raw: trimmed,
        error: (err as Error).message,
      });
      continue;
    }
    events.push(classify(parsed));
  }
  return { events, leftover: nextLeftover };
}

function classify(parsed: unknown): StreamJsonEvent {
  if (typeof parsed !== "object" || parsed === null) {
    return { type: "unknown", raw: parsed };
  }
  const obj = parsed as Record<string, unknown>;
  const t = typeof obj.type === "string" ? obj.type : "";
  if (KNOWN_TYPES.has(t)) {
    return { type: t as Exclude<StreamJsonEvent["type"], "parse_error" | "unknown">, raw: obj };
  }
  return { type: "unknown", raw: parsed };
}

/**
 * Spawn `claude` and route its stream-json output through `onEvent`.
 *
 * Synchronously validates `workdir`. Returns a `RunHandle` immediately so
 * the caller can both `await handle.result` and `abortRunClaudeCode(handle)`.
 */
export function runClaudeCode(opts: RunClaudeCodeOptions): RunHandle {
  if (!opts.workdir) {
    throw new Error("runClaudeCode: workdir is required");
  }
  if (!existsSync(opts.workdir) || !statSync(opts.workdir).isDirectory()) {
    throw new Error(`runClaudeCode: workdir '${opts.workdir}' does not exist`);
  }

  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--max-turns",
    String(opts.maxTurns),
    "--allowed-tools",
    ALLOWED_TOOLS,
    "--deny-tools",
    DENY_TOOLS,
    "--dangerously-skip-permissions",
  ];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn("claude", args, {
    cwd: opts.workdir,
    env: { ...process.env, ...opts.env },
  }) as ChildProcessWithoutNullStreams;

  let leftover = "";
  let eventCount = 0;
  let stderr = "";

  child.stdout.setEncoding?.("utf8");
  child.stdout.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const { events, leftover: next } = parseStreamJsonLines(text, leftover);
    leftover = next;
    for (const event of events) {
      eventCount++;
      try {
        opts.onEvent(event);
      } catch {
        // Consumer error in onEvent shouldn't bring down the runner.
        // Counted, but not propagated.
      }
    }
  });

  child.stderr.setEncoding?.("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  const result = new Promise<RunClaudeCodeResult>((resolve, reject) => {
    const onExit = (code: number | null) => {
      // Flush any remaining buffered line as a parse_error so consumers
      // don't silently lose trailing data.
      if (leftover.trim().length > 0) {
        try {
          opts.onEvent(classifyOrParseError(leftover));
          eventCount++;
        } catch {
          /* ignore */
        }
      }
      resolve({ exitCode: code ?? -1, eventCount, stderr });
    };
    child.once("exit", onExit);
    child.once("error", (err) => {
      reject(err);
    });
    if (opts.signal) {
      if (opts.signal.aborted) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      } else {
        opts.signal.addEventListener(
          "abort",
          () => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          },
          { once: true },
        );
      }
    }
  });

  return { pid: child.pid, result, child };
}

function classifyOrParseError(line: string): StreamJsonEvent {
  try {
    return classify(JSON.parse(line));
  } catch (err) {
    return { type: "parse_error", raw: line, error: (err as Error).message };
  }
}

/**
 * Abort a running Claude Code subprocess. Sends `SIGTERM`, then escalates
 * to `SIGKILL` after `opts.graceMs` (default 5000) if the process hasn't
 * exited.
 */
export async function abortRunClaudeCode(
  handle: RunHandle,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  try {
    handle.child.kill("SIGTERM");
  } catch {
    return; // already exited
  }
  if (graceMs > 0) {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      handle.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exited) return;
  }
  try {
    handle.child.kill("SIGKILL");
  } catch {
    /* already exited between checks — fine */
  }
  await new Promise<void>((resolve) => {
    if (handle.child.exitCode !== null) return resolve();
    handle.child.once("exit", () => resolve());
  });
}
