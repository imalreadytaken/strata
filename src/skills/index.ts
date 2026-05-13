/**
 * Skill loaders. Reads `capture/SKILL.md` and `build/SKILL.md` relative
 * to this file and parses the YAML-ish front-matter into a typed object.
 * We hand-roll the parser because the schema is small (`name` /
 * `description` / optional `version`) and we want to keep dependencies
 * minimal.
 *
 * The OpenClaw skill-router contract is not yet finalised; these loaders
 * are the seam the future router will call.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
}

/** @deprecated Prefer `SkillFrontmatter` — kept for back-compat. */
export type CaptureSkillFrontmatter = SkillFrontmatter;

export interface LoadedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SKILL_PATH = path.join(__dirname, "capture", "SKILL.md");
const BUILD_SKILL_PATH = path.join(__dirname, "build", "SKILL.md");

export async function loadCaptureSkill(): Promise<LoadedSkill> {
  const raw = await readFile(CAPTURE_SKILL_PATH, "utf8");
  return parseSkillFile(raw);
}

export async function loadBuildSkill(): Promise<LoadedSkill> {
  const raw = await readFile(BUILD_SKILL_PATH, "utf8");
  return parseSkillFile(raw);
}

/** Exported for tests; pure over its input. */
export function parseSkillFile(raw: string): LoadedSkill {
  const trimmed = raw.replace(/^﻿/, ""); // strip BOM
  if (!trimmed.startsWith("---")) {
    throw new Error("skill file is missing front-matter fence");
  }
  const afterFirst = trimmed.slice(3);
  const closeIdx = afterFirst.indexOf("\n---");
  if (closeIdx === -1) {
    throw new Error("skill file is missing closing front-matter fence");
  }
  const frontMatterText = afterFirst.slice(0, closeIdx);
  const body = afterFirst.slice(closeIdx + 4).replace(/^\s*\n/, "");
  const frontmatter = parseFrontMatter(frontMatterText);
  return { frontmatter, body };
}

/**
 * Minimal YAML-ish parser. Supports:
 *   - `key: value` (single-line)
 *   - `key: |` followed by indented continuation lines (multi-line block)
 * Anything fancier (lists, anchors, mappings) is out of scope; the skill
 * format keeps to this subset.
 */
function parseFrontMatter(text: string): SkillFrontmatter {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "";
    if (value === "|" || value === ">") {
      // Multi-line block: consume indented lines until indent shrinks back.
      const block: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.length === 0) {
          block.push("");
          i++;
          continue;
        }
        if (!/^\s/.test(next)) break;
        block.push(next.replace(/^\s{0,2}/, ""));
        i++;
      }
      out[key] = block.join("\n").trim();
    } else {
      // Trim wrapping quotes if present.
      out[key] = value.replace(/^['"]/, "").replace(/['"]$/, "").trim();
    }
  }

  if (typeof out.name !== "string" || !out.name) {
    throw new Error("skill front-matter is missing required key 'name'");
  }
  if (typeof out.description !== "string" || !out.description) {
    throw new Error("skill front-matter is missing required key 'description'");
  }
  const frontmatter: SkillFrontmatter = {
    name: out.name,
    description: out.description,
  };
  if (out.version) frontmatter.version = out.version;
  return frontmatter;
}
