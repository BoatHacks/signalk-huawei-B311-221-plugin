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
| D6 | Plan size unit | Decimal GB (1 GB = 1,000,000,000 bytes) | How carriers quote plans | `GB` in `src/config.ts` |
| D7 | Poll interval limits | Clamped to minimums of 5 s (signal), 30 s (traffic, SMS); non-numbers fall back to 10/60/60 s | Protects the router's small web server | `src/config.ts` |
| D8 | Backoff when the router is unreachable | Probe with the signal poll at 2x, 4x, ... the signal interval, capped at 5 min; rejected credentials stop polling until the plugin is restarted | No login retry loops (lockout error 108007) | `src/pollers.ts` |
| D9 | Plan period boundaries | UTC midnight on the reset day, clamped to the month length (31 in February = 28th/29th) | Vessel timezone is unknown | `src/usage-tracker.ts` |
| D10 | Plan usage accounting | Upload and download compared separately with the last sample; a counter that drops counts its new value as usage; first sample is only a baseline; a reset hidden by downtime is undetectable and under-counts; level hysteresis of 2 percentage points | Robust against router reboots | `src/usage-tracker.ts` |
| D11 | Signal zones (server-raised notifications and the tile) | RSRP normal >= -105 dBm, warn -115..-105, alarm < -115; SINR normal >= 5 dB, warn 0..5, alarm < 0 | Conservative; avoids notification noise | `src/paths.ts` (a test keeps the tile in sync) |
| D12 | radioQuality anchors | RSRP -120..-80 dBm, SINR 0..20 dB, lower of the two | See ARCHITECTURE §3.1 | `src/radio-quality.ts` |
| D13 | Values when the router goes away | Not nulled (stale timestamps are the signal), except the operator name, which becomes null when unregistered | A stale operator name would be false | `src/publisher.ts` |
| D14 | Notification states | plan: as computed; link unreachable = warn, auth-failed = alarm; service: no service = alarm, roaming = warn; new SMS = alert. Methods: visual for alert/warn, visual+sound for alarm | Reasonable defaults | `src/publisher.ts` |
| D15 | SMS notification text | "SMS from <peer>: <text>", peer cut to 32 and text to 80 characters, control characters stripped | Untrusted text | `src/publisher.ts`, `src/sms-store.ts` |
| D16 | Status Tiles set | Unread SMS = `opportunity`, router link `connecting` = neutral, stale after 30 s (signal), 120 s (connection), 300 s (plan, link, SMS); inline zones copied from D11 | Guesses within the tile semantics | `status-tiles-examples.json` |
| D17 | SMS: first run | First ingest with no saved state marks existing messages as seen without notifying; outgoing messages never count as new; a deleted message stays in the seen list | Avoids a notification storm | `src/sms-store.ts` |
| D18 | Saved state files | Corrupt or wrong-version files are moved aside as `*.corrupt-<time>` and ignored; writes coalesced to at most one per 5 s per file; no migration yet | Never block start-up on bad state | `src/state-store.ts` |
| D19 | Who may use the REST routes | Reads need a logged-in user (`router.access("readonly")`); writes get no `access()` call, so the Signal K server makes them admin-only, and each write handler also checks admin itself. With server security switched off there is no admin concept, so everyone is allowed, as everywhere else on such a server | The server documents plain routes as admin-only; mirrors its own model | `src/routes.ts` |
| D20 | SMS send limits | At most 5 sends per minute in total, text up to 500 characters, request body up to 8 KB, router failures shown as a generic message | Sending costs money and can message anyone | `src/routes.ts` |
| D21 | Webapp behaviour | Decimal data units; values go to a dash when the link is not ok or data is older than 60 s; status polled every 10 s, SMS and day/night every 30 s, paused while the tab is hidden; confirm() before plan reset and SMS delete; write controls hidden after the first 403 | Matches Status Tiles' "unknown, never green" | `public/` |
| D22 | SMS text encoding on send | 7-bit (`Reserved=1`) only if every character is in the GSM 03.38 basic set, otherwise UCS2 (`Reserved=0`); `Length` in UTF-16 code units; unverified on a real router | Safe default; euro sign and `[ ] { } \\ ^ ~ |` go out as UCS2 | `src/router-client.ts` |
| D23 | Send result | Completion is read from `sms/send-status`; "accepted but no final answer in 30 s" is reported as `unknown`, not failure; the status field names are guesses | Avoids claiming failure for a message that may have gone out | `src/router-client.ts` |
| D24 | Router dates | Router timestamps carry no timezone and are read as the Signal K server's local time, then stored as ISO UTC. SMS ids hash the raw router date so they survive a timezone change | Avoids duplicate "new" messages after a timezone change | `src/parsers.ts`, `src/sms-id.ts` |
| D25 | Unread and connected flags | SMS unread when `Smstat` is 0, read otherwise (missing counts as read); connected when `ConnectionStatus` is 901; service available from the first evidence among `ServiceStatus === 2`, a non-zero network type, or connected/bars | Reference-library conventions; guesses until captured | `src/parsers.ts` |
| D26 | Auth failure | A rejected login latches `AuthFailed`: no further network traffic until the config changes and a new client is built; a 100002 on `state-login` means "no login needed" | Never retry a rejected login (lockout) | `src/router-client.ts` |
| D27 | Where uptime and network type come from | Uptime only from an `uptime` field in `monitoring/status` (probably absent, so `networking.modem.uptime` may stay empty); network type probably empty until the `device/signal` field name is known | No extra request for a guess | `src/parsers.ts` |

## Open questions (need you or the hardware)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Real router responses: field names, login mode, timings | Run `scripts/capture-fixtures.mjs` on the boat network (see `scripts/README.md`) | Pinning parsers, fixtures |
| Q2 | Does your Signal K server accept `zones` / `displayScale` in delta `meta` and raise the zone notifications? | Try the plugin on a server once available | SPEC §13.2 |
| Q3 | SMS encoding for non-ASCII text, behaviour with concurrent sessions | Test with the real router | SPEC §13.3 |
| Q4 | Does the router list the whole SMS inbox in one page? The SMS cache is replaced from each poll, so a partial page would drop messages from other pages | Verify with a real inbox of more than 5 messages | `src/sms-store.ts` cache |
| Q5 | Are the tile stale times (D16) right for the real polling rates? Router link, plan and SMS paths must be re-emitted at least every 5 minutes | Publish these paths on every poll, not only on change | Tile accuracy |
| Q6 | Are the send limits (D20) right for you, and should sending also work when server security is disabled (D19)? | Keep as is; turn on Signal K security if the boat network is shared | `src/routes.ts` |
| Q7 | The webapp's phone layout clips the last SMS in the list box, and has no tabs | Fine for now; refine after seeing real use | `public/lib/styles.js` |
| Q8 | What is "laserbrain timetracking" and where should token and time numbers go? I found no tool, skill or file by that name. | Keep `docs/TIME_AND_TOKENS.md` as the source of truth until you tell me the target and format; then export from it | Time and token reporting |
| Q9 | Is the router's date really server-local time with no timezone, and does `CurrentConnectTime` (traffic statistics) give connection uptime? | Check in the first real capture | `src/parsers.ts`, `networking.modem.uptime` |
