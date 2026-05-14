#!/usr/bin/env node
/**
 * Post-tsc asset copier.
 *
 * `tsc` only compiles .ts files. Strata's runtime reads several non-TS
 * assets resolved via `import.meta.url` (so the paths point at `dist/...`
 * once compiled):
 *
 *   - src/db/migrations/*.sql                      → system migrations
 *   - src/capabilities/<name>/v<N>/migrations/*.sql → capability migrations
 *   - src/capabilities/<name>/v<N>/meta.json        → capability meta
 *   - src/capabilities/<name>/v<N>/dashboard.json   → optional dashboard
 *   - src/capabilities/<name>/v<N>/extract_prompt.md → capability prompt
 *   - src/skills/<name>/SKILL.md                    → skill markdown
 *
 * Without this step `openclaw plugins install --link` produces a `dist/`
 * that's missing every one of those, and `bootRuntime` crashes with
 * ENOENT scandir on `dist/db/migrations`.
 *
 * The script walks `src/` once, mirrors any `.sql / .json / .md` file
 * into `dist/`, creating intermediate dirs as needed. Idempotent; safe
 * to run on every `npm run build`.
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const ASSET_EXTS = new Set([".sql", ".json", ".md"]);

let copied = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (name.endsWith(".test.ts")) continue;
    const ext = path.extname(name);
    if (!ASSET_EXTS.has(ext)) continue;
    const rel = path.relative(SRC, full);
    const target = path.join(DIST, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(full, target);
    copied += 1;
  }
}

walk(SRC);
console.log(`[copy-assets] copied ${copied} non-TS files into dist/`);
