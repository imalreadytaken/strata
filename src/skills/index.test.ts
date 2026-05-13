import { describe, expect, it } from "vitest";

import { loadBuildSkill, loadCaptureSkill, parseSkillFile } from "./index.js";

describe("loadCaptureSkill", () => {
  it("loads the shipped SKILL.md", async () => {
    const skill = await loadCaptureSkill();
    expect(skill.frontmatter.name).toBe("capture");
    expect(skill.frontmatter.description.length).toBeGreaterThan(0);
    expect(skill.body.length).toBeGreaterThan(100);
  });

  it("mentions every strata_* tool", async () => {
    const { body } = await loadCaptureSkill();
    const required = [
      "strata_create_pending_event",
      "strata_update_pending_event",
      "strata_commit_event",
      "strata_supersede_event",
      "strata_abandon_event",
      "strata_search_events",
    ];
    for (const name of required) {
      expect(body).toContain(name);
    }
  });

  it("cites the confidence thresholds", async () => {
    const { body } = await loadCaptureSkill();
    expect(body).toContain("0.7");
    expect(body).toContain("0.3");
  });

  it("mentions the inline-keyboard rendering gap", async () => {
    const { body } = await loadCaptureSkill();
    expect(body.toLowerCase()).toContain("inline keyboard");
  });

  it("cross-references the build skill for build requests", async () => {
    const { description } = (await loadCaptureSkill()).frontmatter;
    const { body } = await loadCaptureSkill();
    // Either the frontmatter description or the body must explicitly redirect
    // build requests to strata_propose_capability.
    const combined = `${description}\n${body}`;
    expect(combined).toContain("strata_propose_capability");
  });
});

describe("loadBuildSkill", () => {
  it("loads the shipped SKILL.md", async () => {
    const skill = await loadBuildSkill();
    expect(skill.frontmatter.name).toBe("build");
    expect(skill.frontmatter.description.length).toBeGreaterThan(0);
    expect(skill.body.length).toBeGreaterThan(100);
  });

  it("body names the build tool", async () => {
    const { body } = await loadBuildSkill();
    expect(body).toContain("strata_propose_capability");
  });

  it("body references the proposals table", async () => {
    const { body } = await loadBuildSkill();
    expect(body.toLowerCase()).toContain("proposals");
  });

  it("body forbids the agent from running a build / modifying capabilities/", async () => {
    const { body } = await loadBuildSkill();
    // Both rules must appear somewhere in the body.
    expect(body.toLowerCase()).toMatch(/do not (run|generate|modify)/i);
    expect(body).toContain("capabilities/");
  });
});

describe("parseSkillFile", () => {
  const sample = `---
name: capture
description: |
  Activate when X.
  Also when Y.
version: 1
---

# Capture

Body content.`;

  it("parses single-line and multi-line front-matter", () => {
    const { frontmatter, body } = parseSkillFile(sample);
    expect(frontmatter.name).toBe("capture");
    expect(frontmatter.description).toContain("Activate when X.");
    expect(frontmatter.description).toContain("Also when Y.");
    expect(frontmatter.version).toBe("1");
    expect(body.startsWith("# Capture")).toBe(true);
  });

  it("throws when the front-matter fence is missing", () => {
    expect(() => parseSkillFile("no front matter")).toThrow(/front-matter/);
  });

  it("throws when required keys are missing", () => {
    const broken = `---
name: capture
---

body`;
    expect(() => parseSkillFile(broken)).toThrow(/description/);
  });
});
