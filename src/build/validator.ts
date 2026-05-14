/**
 * Build Bridge — workdir validator.
 *
 * After Claude Code's `/opsx:apply` produces files in the build workdir,
 * `runValidationChecks(ctx)` runs 9 active checks (+ 2 placeholders) over
 * the produced filesystem and returns a structured report the orchestrator
 * uses to gate integration.
 *
 * See `openspec/changes/add-build-validator/specs/build-validator/spec.md`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import JSON5 from "json5";

import { CapabilityMetaSchema } from "../capabilities/types.js";
import {
  applyMigrations,
  openDatabase,
  SYSTEM_MIGRATIONS_DIR,
} from "../db/index.js";
import { applyCapabilityMigrations } from "../capabilities/migrations.js";

export interface ValidationFinding {
  severity: "error" | "warn";
  check: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationReport {
  ok: boolean;
  findings: ValidationFinding[];
  perCheck: Record<string, ValidationFinding[]>;
}

export interface ValidationContext {
  /** Absolute path to the build workdir. */
  workdir: string;
  /** OpenSpec change id (slug used in `openspec/changes/<id>/`). */
  changeId: string;
  /** Capability name written by the build, if known. */
  capabilityName?: string;
  /** SHA from `setupBuildWorkspace` — baseline for `git diff`. */
  gitInitialCommit: string;
}

export interface ValidationCheck {
  name: string;
  description: string;
  run(ctx: ValidationContext): Promise<ValidationFinding[]>;
}

// ---------- helpers --------------------------------------------------------

function err(check: string, message: string, extras: Partial<ValidationFinding> = {}): ValidationFinding {
  return { severity: "error", check, message, ...extras };
}

function getModifiedFiles(workdir: string, sinceCommit: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", workdir, "diff", "--name-only", sinceCommit],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
    if (!out) return [];
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Find the active version dir for a capability inside the workdir. */
function capabilityVersionDir(workdir: string, name: string): string | null {
  const root = path.join(workdir, "capabilities", name);
  if (!existsSync(root)) return null;
  // current/ wins; else highest vN.
  if (existsSync(path.join(root, "current", "meta.json"))) {
    return path.join(root, "current");
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const versions: Array<{ v: number; p: string }> = [];
  for (const e of entries) {
    const m = e.match(/^v(\d+)$/);
    if (!m) continue;
    const p = path.join(root, e);
    if (existsSync(path.join(p, "meta.json"))) {
      versions.push({ v: Number.parseInt(m[1]!, 10), p });
    }
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.v - a.v);
  return versions[0]!.p;
}

interface ColumnDef {
  name: string;
  type: string;
  modifiers: string;
}

interface ParsedTable {
  name: string;
  columns: ColumnDef[];
}

/**
 * Tiny tokenizer for `CREATE TABLE <name> (...)` statements. Supports the
 * subset AGENTS.md produces: identifier columns, type words, modifiers
 * (NOT NULL, DEFAULT …, REFERENCES …, CHECK (…), PRIMARY KEY, etc.).
 * Quoted identifiers and multi-line constraints are best-effort.
 */
export function parseCreateTables(sql: string): ParsedTable[] {
  // Strip line comments + block comments.
  const cleaned = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const tables: ParsedTable[] = [];
  const re = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(([\s\S]+?)\)\s*;/gi;
  for (const m of cleaned.matchAll(re)) {
    const name = m[1]!;
    const body = m[2]!;
    const columns: ColumnDef[] = [];
    let depth = 0;
    let current = "";
    for (const ch of body) {
      if (ch === "(") {
        depth++;
        current += ch;
      } else if (ch === ")") {
        depth--;
        current += ch;
      } else if (ch === "," && depth === 0) {
        const col = parseColumn(current);
        if (col) columns.push(col);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      const col = parseColumn(current);
      if (col) columns.push(col);
    }
    tables.push({ name, columns });
  }
  return tables;
}

function parseColumn(raw: string): ColumnDef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Table-level constraints: PRIMARY KEY (...), UNIQUE (...), CHECK (...), FOREIGN KEY (...)
  if (/^(?:CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(trimmed)) {
    return null;
  }
  const m = trimmed.match(/^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+([A-Za-z]+(?:\s*\([^)]*\))?)([\s\S]*)$/);
  if (!m) return null;
  return {
    name: m[1]!,
    type: m[2]!.trim().toUpperCase(),
    modifiers: (m[3] ?? "").trim(),
  };
}

// ---------- checks --------------------------------------------------------

const REQUIRED_BUSINESS_COLUMNS = [
  "id",
  "raw_event_id",
  "extraction_version",
  "extraction_confidence",
  "occurred_at",
  "created_at",
  "updated_at",
] as const;

const MONEY_NAME_RE = /^(?:.*_minor|amount.*|price.*|balance.*|fee.*|cost.*)$/i;
const MODEL_HARDCODE_RE = /(gpt-\d|claude-\d|gemini-\d|o1-|grok-\d)/i;

const API_KEY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[a-zA-Z0-9_-]{20,}/, label: "OpenAI-style secret key" },
  { re: /anthropic_api_key\s*=\s*['"][^'"]+['"]/i, label: "hardcoded ANTHROPIC_API_KEY" },
  { re: /openai_api_key\s*=\s*['"][^'"]+['"]/i, label: "hardcoded OPENAI_API_KEY" },
  { re: /google_api_key\s*=\s*['"][^'"]+['"]/i, label: "hardcoded GOOGLE_API_KEY" },
  { re: /AIza[0-9A-Za-z_-]{35}/, label: "Google API key literal" },
];

async function readSqlMigrations(
  workdir: string,
  capabilityName: string,
): Promise<Array<{ file: string; sql: string }>> {
  const versionDir = capabilityVersionDir(workdir, capabilityName);
  if (!versionDir) return [];
  const migDir = path.join(versionDir, "migrations");
  if (!existsSync(migDir)) return [];
  const out: Array<{ file: string; sql: string }> = [];
  for (const f of readdirSync(migDir).sort()) {
    if (!f.endsWith(".sql")) continue;
    const sql = await readFile(path.join(migDir, f), "utf8");
    out.push({ file: path.join(migDir, f), sql });
  }
  return out;
}

const change_scope: ValidationCheck = {
  name: "change_scope",
  description: "Modified files lie inside the change's openspec/ subtree or capabilities/<name>/v<N>/",
  async run(ctx) {
    const modified = getModifiedFiles(ctx.workdir, ctx.gitInitialCommit);
    const findings: ValidationFinding[] = [];
    const allowedPrefixes = [
      `openspec/changes/${ctx.changeId}/`,
    ];
    if (ctx.capabilityName) {
      allowedPrefixes.push(`capabilities/${ctx.capabilityName}/`);
    }
    for (const f of modified) {
      if (!allowedPrefixes.some((p) => f.startsWith(p))) {
        findings.push(err(this.name, `file modified outside change scope: ${f}`, { file: f }));
      }
    }
    return findings;
  },
};

const required_fields_in_business_tables: ValidationCheck = {
  name: "required_fields_in_business_tables",
  description: "Every business table has the 7 mandatory columns",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const findings: ValidationFinding[] = [];
    const migrations = await readSqlMigrations(ctx.workdir, ctx.capabilityName);
    for (const { file, sql } of migrations) {
      const tables = parseCreateTables(sql);
      for (const t of tables) {
        const isBusinessTable = t.columns.some((c) => c.name === "raw_event_id");
        if (!isBusinessTable) continue;
        const colNames = new Set(t.columns.map((c) => c.name));
        for (const req of REQUIRED_BUSINESS_COLUMNS) {
          if (!colNames.has(req)) {
            findings.push(
              err(this.name, `business table '${t.name}' missing required column '${req}'`, { file }),
            );
          }
        }
      }
    }
    return findings;
  },
};

const no_float_for_money: ValidationCheck = {
  name: "no_float_for_money",
  description: "Money columns use INTEGER (minor units), never REAL/FLOAT",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const findings: ValidationFinding[] = [];
    const migrations = await readSqlMigrations(ctx.workdir, ctx.capabilityName);
    for (const { file, sql } of migrations) {
      for (const t of parseCreateTables(sql)) {
        for (const c of t.columns) {
          if (!MONEY_NAME_RE.test(c.name)) continue;
          if (!/^INTEGER\b/.test(c.type)) {
            findings.push(
              err(
                this.name,
                `money column '${t.name}.${c.name}' is '${c.type}'; must be INTEGER (minor units)`,
                { file },
              ),
            );
          }
        }
      }
    }
    return findings;
  },
};

const iso_8601_timestamps: ValidationCheck = {
  name: "iso_8601_timestamps",
  description: "Timestamp columns (ending _at) use TEXT for ISO 8601 strings",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const findings: ValidationFinding[] = [];
    const migrations = await readSqlMigrations(ctx.workdir, ctx.capabilityName);
    for (const { file, sql } of migrations) {
      for (const t of parseCreateTables(sql)) {
        for (const c of t.columns) {
          if (!c.name.endsWith("_at")) continue;
          if (!/^TEXT\b/.test(c.type)) {
            findings.push(
              err(
                this.name,
                `timestamp column '${t.name}.${c.name}' is '${c.type}'; must be TEXT for ISO 8601`,
                { file },
              ),
            );
          }
        }
      }
    }
    return findings;
  },
};

const no_api_keys: ValidationCheck = {
  name: "no_api_keys",
  description: "No hardcoded API keys in modified files",
  async run(ctx) {
    const modified = getModifiedFiles(ctx.workdir, ctx.gitInitialCommit);
    const findings: ValidationFinding[] = [];
    for (const rel of modified) {
      const full = path.join(ctx.workdir, rel);
      if (!existsSync(full)) continue;
      let content: string;
      try {
        content = await readFile(full, "utf8");
      } catch {
        continue; // binary or unreadable
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const { re, label } of API_KEY_PATTERNS) {
          if (re.test(lines[i]!)) {
            findings.push(err(this.name, `${label} in ${rel}:${i + 1}`, { file: rel, line: i + 1 }));
          }
        }
      }
    }
    return findings;
  },
};

const migration_applies_clean: ValidationCheck = {
  name: "migration_applies_clean",
  description: "System + capability migrations apply to a fresh :memory: DB",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const versionDir = capabilityVersionDir(ctx.workdir, ctx.capabilityName);
    if (!versionDir) {
      return [err(this.name, `capability dir not found for '${ctx.capabilityName}'`)];
    }
    const migDir = path.join(versionDir, "migrations");
    const db = openDatabase({ path: ":memory:", loadVec: false });
    try {
      applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
      if (existsSync(migDir)) {
        applyCapabilityMigrations(db, ctx.capabilityName, migDir);
      }
      return [];
    } catch (e) {
      return [err(this.name, `migrations failed: ${(e as Error).message}`)];
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  },
};

const meta_json_valid: ValidationCheck = {
  name: "meta_json_valid",
  description: "meta.json validates against CapabilityMetaSchema",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const versionDir = capabilityVersionDir(ctx.workdir, ctx.capabilityName);
    if (!versionDir) {
      return [err(this.name, `capability dir not found for '${ctx.capabilityName}'`)];
    }
    const file = path.join(versionDir, "meta.json");
    if (!existsSync(file)) {
      return [err(this.name, `meta.json missing at ${file}`, { file })];
    }
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      return [err(this.name, `meta.json unreadable: ${(e as Error).message}`, { file })];
    }
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (e) {
      return [err(this.name, `meta.json is not valid JSON5: ${(e as Error).message}`, { file })];
    }
    const result = CapabilityMetaSchema.safeParse(parsed);
    if (!result.success) {
      return [err(this.name, `meta.json schema mismatch: ${result.error.message}`, { file })];
    }
    return [];
  },
};

const extract_prompt_present: ValidationCheck = {
  name: "extract_prompt_present",
  description: "extract_prompt.md exists, is substantive, and references no hardcoded models",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const versionDir = capabilityVersionDir(ctx.workdir, ctx.capabilityName);
    if (!versionDir) return [];
    const file = path.join(versionDir, "extract_prompt.md");
    if (!existsSync(file)) {
      return [err(this.name, `extract_prompt.md missing at ${file}`, { file })];
    }
    const body = await readFile(file, "utf8");
    const findings: ValidationFinding[] = [];
    if (body.length < 100) {
      findings.push(err(this.name, `extract_prompt.md is ${body.length} chars; expected >= 100`, { file }));
    }
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(MODEL_HARDCODE_RE);
      if (m) {
        findings.push(
          err(this.name, `extract_prompt.md references hardcoded model '${m[1]}'`, {
            file,
            line: i + 1,
          }),
        );
      }
    }
    return findings;
  },
};

const pipeline_module_exports_ingest: ValidationCheck = {
  name: "pipeline_module_exports_ingest",
  description: "pipeline.<ext> exports an async ingest(rawEvent, deps) function",
  async run(ctx) {
    if (!ctx.capabilityName) return [];
    const versionDir = capabilityVersionDir(ctx.workdir, ctx.capabilityName);
    if (!versionDir) return [];
    // Look up owner_pipeline from meta.json (with fallback to pipeline.ts).
    const metaPath = path.join(versionDir, "meta.json");
    let ownerPipeline = "pipeline.ts";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON5.parse(await readFile(metaPath, "utf8")) as { owner_pipeline?: string };
        if (typeof meta.owner_pipeline === "string" && meta.owner_pipeline.length > 0) {
          ownerPipeline = meta.owner_pipeline;
        }
      } catch {
        // meta.json invalid — meta_json_valid check covers that.
      }
    }
    const file = path.join(versionDir, ownerPipeline);
    if (!existsSync(file)) {
      return [err(this.name, `pipeline module '${ownerPipeline}' missing`, { file })];
    }
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      if (typeof mod.ingest !== "function") {
        return [err(this.name, `${ownerPipeline} must export an async function 'ingest'`, { file })];
      }
      return [];
    } catch (e) {
      return [err(this.name, `${ownerPipeline} failed to import: ${(e as Error).message}`, { file })];
    }
  },
};

const pipeline_handles_sample: ValidationCheck = {
  name: "pipeline_handles_sample",
  description: "[placeholder] Pipeline ingests at least one sample correctly — needs LLM backend",
  async run() {
    return [];
  },
};

const tests_pass: ValidationCheck = {
  name: "tests_pass",
  description: "[placeholder] All tests in this change pass — needs workdir test runner",
  async run() {
    return [];
  },
};

export const STANDARD_VALIDATION_CHECKS: ValidationCheck[] = [
  change_scope,
  required_fields_in_business_tables,
  no_float_for_money,
  iso_8601_timestamps,
  no_api_keys,
  migration_applies_clean,
  meta_json_valid,
  extract_prompt_present,
  pipeline_module_exports_ingest,
  pipeline_handles_sample,
  tests_pass,
];

export {
  change_scope,
  required_fields_in_business_tables,
  no_float_for_money,
  iso_8601_timestamps,
  no_api_keys,
  migration_applies_clean,
  meta_json_valid,
  extract_prompt_present,
  pipeline_module_exports_ingest,
  pipeline_handles_sample,
  tests_pass,
};

export async function runValidationChecks(
  ctx: ValidationContext,
  checks: ValidationCheck[] = STANDARD_VALIDATION_CHECKS,
): Promise<ValidationReport> {
  const results = await Promise.all(
    checks.map(async (c) => ({ name: c.name, findings: await c.run(ctx) })),
  );
  const findings: ValidationFinding[] = [];
  const perCheck: Record<string, ValidationFinding[]> = {};
  for (const r of results) {
    perCheck[r.name] = r.findings;
    findings.push(...r.findings);
  }
  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings, perCheck };
}
