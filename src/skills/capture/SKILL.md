---
name: capture
description: |
  Activate when the user shares structured factual data about their life:
  consumption, exercise, mood, reading, purchases, health metrics, asset
  snapshots, or any other discrete fact worth persisting.

  Examples that SHOULD trigger this skill:
  - "今天买了 Blue Bottle 拿铁 ¥45"
  - "跑了 5km，用时 32 分钟"
  - "心情有点低落"
  - "刚读完《沉默的巡游》"
  - "体重 72.4kg"

  Do NOT activate for:
  - Questions about historical data (use a query skill)
  - Build requests ("我想加个 X 追踪", "track X for me") — these go to the **build skill**, which calls `strata_propose_capability` to record the request in the `proposals` ledger. Do NOT call `strata_create_pending_event` for build requests.
  - Corrections of previously-recorded facts (use `strata_search_events` + `strata_supersede_event`)
  - Pure chitchat with no factual content
version: 1
---

# Capture Skill

You are inside the Strata capture flow. The user has shared a structured fact and Strata wants to persist it as a `raw_event` ledger row that the user can confirm, edit, or reject.

## Workflow

When the user shares life data:

1. **Identify the `event_type`.**
   - `consumption` — purchases, dining, services with a money component.
   - `workout` — exercise sessions (running, cycling, gym, etc.).
   - `mood` — emotional state observations.
   - `reading` — books, articles, papers consumed.
   - `health` — body metrics (weight, blood pressure, sleep duration, etc.).
   - `asset` — snapshots of accounts, holdings, or other quantitative status.
   - `relation` — facts about people in the user's life.
   - `unclassified` — clearly a fact, but no matching kind. The Reflect agent may later propose a new capability for clusters of `unclassified` events.

2. **Check if the `event_type` matches an existing capability.**
   - Strata injects the list of active capabilities into your context. If one matches the kind, set `capability_name` accordingly. If not, omit it — the Reflect agent will surface a proposal later.

3. **Extract structured data.** A typical shape per kind:
   - `consumption`: `{ amount_minor: integer, currency: 'CNY', merchant: string, items?: string[], occurred_at?: ISO 8601 }`. Money is INTEGER minor units (¥45 → `4500`); never use floats.
   - `workout`: `{ activity_type: 'run' | 'cycle' | 'gym' | ..., duration_minutes: number, distance_km?: number, intensity?: 1–5 }`.
   - `mood`: `{ valence: -1..1, arousal?: -1..1, label?: string, note?: string }`.
   - `reading`: `{ title: string, author?: string, status: 'started' | 'finished', pages_read?: number }`.
   - `health`: `{ metric: 'weight' | 'blood_pressure' | ..., value: number, unit: string }`.
   - Always extract `event_occurred_at` if the user mentioned a specific time ("today / 昨天 / 3pm / 刚刚"). Default to omitting the field so the row records "as of now".

4. **Confidence assessment.** Score how clearly the extraction is grounded in the user's message:
   - **≥ 0.7** — Clear, complete, unambiguous. Call `strata_create_pending_event` with this confidence.
   - **0.3–0.7** — Ambiguous. Ask the user **one** clarifying question first, then call `strata_create_pending_event` once their reply lands.
   - **< 0.3** — Too vague to extract reliably. Don't create an event; just acknowledge the message conversationally. (The spec's exact rule: "we'd rather miss a record than fabricate one.")

5. **Call `strata_create_pending_event`.**
   - The tool returns `{ event_id, status: 'awaiting_confirmation', summary }`.
   - Ask the user to confirm in plain text: "记一下吗？" / "Want me to log this?".
   - **Note on inline keyboards.** Strata has a `callbacks` capability that handles `✅ 记录` / `✏️ 调整` / `❌ 不记` buttons under the `strata` namespace, but the path for *sending* those buttons from a tool is not wired in the SDK yet. Always include a plain-text confirmation prompt — the user's `yes/OK/记一下` reply will hit `strata_commit_event` via this same skill, and the user's `不记/no/cancel` reply will hit `strata_abandon_event`.

## Handling follow-up

When the user follows up about a recently created pending event (check `pending_event_summaries` in the Strata-injected context for the current session):

- **Adding info** ("还有冰美式 ¥20") → call `strata_update_pending_event` with a `patch` containing the new fields and the follow-up message id as `related_message_id`.
- **Correcting** ("不对，是 ¥48 不是 ¥45") → call `strata_update_pending_event` with the new value in `patch`. If the user volunteers a new summary, pass `new_summary` too.
- **Confirming** ("OK", "记一下", "yes") → call `strata_commit_event` with `event_id`. (Inline-keyboard taps reach the same code path through the `callbacks` capability.)
- **Cancelling** ("算了", "不记", "no") → call `strata_abandon_event` with `event_id` and an optional `reason`.

## Cross-session corrections

When the user in a new session refers to a previously-recorded fact and corrects it ("上周一咖啡其实是 ¥48"):

1. Call `strata_search_events` with `query` (text), `event_type` (if you can infer one), and a time-range filter (`since`/`until`) to find the right row.
2. Confirm with the user which row they meant before mutating.
3. Call `strata_supersede_event` with the old `event_id`, the new structured data, the new summary, and the correction-message id. The old row is preserved with `status='superseded'`; the new row links back via `supersedes_event_id` so the audit trail stays intact.

## Reminders

- Confidence thresholds: `0.7` create-now, `0.3` create-after-clarification, anything lower just acknowledge.
- Time always lands as ISO 8601 with timezone.
- Money always lands as INTEGER minor units.
- Booleans are `0` / `1` integers in SQLite — but the tool's `extracted_data` field is plain JSON, so use `true` / `false` here and trust the capability pipeline to convert.
- The full state machine is `pending → committed | superseded | abandoned`. You can only `commit` / `abandon` / `update` rows that are `pending`; for committed rows the only mutation is `supersede`.
