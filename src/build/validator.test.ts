import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  change_scope,
  extract_prompt_present,
  iso_8601_timestamps,
  meta_json_valid,
  migration_applies_clean,
  no_api_keys,
  no_float_for_money,
  parseCreateTables,
  pipeline_handles_sample,
  pipeline_module_exports_ingest,
  required_fields_in_business_tables,
  runValidationChecks,
  STANDARD_VALIDATION_CHECKS,
  tests_pass,
  type ValidationCheck,
  type ValidationContext,
} from "./validator.js";

const VALID_META = JSON.stringify({
  name: "expenses",
  version: 1,
  description: "Track personal consumption",
  primary_table: "expenses",
});

const VALID_MIGRATION = `
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_confidence REAL,
  occurred_at TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const VALID_PIPELINE_MJS = `
export async function ingest(rawEvent, deps) {
  return { business_row_id: 1, business_table: "expenses" };
}
`;

const VALID_EXTRACT_PROMPT = `# Expenses extraction

Extract consumption data from the user's message into JSON.

Fields:
- amount_minor (integer, minor units)
- currency (3-letter ISO)
- merchant (string)

Examples coming soon. This prompt is at least 100 chars long so the validator
is satisfied — and it deliberately avoids naming any specific model.
`;

/**
 * Build a workdir with a valid expenses capability + an OpenSpec change
 * directory and a clean git history rooted on `gitInitialCommit`. Tests
 * pass through `mutate(...)` to introduce specific defects.
 */
function makeFixture(opts: {
  capabilityName?: string;
  changeId?: string;
  pipelineFileName?: string;
  pipelineBody?: string;
  metaOverride?: string;
  migrationOverride?: string;
  extractPromptOverride?: string;
  /** Additional files (relative path → content) committed at init. */
  extraInitialFiles?: Record<string, string>;
  /** Files (relative path → content) created after the initial commit. */
  postInitFiles?: Record<string, string>;
}): {
  workdir: string;
  ctx: ValidationContext;
  cleanup(): Promise<void>;
} {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "strata-validator-"));
  const capabilityName = opts.capabilityName ?? "expenses";
  const changeId = opts.changeId ?? "add-expenses-capability";

  // Layout files
  const capDir = path.join(tmp, "capabilities", capabilityName, "v1");
  mkdirSync(capDir, { recursive: true });
  writeFileSync(path.join(capDir, "meta.json"), opts.metaOverride ?? VALID_META);
  mkdirSync(path.join(capDir, "migrations"), { recursive: true });
  writeFileSync(
    path.join(capDir, "migrations", "001_init.sql"),
    opts.migrationOverride ?? VALID_MIGRATION,
  );
  const pipelineFile = opts.pipelineFileName ?? "pipeline.mjs";
  writeFileSync(
    path.join(capDir, pipelineFile),
    opts.pipelineBody ?? VALID_PIPELINE_MJS,
  );
  // Patch owner_pipeline in meta.json when needed.
  if (!opts.metaOverride && pipelineFile !== "pipeline.ts") {
    writeFileSync(
      path.join(capDir, "meta.json"),
      JSON.stringify({
        ...JSON.parse(VALID_META),
        owner_pipeline: pipelineFile,
      }),
    );
  }
  writeFileSync(
    path.join(capDir, "extract_prompt.md"),
    opts.extractPromptOverride ?? VALID_EXTRACT_PROMPT,
  );

  const changeDir = path.join(tmp, "openspec", "changes", changeId);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(path.join(changeDir, "proposal.md"), "## Why\nx\n");

  for (const [rel, body] of Object.entries(opts.extraInitialFiles ?? {})) {
    const full = path.join(tmp, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  // Git init + initial commit (this is the workspace's gitInitialCommit).
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Strata",
    GIT_AUTHOR_EMAIL: "strata@local",
    GIT_COMMITTER_NAME: "Strata",
    GIT_COMMITTER_EMAIL: "strata@local",
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git(["init", "-q"]);
  try {
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  } catch {
    /* older git */
  }
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  const sha = git(["rev-parse", "HEAD"]);

  for (const [rel, body] of Object.entries(opts.postInitFiles ?? {})) {
    const full = path.join(tmp, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  // Stage modifications so `git diff` picks them up (we don't commit them; both
  // staged and unstaged are visible via `diff <sha>`).
  git(["add", "-A"]);

  return {
    workdir: tmp,
    ctx: {
      workdir: tmp,
      changeId,
      capabilityName,
      gitInitialCommit: sha,
    },
    async cleanup() {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------------
// parseCreateTables
// ------------------------------------------------------------------------

describe("parseCreateTables", () => {
  it("extracts column names + types from a typical migration", () => {
    const tables = parseCreateTables(VALID_MIGRATION);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe("expenses");
    const cols = new Map(tables[0]!.columns.map((c) => [c.name, c.type]));
    expect(cols.get("raw_event_id")).toBe("INTEGER");
    expect(cols.get("amount_minor")).toBe("INTEGER");
    expect(cols.get("occurred_at")).toBe("TEXT");
  });

  it("ignores table-level constraints (PRIMARY KEY (...), CHECK (...))", () => {
    const sql = `
      CREATE TABLE foo (
        id INTEGER PRIMARY KEY,
        a INTEGER NOT NULL,
        b TEXT,
        PRIMARY KEY (a, b),
        CHECK (a > 0)
      );
    `;
    const tables = parseCreateTables(sql);
    expect(tables[0]?.columns.map((c) => c.name)).toEqual(["id", "a", "b"]);
  });

  it("returns [] for SQL without CREATE TABLE", () => {
    expect(parseCreateTables("INSERT INTO foo VALUES (1);")).toEqual([]);
  });
});

// ------------------------------------------------------------------------
// Individual checks
// ------------------------------------------------------------------------

async function runCheck(
  check: ValidationCheck,
  ctx: ValidationContext,
): Promise<ReturnType<typeof check.run>> {
  return check.run(ctx);
}

describe("change_scope", () => {
  it("passes when modifications lie inside the change + capability dirs", async () => {
    const f = makeFixture({
      postInitFiles: {
        "openspec/changes/add-expenses-capability/design.md": "extra",
        "capabilities/expenses/v1/dashboard.json": "{}",
      },
    });
    try {
      const findings = await runCheck(change_scope, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags files outside the change + capability dirs", async () => {
    const f = makeFixture({
      postInitFiles: { "src/random.ts": "// outside scope" },
    });
    try {
      const findings = await runCheck(change_scope, f.ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.file).toBe("src/random.ts");
    } finally {
      await f.cleanup();
    }
  });
});

describe("required_fields_in_business_tables", () => {
  it("passes when every required column is present", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(required_fields_in_business_tables, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags missing required columns one finding at a time", async () => {
    const broken = `
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY,
        raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `;
    const f = makeFixture({ migrationOverride: broken });
    try {
      const findings = await runCheck(required_fields_in_business_tables, f.ctx);
      // Missing: extraction_version, extraction_confidence, updated_at.
      const missing = findings
        .map((x) => x.message.match(/missing required column '(\w+)'/)?.[1])
        .filter(Boolean) as string[];
      expect(new Set(missing)).toEqual(
        new Set(["extraction_version", "extraction_confidence", "updated_at"]),
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("no_float_for_money", () => {
  it("passes when money columns are INTEGER", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(no_float_for_money, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags amount_minor declared as REAL", async () => {
    const broken = VALID_MIGRATION.replace(
      "amount_minor INTEGER NOT NULL",
      "amount_minor REAL NOT NULL",
    );
    const f = makeFixture({ migrationOverride: broken });
    try {
      const findings = await runCheck(no_float_for_money, f.ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("amount_minor");
      expect(findings[0]?.message).toContain("REAL");
    } finally {
      await f.cleanup();
    }
  });
});

describe("iso_8601_timestamps", () => {
  it("passes when *_at columns are TEXT", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(iso_8601_timestamps, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags created_at as INTEGER", async () => {
    const broken = VALID_MIGRATION.replace(
      "created_at TEXT NOT NULL",
      "created_at INTEGER NOT NULL",
    );
    const f = makeFixture({ migrationOverride: broken });
    try {
      const findings = await runCheck(iso_8601_timestamps, f.ctx);
      expect(findings.some((x) => x.message.includes("created_at"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});

describe("no_api_keys", () => {
  it("passes when no API keys are present", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(no_api_keys, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags an sk-… literal", async () => {
    const f = makeFixture({
      postInitFiles: {
        "capabilities/expenses/v1/leak.txt":
          "const key = 'sk-abcdef0123456789abcdef0123456789';",
      },
    });
    try {
      const findings = await runCheck(no_api_keys, f.ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.file).toContain("leak.txt");
    } finally {
      await f.cleanup();
    }
  });
});

describe("migration_applies_clean", () => {
  it("passes when the migration applies cleanly", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(migration_applies_clean, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags a syntactically broken migration", async () => {
    const f = makeFixture({
      migrationOverride: "CREATE TABLE not_valid (",
    });
    try {
      const findings = await runCheck(migration_applies_clean, f.ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("error");
    } finally {
      await f.cleanup();
    }
  });
});

describe("meta_json_valid", () => {
  it("passes for a conforming meta.json", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(meta_json_valid, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags a meta.json missing primary_table", async () => {
    const f = makeFixture({
      metaOverride: JSON.stringify({
        name: "expenses",
        version: 1,
        description: "x",
      }),
    });
    try {
      const findings = await runCheck(meta_json_valid, f.ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message.toLowerCase()).toContain("schema");
    } finally {
      await f.cleanup();
    }
  });
});

describe("extract_prompt_present", () => {
  it("passes for a substantive prompt without hardcoded models", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(extract_prompt_present, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags a prompt mentioning claude-3-5-sonnet", async () => {
    const f = makeFixture({
      extractPromptOverride: VALID_EXTRACT_PROMPT + "\nUse claude-3-5-sonnet-20241022.",
    });
    try {
      const findings = await runCheck(extract_prompt_present, f.ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.message.toLowerCase()).toContain("hardcoded model");
    } finally {
      await f.cleanup();
    }
  });

  it("flags a prompt under 100 chars", async () => {
    const f = makeFixture({ extractPromptOverride: "Hi." });
    try {
      const findings = await runCheck(extract_prompt_present, f.ctx);
      expect(findings.some((x) => x.message.includes("chars"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});

describe("pipeline_module_exports_ingest", () => {
  it("passes for a module exporting an async ingest", async () => {
    const f = makeFixture({});
    try {
      const findings = await runCheck(pipeline_module_exports_ingest, f.ctx);
      expect(findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("flags a module without ingest", async () => {
    const f = makeFixture({
      pipelineBody: "export const hello = 1;\n",
    });
    try {
      const findings = await runCheck(pipeline_module_exports_ingest, f.ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("ingest");
    } finally {
      await f.cleanup();
    }
  });
});

// ------------------------------------------------------------------------
// Placeholders
// ------------------------------------------------------------------------

describe("placeholder checks", () => {
  it("pipeline_handles_sample returns [] and is flagged in description", async () => {
    const f = makeFixture({});
    try {
      expect(await pipeline_handles_sample.run(f.ctx)).toEqual([]);
      expect(pipeline_handles_sample.description.toLowerCase()).toContain("placeholder");
    } finally {
      await f.cleanup();
    }
  });

  it("tests_pass returns [] and is flagged in description", async () => {
    const f = makeFixture({});
    try {
      expect(await tests_pass.run(f.ctx)).toEqual([]);
      expect(tests_pass.description.toLowerCase()).toContain("placeholder");
    } finally {
      await f.cleanup();
    }
  });
});

// ------------------------------------------------------------------------
// Aggregator
// ------------------------------------------------------------------------

describe("runValidationChecks", () => {
  it("returns ok=true and empty findings when all standard checks pass", async () => {
    const f = makeFixture({});
    try {
      const report = await runValidationChecks(f.ctx);
      expect(report.ok).toBe(true);
      expect(report.findings).toEqual([]);
      for (const c of STANDARD_VALIDATION_CHECKS) {
        expect(report.perCheck[c.name]).toEqual([]);
      }
    } finally {
      await f.cleanup();
    }
  });

  it("returns ok=false when any check produces an error finding", async () => {
    const f = makeFixture({
      migrationOverride: VALID_MIGRATION.replace(
        "amount_minor INTEGER NOT NULL",
        "amount_minor REAL NOT NULL",
      ),
    });
    try {
      const report = await runValidationChecks(f.ctx);
      expect(report.ok).toBe(false);
      expect(report.findings.some((x) => x.check === "no_float_for_money")).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps ok=true when only warn-severity findings exist", async () => {
    const onlyWarn: ValidationCheck = {
      name: "warn_only",
      description: "x",
      async run() {
        return [{ severity: "warn", check: "warn_only", message: "just a warning" }];
      },
    };
    const f = makeFixture({});
    try {
      const report = await runValidationChecks(f.ctx, [onlyWarn]);
      expect(report.ok).toBe(true);
      expect(report.findings).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
});
