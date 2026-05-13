/**
 * Reflect Agent — one-shot orchestrator. Composes detectors →
 * `generateProposals` → optional `pushProposalsToUser` into a single
 * call the cron + future CLI can use.
 */
import type Database from "better-sqlite3";

import type { Logger } from "../core/logger.js";
import type { CapabilityHealthRepository } from "../db/repositories/capability_health.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ProposalsRepository, ProposalRow } from "../db/repositories/proposals.js";
import type { LLMClient } from "../triage/index.js";
import { detectArchiveCandidates } from "./decay_detector.js";
import {
  detectNewCapabilityEmergence,
  detectSchemaEvolutionNeed,
} from "./emergence_detector.js";
import {
  generateProposals,
  type GenerateProposalsResult,
} from "./proposal_generator.js";
import { pushProposalsToUser, type PushDeps } from "./push.js";
import type { ProposalCard } from "./proposal_generator.js";
import type { ReflectSignal, ReflectThresholds } from "./types.js";

export interface ReflectRunDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  proposalsRepo: ProposalsRepository;
  logger: Logger;
  llmClient?: LLMClient;
  notify?: (row: ProposalRow, card: ProposalCard) => Promise<void>;
  useLLM?: boolean;
  thresholds?: Partial<ReflectThresholds>;
  now?: () => Date;
}

export interface ReflectRunResult {
  signals: ReflectSignal[];
  generated: GenerateProposalsResult;
  pushed: number;
}

export async function runReflectOnce(
  deps: ReflectRunDeps,
): Promise<ReflectRunResult> {
  const log = deps.logger.child({ module: "reflect.runner" });

  const emergenceDeps = {
    db: deps.db,
    capabilityRegistryRepo: deps.capabilityRegistryRepo,
    logger: deps.logger,
    ...(deps.llmClient ? { llmClient: deps.llmClient } : {}),
  };
  const emergenceOpts = {
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
    ...(deps.useLLM !== undefined ? { useLLM: deps.useLLM } : {}),
  };

  const emergenceSignals = await detectNewCapabilityEmergence(emergenceDeps, emergenceOpts);
  const evolutionSignals = await detectSchemaEvolutionNeed(emergenceDeps, emergenceOpts);
  const decayDeps = {
    capabilityRegistryRepo: deps.capabilityRegistryRepo,
    capabilityHealthRepo: deps.capabilityHealthRepo,
    logger: deps.logger,
  };
  const decayOpts = {
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const decaySignals = await detectArchiveCandidates(decayDeps, decayOpts);

  const signals: ReflectSignal[] = [
    ...emergenceSignals,
    ...evolutionSignals,
    ...decaySignals,
  ];
  log.info("reflect signals collected", {
    emergence: emergenceSignals.length,
    evolution: evolutionSignals.length,
    decay: decaySignals.length,
  });

  const generateDeps = {
    proposalsRepo: deps.proposalsRepo,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
  };
  const generated = await generateProposals(signals, generateDeps);

  let pushed = 0;
  if (deps.notify && generated.inserted.length > 0) {
    const pushDeps: PushDeps = {
      proposalsRepo: deps.proposalsRepo,
      notify: deps.notify,
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
    };
    await pushProposalsToUser(generated.inserted, pushDeps);
    pushed = generated.inserted.length;
  }

  return { signals, generated, pushed };
}
