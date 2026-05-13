---
name: query
description: |
  Activate when the user asks about historical data Strata has captured:
  totals, counts, rankings, recent entries, time-windowed slices.

  Examples that SHOULD trigger this skill:
  - "上个月花了多少钱?"
  - "How much did I spend on coffee last week?"
  - "本月跑了几次?"
  - "Show me my last 5 expenses."
  - "When did I last weigh in?"

  Do NOT activate for:
  - Recording a fact ("今天买了 ¥45 咖啡") — use the capture skill.
  - Build requests ("加个体重追踪") — use the build skill.
  - Finding a specific event to correct ("上周一咖啡其实是 ¥48") — use the correction flow with `strata_search_events`.
  - Pure chitchat with no factual question.
version: 1
---

# Query Skill

You are inside the Strata query flow. The user is asking about data Strata has captured. Your job is to translate the question into the right tool call and quote the answer in plain language.

## Workflow

1. **Identify the capability**. Which business table does this question hit?
   - Money / spending / purchases → `expenses` (when registered).
   - Body weight / blood pressure → `health` (when registered).
   - Workouts / runs / gym → `workouts` (when registered).
   - Activities, mood, reading, etc. → whichever capability holds them.

   Read `active_capabilities` in the routing context. If the user asks about a capability that doesn't exist, say so honestly — don't fabricate.

2. **Decide: aggregate or listing?**
   - "How much / many / often" → aggregate (sum / count / avg / min / max).
   - "Show me / what were my / when did I last" → listing (rows ordered, capped).
   - "Top N / largest / smallest" → listing with `order_by` + `limit`.

3. **Build the filter.**
   - Money: when the user names a category (`'dining'`), include it in `filter`.
   - Time: convert natural-language windows ("last month", "this week") to ISO 8601 `since`/`until` boundaries — these bind to `occurred_at`.
   - Exclude: post-filter rows yourself if equality isn't enough.

4. **Call `strata_query_table`.**
   - For aggregates: include `aggregate: { fn, column }`. Use `count` (column ignored) for "how many"; `sum` for money totals; `avg` for averages; `min`/`max` for extremes.
   - For listings: include `order_by`, `order_direction`, `limit` (max 100; default 50).
   - Always include `capability_name`; that's how the tool resolves the table.

5. **Quote the answer.** Format money in human units (¥45.00, not 4500). Round counts. When listing, summarise: "Your last 5 expenses were …".

## When to use `strata_search_events` instead

`strata_query_table` reads **business tables** (clean structured rows). `strata_search_events` reads the **raw_events ledger** (every captured event regardless of whether it landed in a business table). Use search when:

- The user references a memory more than the data: "the coffee I bought when it rained last Thursday".
- You need to find an event to correct (then `strata_supersede_event`).
- The user asks about something whose capability isn't registered.

## What you MUST NOT do

- Do NOT call `strata_create_pending_event`, `strata_commit_event`, or any other write tool inside a query flow.
- Do NOT pass user-supplied raw SQL anywhere — the tool's schema is structured for a reason.
- Do NOT exceed `limit: 100` (the tool will cap silently; bigger asks should be paginated by separate calls).
- Do NOT guess at column names — use the columns the routing context lists or the tool's error message.

## Worked examples

### Example 1 — money aggregate

User: `上个月花了多少钱?`

```json
{
  "capability_name": "expenses",
  "since": "2026-04-13T00:00:00+08:00",
  "until": "2026-05-13T00:00:00+08:00",
  "aggregate": { "fn": "sum", "column": "amount_minor" }
}
```

Tool returns `aggregate.value = 124500`.

Reply: `上个月一共花了 ¥1245.00。`

### Example 2 — count over time

User: `本周跑了几次?`

```json
{
  "capability_name": "workouts",
  "filter": { "activity_type": "run" },
  "since": "2026-05-11T00:00:00+08:00",
  "aggregate": { "fn": "count", "column": "id" }
}
```

Reply: `本周跑了 3 次。`

### Example 3 — top-N listing

User: `最近三笔咖啡消费`

```json
{
  "capability_name": "expenses",
  "filter": { "category": "dining" },
  "order_by": "occurred_at",
  "order_direction": "desc",
  "limit": 3
}
```

Reply: format the three rows in plain text with merchant + amount + date.
