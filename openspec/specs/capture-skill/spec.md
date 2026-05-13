# capture-skill Specification

## Purpose

`capture-skill` ships the agent-facing Markdown that tells the LLM how to run the Capture flow: identify the `event_type`, extract structured data, assess confidence, call `strata_create_pending_event`, then handle follow-ups (`strata_update_pending_event` / `strata_commit_event` / `strata_abandon_event`) and cross-session corrections (`strata_search_events` → `strata_supersede_event`). A typed loader (`loadCaptureSkill`) parses the YAML-ish front-matter so the future skill-router (P5) can consume it programmatically; a CI test reads the file to assert it lists every `strata_*` tool and the confidence thresholds, so drift between the skill and the actual tool registry is caught at build time.

## Requirements
### Requirement: Capture skill markdown lives at `src/skills/capture/SKILL.md` and names every `strata_*` tool

The system SHALL ship `src/skills/capture/SKILL.md` containing the agent-facing instructions for the Capture flow. The file MUST have YAML-ish front-matter delimited by `---` fences and a body that explicitly names every `strata_*` tool registered by the `event-tools` capability: `strata_create_pending_event`, `strata_update_pending_event`, `strata_commit_event`, `strata_supersede_event`, `strata_abandon_event`, `strata_search_events`.

The body MUST also cite the confidence thresholds (`>= 0.7` create directly; `0.3–0.7` ask one clarifying question; `< 0.3` don't create) and acknowledge the inline-keyboard rendering gap (`add-callbacks` D1) so the agent's confirmation prompts work as text even when buttons are absent.

#### Scenario: SKILL.md exists and lists every tool

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the returned body contains all six `strata_*` tool names

#### Scenario: SKILL.md cites confidence thresholds

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the body contains `'0.7'` and `'0.3'` somewhere in the confidence-assessment section

#### Scenario: SKILL.md mentions the inline-keyboard gap

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the body mentions that inline-keyboard buttons MAY not be rendered yet and instructs the agent to confirm in text

### Requirement: `loadCaptureSkill()` parses the front-matter and returns the body

The system SHALL export `loadCaptureSkill(): Promise<{ frontmatter: CaptureSkillFrontmatter; body: string }>` that reads `./capture/SKILL.md` relative to its source file. The function MUST:

- Recognise a leading `---\n...\n---\n` front-matter block.
- Parse `key: value` pairs and a `description: |\n  multi-line` block into a typed `CaptureSkillFrontmatter` object with required fields `name` (string) and `description` (string) and optional `version` (string).
- Return the body as the text after the second `---` fence (with leading whitespace trimmed).

#### Scenario: Loads the file and returns typed front-matter

- **WHEN** `loadCaptureSkill()` is called on the shipped file
- **THEN** the result has `frontmatter.name === 'capture'`, `frontmatter.description` is a non-empty string, and `body` starts with the first content heading

