/**
 * Reflect Agent — push proposals to the user.
 *
 * For each row: render an IM-friendly card, hand it to the supplied
 * `notify` callback, then stamp `pushed_to_user_at`. A `notify` rejection
 * is warn-logged and does NOT propagate; the row's `pushed_to_user_at`
 * is still stamped so operators can see we attempted delivery.
 */
import type { Logger } from "../core/logger.js";
import type {
  ProposalRow,
  ProposalsRepository,
} from "../db/repositories/proposals.js";
import { renderProposalCard, type ProposalCard } from "./proposal_generator.js";

export interface PushDeps {
  proposalsRepo: ProposalsRepository;
  notify: (row: ProposalRow, card: ProposalCard) => Promise<void>;
  logger: Logger;
  now?: () => Date;
}

export async function pushProposalsToUser(
  rows: ProposalRow[],
  deps: PushDeps,
): Promise<void> {
  const log = deps.logger.child({ module: "reflect.push" });
  const now = (deps.now ?? (() => new Date()))();
  for (const row of rows) {
    const card = renderProposalCard(row);
    try {
      await deps.notify(row, card);
    } catch (err) {
      log.warn("notify failed for proposal; row will still mark pushed_to_user_at", {
        proposal_id: row.id,
        error: (err as Error).message,
      });
    }
    try {
      await deps.proposalsRepo.update(row.id, {
        pushed_to_user_at: now.toISOString(),
      });
    } catch (err) {
      log.warn("proposalsRepo.update(pushed_to_user_at) failed", {
        proposal_id: row.id,
        error: (err as Error).message,
      });
    }
  }
}
