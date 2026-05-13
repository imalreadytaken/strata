import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import { ProposalsRepository } from "../db/repositories/index.js";
import {
  generateProposals,
  renderProposalCard,
  type GenerateProposalsDeps,
} from "./proposal_generator.js";
import type {
  DecaySignal,
  EmergenceSignal,
  EvolutionSignal,
} from "./types.js";

describe("generateProposals", () => {
  let tmp: string;
  let db: Database;
  let proposalsRepo: ProposalsRepository;
  let logger: Logger;
  let deps: GenerateProposalsDeps;
  const now = new Date("2026-05-13T00:00:00Z");

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-gp-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    proposalsRepo = new ProposalsRepository(db);
    deps = { proposalsRepo, logger, now: () => now };
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const emergence: EmergenceSignal = {
    kind: "new_capability",
    suggested_name: "weight_log",
    rationale: "12 unbound events about weight",
    evidence_event_ids: [1, 2, 3, 4, 5],
    signal_strength: 0.4,
  };
  const evolution: EvolutionSignal = {
    kind: "schema_evolution",
    target_capability: "expenses",
    column: "category",
    dominant_value: "dining",
    ratio: 0.7,
    rationale: "category=dining is 70% of rows",
    signal_strength: 0.7,
  };
  const decay: DecaySignal = {
    kind: "capability_archive",
    target_capability: "old_cap",
    days_since_last_write: 120,
    days_since_last_read: 60,
    rationale: "stale",
    signal_strength: 0.67,
  };

  it("inserts one proposals row per signal kind", async () => {
    const r = await generateProposals([emergence, evolution, decay], deps);
    expect(r.inserted).toHaveLength(3);
    const byKind = Object.fromEntries(r.inserted.map((p) => [p.kind, p]));
    expect(byKind["new_capability"]?.evidence_event_ids).toBe(
      JSON.stringify([1, 2, 3, 4, 5]),
    );
    expect(byKind["schema_evolution"]?.target_capability).toBe("expenses");
    expect(byKind["capability_archive"]?.target_capability).toBe("old_cap");
    for (const row of r.inserted) {
      expect(row.source).toBe("reflect_agent");
      expect(row.status).toBe("pending");
    }
  });

  it("dedups against an existing pending evolution proposal", async () => {
    await generateProposals([evolution], deps);
    const second = await generateProposals([evolution], deps);
    expect(second.inserted).toHaveLength(0);
    expect(second.skipped[0]?.reason).toBe("duplicate_pending");
  });

  it("dedups against an existing pending decay proposal", async () => {
    await generateProposals([decay], deps);
    const second = await generateProposals([decay], deps);
    expect(second.skipped[0]?.reason).toBe("duplicate_pending");
  });

  it("emergence dedups via evidence_event_ids overlap", async () => {
    await generateProposals([emergence], deps);
    const overlap: EmergenceSignal = {
      ...emergence,
      evidence_event_ids: [5, 6, 7],
    };
    const second = await generateProposals([overlap], deps);
    expect(second.skipped[0]?.reason).toBe("duplicate_pending");
  });

  it("cooldown blocks a declined proposal with active cooldown_until", async () => {
    const future = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    await proposalsRepo.insert({
      source: "reflect_agent",
      kind: "schema_evolution",
      target_capability: "expenses",
      title: "x",
      summary: "y",
      rationale: "z",
      status: "declined",
      cooldown_until: future,
      created_at: now.toISOString(),
    });
    const r = await generateProposals([evolution], deps);
    expect(r.inserted).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe("cooldown");
  });

  it("expired cooldown allows a fresh insert", async () => {
    const past = new Date(now.getTime() - 86_400_000).toISOString();
    await proposalsRepo.insert({
      source: "reflect_agent",
      kind: "schema_evolution",
      target_capability: "expenses",
      title: "x",
      summary: "y",
      rationale: "z",
      status: "declined",
      cooldown_until: past,
      created_at: past,
    });
    const r = await generateProposals([evolution], deps);
    expect(r.inserted).toHaveLength(1);
  });

  it("renderProposalCard contains the proposal id + kind", async () => {
    const row = (await generateProposals([evolution], deps)).inserted[0]!;
    const card = renderProposalCard(row);
    expect(card.text).toContain(`#${row.id}`);
    expect(card.text).toContain("schema_evolution");
    expect(card.text.length).toBeLessThan(400);
  });
});
