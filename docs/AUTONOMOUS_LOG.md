# Autonomous work log

Used by the hourly routine `trig_01JvLxNvzWZFXZhmWTZWBSBx` (and by anyone
resuming this work). Rules: follow `docs/IMPLEMENTATION_CHECKLIST.md`
(tests first, small commits), push to `claude/spec-architecture-draft`,
no PR, never touch real hardware, never publish to npm. Record every
decision taken for the user in `docs/OPEN_QUESTIONS.md`. Stop the routine
(`update_trigger enabled=false`) when nothing is left that can be done
without the user or the real router.

## Work queue

Foundation
- [x] Shared types (`src/types.ts`), licence, decision log

Independent modules (written by parallel subagents, integrated by the lead)
- [ ] A. UsageTracker: plan periods, counter resets, thresholds (`src/usage-tracker.ts`)
- [ ] B. Publisher: path table, `meta`, radioQuality, notifications (`src/publisher.ts`, `src/paths.ts`, `src/radio-quality.ts`)
- [ ] C. RouterClient and parsers against the mock router (`src/router-client.ts`, `src/parsers.ts`)
- [ ] D. Status Tiles example set and provider (`src/tiles-provider.ts`, `status-tiles-examples.json`)
- [ ] E. SmsStore and persistent StateStore (`src/sms-store.ts`, `src/state-store.ts`)
- [ ] F. Webapp (`public/`)

Integration (lead)
- [ ] G. Config schema and validation (`src/config.ts`)
- [ ] H. Pollers with backoff and link state machine (`src/pollers.ts`)
- [ ] I. REST routes with admin checks (`src/routes.ts`)
- [ ] J. Plugin wiring and end-to-end test with mock router and fake server app
- [ ] K. Update SPEC/ARCHITECTURE to match what was built; plans in `docs/plans/`
- [ ] L. README, CHANGELOG, package metadata checks

Blocked on the user or hardware
- Real router run (Q1), server `meta` behaviour (Q2), SMS encoding (Q3)

## Log

- 2026-10-06: foundation done; subagents A-F started.
