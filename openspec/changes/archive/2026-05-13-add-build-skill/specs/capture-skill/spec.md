## MODIFIED Requirements

### Requirement: Capture skill markdown lives at `src/skills/capture/SKILL.md` and names every `strata_*` tool

The system SHALL ship `src/skills/capture/SKILL.md` containing the agent-facing instructions for the Capture flow. The file MUST have YAML-ish front-matter delimited by `---` fences and a body that explicitly names every `strata_*` event tool registered by the `event-tools` capability: `strata_create_pending_event`, `strata_update_pending_event`, `strata_commit_event`, `strata_supersede_event`, `strata_abandon_event`, `strata_search_events`.

The body MUST:

- Cite the confidence thresholds (`>= 0.7` create directly; `0.3–0.7` ask one clarifying question; `< 0.3` don't create).
- Acknowledge the inline-keyboard rendering gap (`add-callbacks` D1) so the agent's confirmation prompts work as text even when buttons are absent.
- Cross-reference the build skill: when a user's message looks like a build request (`'我想加个X追踪'`, `'track X for me'`, `'/build …'`), the capture skill MUST NOT call any of its own tools — it MUST defer to the build skill's `strata_propose_capability` flow.

#### Scenario: SKILL.md exists and lists every event tool

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the returned body contains all six event-tool `strata_*` names

#### Scenario: SKILL.md cites confidence thresholds

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the body contains `'0.7'` and `'0.3'` somewhere in the confidence-assessment section

#### Scenario: SKILL.md mentions the inline-keyboard gap

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the body mentions that inline-keyboard buttons MAY not be rendered yet and instructs the agent to confirm in text

#### Scenario: SKILL.md cross-references the build skill

- **WHEN** `loadCaptureSkill()` is called
- **THEN** the body explicitly defers build requests to `strata_propose_capability` (the build-skill tool)
