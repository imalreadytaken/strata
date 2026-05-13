/**
 * Reflect Agent — proposal generator.
 *
 * Maps `ReflectSignal[]` to `proposals` rows. Deduplicates against pending
 * rows; respects cooldown on declined rows. Emergence dedup uses
 * `evidence_event_ids` overlap; evolution/decay dedup uses
 * `(kind, target_capability)`.
 *
 * See `openspec/changes/add-reflect-proposals/specs/reflect-proposals/spec.md`.
 */
import type { Logger } from "../core/logger.js";
import type {
  ProposalRow,
  ProposalsRepository,
} from "../db/repositories/proposals.js";
import type {
  DecaySignal,
  EmergenceSignal,
  EvolutionSignal,
  ReflectSignal,
} from "./types.js";

export interface SkippedReason {
  kind: ReflectSignal["kind"];
  reason: "duplicate_pending" | "cooldown";
  identity: string;
}

export interface GenerateProposalsResult {
  inserted: ProposalRow[];
  skipped: SkippedReason[];
}

export interface GenerateProposalsDeps {
  proposalsRepo: ProposalsRepository;
  logger: Logger;
  now?: () => Date;
}

function identityFor(signal: ReflectSignal): string {
  if (signal.kind === "new_capability") {
    return [...signal.evidence_event_ids].sort((a, b) => a - b).join(",");
  }
  return signal.target_capability;
}

function parseEvidenceIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((n): n is number => typeof n === "number");
    }
  } catch {
    /* ignore */
  }
  return [];
}

function existingMatchesEmergence(
  signal: EmergenceSignal,
  existing: ProposalRow[],
): ProposalRow | undefined {
  const needle = new Set(signal.evidence_event_ids);
  for (const row of existing) {
    if (row.kind !== "new_capability") continue;
    const ids = parseEvidenceIds(row.evidence_event_ids);
    for (const id of ids) {
      if (needle.has(id)) return row;
    }
  }
  return undefined;
}

function existingMatchesTarget(
  signal: EvolutionSignal | DecaySignal,
  existing: ProposalRow[],
): ProposalRow | undefined {
  return existing.find(
    (r) => r.kind === signal.kind && r.target_capability === signal.target_capability,
  );
}

function renderTitle(signal: ReflectSignal): string {
  switch (signal.kind) {
    case "new_capability":
      return `Propose new capability: ${signal.suggested_name}`;
    case "schema_evolution":
      return `Evolve schema: ${signal.target_capability}.${signal.column}`;
    case "capability_archive":
      return `Archive stale capability: ${signal.target_capability}`;
  }
}

function renderSummary(signal: ReflectSignal): string {
  switch (signal.kind) {
    case "new_capability":
      return `${signal.evidence_event_ids.length} unbound events look like a new domain. ${signal.rationale}`;
    case "schema_evolution":
      return `${signal.target_capability}.${signal.column} = '${signal.dominant_value}' is ${Math.round(signal.ratio * 100)}% of rows.`;
    case "capability_archive":
      return `${signal.target_capability} hasn't been written for ~${Math.round(signal.days_since_last_write)}d.`;
  }
}

export async function generateProposals(
  signals: ReflectSignal[],
  deps: GenerateProposalsDeps,
): Promise<GenerateProposalsResult> {
  const log = deps.logger.child({ module: "reflect.proposal_generator" });
  const now = (deps.now ?? (() => new Date()))();

  const pendingRows = await deps.proposalsRepo.findMany({ status: "pending" });
  const declinedRows = await deps.proposalsRepo.findMany({ status: "declined" });

  const inserted: ProposalRow[] = [];
  const skipped: SkippedReason[] = [];

  for (const signal of signals) {
    const identity = identityFor(signal);

    // Dedup against pending.
    const dupPending =
      signal.kind === "new_capability"
        ? existingMatchesEmergence(signal, pendingRows)
        : existingMatchesTarget(signal, pendingRows);
    if (dupPending) {
      skipped.push({ kind: signal.kind, reason: "duplicate_pending", identity });
      continue;
    }

    // Cooldown against declined.
    const dupDeclined =
      signal.kind === "new_capability"
        ? existingMatchesEmergence(signal, declinedRows)
        : existingMatchesTarget(signal, declinedRows);
    if (dupDeclined) {
      const cooldownUntil = dupDeclined.cooldown_until;
      if (cooldownUntil && Date.parse(cooldownUntil) > now.getTime()) {
        skipped.push({ kind: signal.kind, reason: "cooldown", identity });
        continue;
      }
    }

    const target_capability =
      signal.kind === "new_capability" ? null : signal.target_capability;
    const evidenceIds =
      signal.kind === "new_capability"
        ? JSON.stringify(signal.evidence_event_ids)
        : null;

    const row = await deps.proposalsRepo.insert({
      source: "reflect_agent",
      kind: signal.kind,
      target_capability,
      title: renderTitle(signal),
      summary: renderSummary(signal),
      rationale: signal.rationale,
      proposed_design: JSON.stringify(signal),
      signal_strength: signal.signal_strength,
      evidence_event_ids: evidenceIds,
      status: "pending",
      created_at: now.toISOString(),
    });
    inserted.push(row);
    log.info("proposal generated", {
      proposal_id: row.id,
      kind: signal.kind,
      signal_strength: signal.signal_strength,
    });
  }

  return { inserted, skipped };
}

export interface ProposalCard {
  text: string;
}

export function renderProposalCard(row: ProposalRow): ProposalCard {
  const emoji = row.kind === "new_capability" ? "🌱" : row.kind === "schema_evolution" ? "🌿" : "🍂";
  const strength = row.signal_strength !== null ? ` (signal: ${row.signal_strength.toFixed(2)})` : "";
  const lines = [
    `${emoji} Strata proposal #${row.id} (${row.kind})${strength}`,
    row.title,
    row.summary,
  ];
  return { text: lines.join("\n") };
}
