/**
 * Build Bridge — stream-JSON → IM-friendly progress lines.
 *
 * `BuildProgressForwarder` accepts `StreamJsonEvent`s from the runner,
 * formats each to a single line, batches them, and calls the caller's
 * `send` once per flush. Errors in `send` are warn-logged, not propagated.
 *
 * See `openspec/changes/add-build-progress-forwarder/specs/build-progress-forwarder/spec.md`.
 */
import type { Logger } from "../core/logger.js";
import type { StreamJsonEvent } from "./claude_code_runner.js";

const DEFAULT_MAX_EVENTS_PER_BATCH = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const ASSISTANT_TEXT_CAP = 200;
const TOOL_USE_ARG_VALUE_CAP = 32;
const TOOL_USE_TOTAL_CAP = 120;
const TOOL_RESULT_CAP = 200;

// ---------- formatters ----------------------------------------------------

export function summarizeToolUse(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "unknown()";
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "tool";
  const input = obj.input;
  if (typeof input !== "object" || input === null) {
    return `${name}(${truncate(String(input ?? ""), TOOL_USE_TOTAL_CAP - name.length - 2)})`;
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    let rendered: string;
    if (typeof v === "string") {
      rendered = `${k}=${JSON.stringify(truncate(v, TOOL_USE_ARG_VALUE_CAP))}`;
    } else if (typeof v === "number" || typeof v === "boolean") {
      rendered = `${k}=${String(v)}`;
    } else {
      // Stringify object / array / null compactly.
      let s = "";
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
      rendered = `${k}=${truncate(s, TOOL_USE_ARG_VALUE_CAP)}`;
    }
    parts.push(rendered);
  }
  const args = joinWithCap(parts, ", ", TOOL_USE_TOTAL_CAP - name.length - 2);
  return `${name}(${args})`;
}

export function summarizeToolResult(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) {
    return truncate(String(raw ?? ""), TOOL_RESULT_CAP);
  }
  const obj = raw as Record<string, unknown>;
  const prefix = obj.is_error === true ? "error: " : "";
  const content = obj.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string") {
          return (c as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  } else if (content === undefined && typeof obj.error === "string") {
    text = obj.error;
  } else {
    try {
      text = JSON.stringify(content ?? obj);
    } catch {
      text = String(content);
    }
  }
  return prefix + truncate(text, TOOL_RESULT_CAP - prefix.length);
}

export function formatStreamJsonEvent(event: StreamJsonEvent): string | null {
  switch (event.type) {
    case "thinking":
      return null;
    case "system": {
      const r = event.raw as Record<string, unknown>;
      const id = (r.model ?? r.session_id ?? r.id) as string | undefined;
      return `🔧 system: ${id ?? "started"}`;
    }
    case "assistant": {
      const r = event.raw as Record<string, unknown>;
      const text = extractAssistantText(r);
      return `💬 ${truncate(text, ASSISTANT_TEXT_CAP)}`;
    }
    case "user": {
      const r = event.raw as Record<string, unknown>;
      const text = extractAssistantText(r);
      return `👤 ${truncate(text, ASSISTANT_TEXT_CAP)}`;
    }
    case "tool_use":
      return `🛠 ${summarizeToolUse(event.raw)}`;
    case "tool_result":
      return `↳ ${summarizeToolResult(event.raw)}`;
    case "result": {
      const r = event.raw as Record<string, unknown>;
      if (r.is_error === true || typeof r.error === "string") {
        const errText = typeof r.error === "string" ? r.error : "error";
        return `❌ result: ${truncate(errText, ASSISTANT_TEXT_CAP)}`;
      }
      const summary = typeof r.summary === "string"
        ? r.summary
        : typeof r.exit === "string"
          ? r.exit
          : "ok";
      return `✅ result: ${truncate(summary, ASSISTANT_TEXT_CAP)}`;
    }
    case "parse_error":
      return `⚠ parse_error: ${truncate(event.raw, 120)}`;
    case "unknown": {
      const r = event.raw;
      if (typeof r === "object" && r !== null && typeof (r as { type?: unknown }).type === "string") {
        return `· ${(r as { type: string }).type}`;
      }
      return "· unknown";
    }
    default: {
      // Exhaustive sentinel.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

function extractAssistantText(raw: Record<string, unknown>): string {
  // Claude Code's stream-json typically nests text in `message.content[].text`.
  const message = raw.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const c of message.content) {
      if (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string") {
        parts.push((c as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join(" ");
  }
  if (typeof raw.content === "string") return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((c) => {
        if (typeof c === "string") return c;
        if (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string") {
          return (c as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function truncate(s: string, cap: number): string {
  if (cap <= 1) return s.length === 0 ? "" : "…";
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1) + "…";
}

function joinWithCap(parts: string[], sep: string, cap: number): string {
  if (cap <= 1) return parts.length === 0 ? "" : "…";
  const all = parts.join(sep);
  if (all.length <= cap) return all;
  // Walk parts adding until we'd exceed cap; then append "…".
  let out = "";
  for (const p of parts) {
    const next = out.length === 0 ? p : `${out}${sep}${p}`;
    if (next.length > cap - 1) {
      if (out.length === 0) return truncate(p, cap);
      return `${out}${sep}…`;
    }
    out = next;
  }
  return out;
}

// ---------- forwarder -----------------------------------------------------

export interface BuildProgressForwarderOptions {
  send: (text: string) => Promise<void>;
  maxEventsPerBatch?: number;
  flushIntervalMs?: number;
  logger?: Logger;
}

export class BuildProgressForwarder {
  private readonly send: (text: string) => Promise<void>;
  private readonly maxEventsPerBatch: number;
  private readonly flushIntervalMs: number;
  private readonly logger: Logger | undefined;
  private queue: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: BuildProgressForwarderOptions) {
    this.send = opts.send;
    this.maxEventsPerBatch = opts.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS_PER_BATCH;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.logger = opts.logger;
  }

  onEvent(event: StreamJsonEvent): void {
    const line = formatStreamJsonEvent(event);
    if (line === null) return;
    this.queue.push(line);
  }

  /** Enqueue a phase-prefix line. Called by the orchestrator between phases. */
  onPhase(name: string): void {
    this.queue.push(`📍 phase: ${name}`);
  }

  pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.draining) return;
    if (this.queue.length === 0) return;
    this.draining = true;
    try {
      const batch = this.queue.splice(0, this.maxEventsPerBatch);
      const text = batch.join("\n");
      try {
        await this.send(text);
      } catch (err) {
        this.logger
          ?.child({ module: "build.progress_forwarder" })
          .warn("send failed; batch dropped", {
            error: (err as Error).message,
            batch_size: batch.length,
          });
      }
    } finally {
      this.draining = false;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
