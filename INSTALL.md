# Installing Strata

Strata is an OpenClaw plugin. You install OpenClaw, register Strata into it, give it a channel to talk to (typically Telegram), and (optionally) point it at a real LLM. On first user message it bootstraps `~/.strata/` itself.

## Prerequisites

| Tool | Minimum | Purpose |
|---|---|---|
| **Node.js** | 22 LTS | Runtime — `verbatimModuleSyntax` + native ESM require ≥ 22 |
| **npm** | 10 | Package manager (`pnpm` / `bun` also fine) |
| **git** | any recent | Clone + commit workflow |
| **OpenClaw** | latest | Plugin host. Install per its own docs. |
| **Claude Code CLI** | latest | Required only if you want to use the Build protocol. `claude --version` should print a version. The CLI is spawned by `src/build/claude_code_runner.ts`. |
| **Telegram bot** | any | The most-tested channel. Strata in principle works on any OpenClaw channel; the SDK plumbs `channel`, `chat_id`, and `message_id` through without caring which transport. |
| **SQLite** | bundled | `better-sqlite3` ships its own; the `sqlite-vec` extension is auto-loaded. |

Optional but recommended:

| Tool | Purpose |
|---|---|
| **A pi-ai-compatible LLM** | Triage / extract / reflect quality. Without one Strata falls back to a deterministic heuristic — capture works, but routing is noticeably less smart. Set `models.fast = '<provider>/<model>'` and export the relevant key (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). |

## Step-by-step

### 1. Clone

```bash
git clone <your-fork-or-this-repo> ~/.strata-plugin
cd ~/.strata-plugin
npm install
```

Verify the install:

```bash
npm run typecheck        # tsc --noEmit
npm test                 # ~570 tests, ~5s
```

Both should pass before you touch OpenClaw.

### 2. Register with OpenClaw

OpenClaw's plugin loader expects a manifest at `openclaw.plugin.json` (already present in this repo) and an exported `register(api)` from `index.ts`. The exact registration command depends on your OpenClaw setup — typically a config entry pointing at the plugin's clone path. Refer to the OpenClaw documentation; once OpenClaw discovers the plugin it will call `register(api)` on every boot.

A successful boot log looks like:

```
{"msg":"system migrations applied","applied":["001_messages.sql",…,"008_capability_health.sql"]}
{"msg":"capability migrations applied","name":"expenses","applied":["001_init.sql"]}
{"msg":"dashboard loaded","capability":"expenses","widget_count":3}
{"msg":"llmClient backend: heuristic (config.models.fast='auto')"}
{"msg":"reflect cron started","intervalMs":3600000}
{"msg":"reextract worker started","intervalMs":30000}
{"msg":"Strata plugin registered","db_path":"~/.strata/main.db"}
```

### 3. Optional — point at a real LLM

By default Strata uses a heuristic classifier. To opt into a real LLM:

```jsonc
// ~/.strata/config.json
{
  "models": {
    "fast":  "anthropic/claude-haiku-4-5-20251001",   // triage / simple classify
    "smart": "anthropic/claude-opus-4-7",             // reflect / proposals
    "coder": "claude-code-cli"                        // build subprocess
  }
}
```

Then export the appropriate key in the shell that launches OpenClaw:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
```

**Never put API keys in `~/.strata/config.json`.** Strata's `assertNoForbiddenKeys` walks the parsed config and refuses to boot if it finds any key matching `/^(api[_-]?key|apikey|token|secret)$/i` at any depth — provider credentials must live in OpenClaw or environment, not Strata.

Supported `pi-ai` providers (from `src/llm/pi_ai_client.ts:KNOWN_PROVIDERS`):

```
amazon-bedrock, anthropic, google, google-gemini-cli, google-antigravity,
google-vertex, openai, azure-openai-responses, openai-codex, github-copilot,
xai, groq, cerebras, openrouter, vercel-ai-gateway, zai, mistral, minimax,
minimax-cn, huggingface, opencode, opencode-go, kimi-coding
```

If the provider is unknown OR the env key isn't set, Strata logs a `warn` and continues with the heuristic backend; nothing breaks.

### 4. First message

Send any message through your OpenClaw channel. Strata will:

1. Write the message to `~/.strata/main.db:messages`.
2. Triage it (`capture` / `correction` / `query` / `build_request` / `chitchat`).
3. For `capture`-classified messages, propose an extracted fact + an inline-keyboard `[✅ Confirm] [❌ Cancel]`.

A minimal first round-trip:

> 今天买了 Blue Bottle 拿铁 ¥45

→ Strata replies with the parsed expense + confirm buttons. Tap `Confirm`; row lands in `~/.strata/main.db:expenses`. Then:

> show me my expenses dashboard

→ Strata calls `strata_render_dashboard({ capability_name: 'expenses' })` and quotes the markdown back.

## Configuration reference

Strata reads `~/.strata/config.json` (JSON5 — comments allowed) at boot. Every field has a default; the entire file can be absent on first run.

```jsonc
{
  "database": { "path": "~/.strata/main.db" },
  "paths": {
    "dataDir":         "~/.strata",
    "capabilitiesDir": "~/.strata/capabilities",
    "openspecDir":     "~/.strata/openspec",
    "plansDir":        "~/.strata/plans",
    "buildsDir":       "~/.strata/builds",
    "logsDir":         "~/.strata/logs"
  },
  "logging":  { "level": "info", "toStderr": true },
  "pending":  { "timeoutMinutes": 30 },
  "models":   { "fast": "auto", "smart": "auto", "coder": "claude-code-cli" },
  "reextract": {
    "enabled": true,
    "poll_interval_seconds": 30,
    "checkpoint_every_rows": 20,
    "max_concurrent_jobs":  1
  }
}
```

`'auto'` for `models.fast` / `models.smart` keeps the heuristic fallback. `'<provider>/<modelId>'` opts in to pi-ai (see §3 above).

## Day-2 operations

### Inspect what Strata is doing

```bash
# Logs
tail -f ~/.strata/logs/plugin.log | jq .

# Live DB
sqlite3 ~/.strata/main.db
> SELECT count(*) FROM messages;
> SELECT id, source_summary, status FROM raw_events ORDER BY id DESC LIMIT 10;
> SELECT name, status, version FROM capability_registry;
> SELECT id, target_capability, phase, completed_at FROM builds ORDER BY id DESC LIMIT 5;
```

### Stop / restart Strata

OpenClaw owns the process. To unregister Strata, follow OpenClaw's plugin-disable flow. `~/.strata/` is fully durable across restarts; nothing in-memory is irreplaceable. The Build session registry and Pending buffer reload state from the DB / state file on next boot.

### Cancel a stuck build

The Build protocol can run for several minutes; if you regret a dispatch, ask the agent:

> stop build <build_id>

The agent will call `strata_stop_build({ build_id })`. The orchestrator's existing `abortIfNeeded` hook marks the row `phase='cancelled'` at the next phase boundary.

### Manually inspect a build's workspace

Every build gets a workdir at `~/.strata/builds/<session_id>/`. After a `cancelled` or `failed` build it's left in place so you can rerun Claude Code by hand if you want. After `integrated`, the workdir is preserved for audit; nothing automated touches it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Strata bootRuntime failed` on first boot | OpenClaw can't reach the plugin's `register(api)` export | Confirm `openclaw.plugin.json` discovers `index.ts` and that `npm run build` (or `tsc --noEmit`) is clean. |
| `STRATA_E_CONFIG_FORBIDDEN_KEY` | A key matching `/^(api[_-]?key|apikey|token|secret)$/i` lives in `~/.strata/config.json` | Move the secret to an environment variable. |
| `STRATA_E_CAPABILITY_INVALID` | A capability's `meta.json` or `dashboard.json` failed Zod validation | Path is logged. Run `node -e "console.log(require('json5').parse(require('fs').readFileSync('<path>','utf8')))"` to see what's wrong. |
| `llmClient backend: heuristic` even though you set `models.fast` | Provider not in `KNOWN_PROVIDERS`, OR env key missing | Check the log line — it names the provider it tried. The relevant `*_API_KEY` env var must be exported in the shell that launched OpenClaw. |
| `FOREIGN KEY constraint failed` writing a business row | The row's `raw_event_id` references a `raw_events.id` that doesn't exist (usually a misordered insert in a test seed) | Insert the parent `raw_events` row first; FK is non-deferred. |
| Reflect Agent never runs | `reflect.enabled` defaults to `true` but the cron only fires every Sunday at 03:00 (see `src/reflect/cron.ts`) | Trigger manually for a smoke test (write a small script that calls `runReflectAgent(...)` directly), or wait until Sunday. |
| Re-extraction worker silent | `reextract.enabled=false` in config, OR no `reextract_jobs` rows pending | Confirm with `SELECT count(*) FROM reextract_jobs WHERE status='pending';`. |
| Build wedged | Long-running phase is OK (plan can take several minutes); use `strata_stop_build` if it's truly stuck | Check `~/.strata/logs/plugin.log` for the most recent `phase` and `eventCount`. |
| Tests pass locally but `Strata plugin registered` is missing from logs | OpenClaw might be silently swallowing the import error | Run `node --input-type=module -e "import('./index.ts')"` to surface module-load errors. |

## Going further

- Read [`openspec/AGENTS.md`](openspec/AGENTS.md) cover-to-cover before authoring a capability by hand.
- Look at `src/capabilities/expenses/v1/` for the minimal-complete reference capability.
- Follow the OpenSpec flow for every change — `README.md` §"Development" lists the exact commands.
