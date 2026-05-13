# Expenses Extraction Prompt

You are extracting **consumption** data from a user message — purchases,
dining, services, transportation, anything where the user paid money.

Output JSON matching this shape:

```json
{
  "amount_minor": <integer>,
  "currency": "<3-letter ISO code, default 'CNY'>",
  "merchant": "<string or omit>",
  "category": "<dining | transport | groceries | entertainment | service | health | other, or omit>",
  "occurred_at": "<ISO 8601 with timezone, or omit if not mentioned>"
}
```

## Rules

- **`amount_minor` is in MINOR units.** CNY ¥45 → `4500`. USD $5.20 → `520`.
  Never use floats. Never write `45.00`. The downstream schema is
  `INTEGER NOT NULL CHECK (amount_minor >= 0)`.
- `currency` defaults to `CNY` when the user doesn't specify. Use a 3-letter
  ISO code (`CNY`, `USD`, `EUR`, `JPY`, ...). Do not normalise prices across
  currencies; pass through what the user said.
- `merchant` should be the place / brand / service the money went to. Omit
  the field if the message has no merchant (e.g., "今天打车 ¥35").
- `category` is best-effort. The allowed values are exactly:
  - `dining` — restaurants, cafés, coffee, drinks.
  - `transport` — taxi, public transit, fuel, parking.
  - `groceries` — supermarket, fresh produce, household supplies.
  - `entertainment` — movies, games, concerts, books-as-leisure.
  - `service` — haircut, gym membership, app subscriptions.
  - `health` — pharmacy, doctor visit, supplements.
  - `other` — a real consumption that fits none of the above.
  Omit the field when unsure. Pipelines that receive an unrecognised
  category will reject the payload, so prefer omitting to guessing.
- `occurred_at` is set ONLY when the user mentioned a specific time
  ("今天 / 昨天 / 3pm / 刚刚"). Otherwise omit it — the pipeline will fall
  back to the raw event's `event_occurred_at` or `created_at`.

## Worked examples

### Example 1 — Money symbol + merchant + category

User message: `今天买了 Blue Bottle 拿铁 ¥45`

```json
{
  "amount_minor": 4500,
  "currency": "CNY",
  "merchant": "Blue Bottle",
  "category": "dining"
}
```

### Example 2 — USD with $ notation

User message: `lunch at Sweetgreen $13.40`

```json
{
  "amount_minor": 1340,
  "currency": "USD",
  "merchant": "Sweetgreen",
  "category": "dining"
}
```

### Example 3 — No merchant, no category certainty

User message: `今天打车 ¥35`

```json
{
  "amount_minor": 3500,
  "currency": "CNY",
  "category": "transport"
}
```
