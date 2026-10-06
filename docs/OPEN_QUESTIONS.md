# Decisions made on your behalf, and open questions

While you are away, work continues on the recommended option for anything
that needs a decision. Each such decision is listed here so you can
revise it later. Change the "Chosen" column, tell me, and the affected
code and docs get updated.

## Decisions taken (revisit freely)

| ID | Question | Chosen | Why | Revise by |
|---|---|---|---|---|
| D1 | Licence and package name | MIT, unscoped `signalk-huawei-b311-221` | You picked the recommended option | Edit `LICENSE`, `package.json` |
| D2 | Copyright holder in LICENSE | "BoatHacks contributors" | Neutral default | Edit `LICENSE` |
| D3 | Git flow | Commit to `claude/spec-architecture-draft`, no PR | You picked the recommended option | Open a PR when ready |
| D4 | XML parsing | Dependency `fast-xml-parser` | Router speaks XML; avoid hand-rolled parsing (ARCHITECTURE §4) | Replace in `src/router-client.ts` |
| D5 | Which router counters feed plan tracking | The "Total" upload/download counters of `monitoring/traffic-statistics` | Cumulative, so deltas are meaningful; unverified until a real capture | `src/parsers.ts` |

## Open questions (need you or the hardware)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Real router responses: field names, login mode, timings | Run `scripts/capture-fixtures.mjs` on the boat network (see `scripts/README.md`) | Pinning parsers, fixtures |
| Q2 | Does your Signal K server accept `zones` / `displayScale` in delta `meta` and raise the zone notifications? | Try the plugin on a server once available | SPEC §13.2 |
| Q3 | SMS encoding for non-ASCII text, behaviour with concurrent sessions | Test with the real router | SPEC §13.3 |
