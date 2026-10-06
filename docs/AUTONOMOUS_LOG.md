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
- [x] A. UsageTracker: plan periods, counter resets, thresholds (`src/usage-tracker.ts`)
- [x] B. Publisher: path table, `meta`, radioQuality, notifications (`src/publisher.ts`, `src/paths.ts`, `src/radio-quality.ts`)
- [ ] C. RouterClient and parsers against the mock router (`src/router-client.ts`, `src/parsers.ts`)
- [x] D. Status Tiles example set and provider (`src/tiles-provider.ts`, `status-tiles-examples.json`)
- [x] E. SmsStore and persistent StateStore (`src/sms-store.ts`, `src/state-store.ts`)
- [x] F. Webapp (`public/`)

Integration (lead)
- [x] G. Config schema and validation (`src/config.ts`)
- [x] H. Pollers with backoff and link state machine (`src/pollers.ts`)
- [x] I. REST routes with admin checks (`src/routes.ts`)
- [ ] J. Plugin wiring and end-to-end test with mock router and fake server app
- [ ] K. Update SPEC/ARCHITECTURE to match what was built; plans in `docs/plans/`
- [ ] L. README, CHANGELOG, package metadata checks

Blocked on the user or hardware
- Real router run (Q1), server `meta` behaviour (Q2), SMS encoding (Q3)

## Log

- 2026-10-06: foundation done; subagents A-F started.
- 2026-10-06: A, B, D, E, F, G, H, I done and committed (see git log). Agent C (RouterClient) still running when last checked. Next: integrate C, then J (plugin wiring + end-to-end test), K, L. Note for wiring: publish routerLink/sms/plan paths on every poll (tile stale times), call stateStore.flush() on stop, build SMS ids with smsId() from src/sms-id.ts, XML-escape SMS text in the client.
