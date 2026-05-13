## ADDED Requirements

### Requirement: `BuildProgressForwarder.onPhase(name)` emits a phase prefix line

The system SHALL extend `BuildProgressForwarder` with an `onPhase(name: string): void` method that enqueues a single line `'📍 phase: <name>'` for the next flush. Callers (the orchestrator) call this between phase transitions so the user sees clear phase boundaries alongside per-event noise.

#### Scenario: onPhase enqueues a single line

- **WHEN** `forwarder.onPhase('plan')` is called
- **THEN** the next flush sends a message that includes `'📍 phase: plan'`
