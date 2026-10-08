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
| D22 | SMS text encoding on send | 7-bit (`Reserved=1`) only if every character is in the GSM 03.38 basic set, otherwise UCS2 (`Reserved=0`); `Length` in UTF-16 code units; verified on a real B311-221 on 2026-10-08: an ASCII message went out as 7-bit and "Grüße, 5 €" as UCS2, both arrived intact | Safe default; euro sign and `[ ] { } \\ ^ ~ |` go out as UCS2 | `src/router-client.ts` |
| D23 | Send result | Completion is read from `sms/send-status`; "accepted but no final answer in 30 s" is reported as `unknown`, not failure; the status field names are guesses | Avoids claiming failure for a message that may have gone out | `src/router-client.ts` |
| D24 | Router dates | Router timestamps carry no timezone and are read as the Signal K server's local time, then stored as ISO UTC. SMS ids hash the raw router date so they survive a timezone change | Avoids duplicate "new" messages after a timezone change | `src/parsers.ts`, `src/sms-id.ts` |
| D25 | Unread and connected flags | SMS unread when `Smstat` is 0, read otherwise (missing counts as read); connected when `ConnectionStatus` is 901; service available from the first evidence among `ServiceStatus === 2`, a non-zero network type, or connected/bars | Reference-library conventions; guesses until captured | `src/parsers.ts` |
| D26 | Auth failure | A rejected login latches `AuthFailed`: no further network traffic until the config changes and a new client is built; a 100002 on `state-login` means "no login needed". Exception: 108003 (another admin session is open) is transient, see D32 | Never retry a rejected login (lockout) | `src/router-client.ts` |
| D27 | Where uptime and network type come from | Uptime only from an `uptime` field in `monitoring/status` (probably absent, so `networking.modem.uptime` may stay empty); network type probably empty until the `device/signal` field name is known | No extra request for a guess | `src/parsers.ts` |
| D28 | Configuration problems | A missing password stops the plugin from starting and says so; any other problem (bad URL, plan numbers) is logged, falls back to a safe default, and the plugin still runs | A half-working plugin beats a dead one, except when it cannot log in at all | `src/index.ts`, `src/config.ts` |
| D29 | While the plugin is stopped or restarting | Every REST route answers 503 | Routes are registered once; the runtime is rebuilt on each config change | `src/routes.ts` |
| D30 | Plugin status line | "Connecting to the router", "Connected to the router", "Router unreachable, retrying", or an error telling you to fix the login (with a separate message for the router's lockout) | Visible in the Signal K plugin list | `src/runtime.ts` |
| D31 | Slow-changing paths | Router link, plan and SMS summary are re-published on every signal tick as well as on change, so Status Tiles does not see them go stale | See D16 | `src/runtime.ts` |
| D32 | Router says another admin session is open (108003) | Treated as transient, not as wrong credentials: not latched, shown as "another admin session open, retrying", retried with the normal backoff | It clears by itself when the other page closes; halting forever was wrong. A 108003 is not a failed password, so retrying carries no lockout risk | `src/errors.ts`, `src/pollers.ts` |
| D33 | Anti-forgery tokens | Each response's tokens replace the queued ones (newest wins) | Appending grew without bound and made a later POST use an expired token. Unverified against a real router | `src/router-client.ts` |
| D34 | Time zone for SMS dates | Sent and read the same way: the Signal K server's local time | They disagreed before (UTC out, local in) | `src/parsers.ts`, `src/router-client.ts` |
| D35 | Delete or mark-read of an SMS | The plugin re-reads the router's list first and refuses with 409 ("changed on the router, refresh") if that exact message is no longer at that index | The router reuses indexes, so a stale list could delete the wrong message | `src/runtime.ts` |
| D36 | Send not confirmed | If the router accepts a message but never confirms it went out, the API answers `status: "unknown"` and the page shows an orange warning and keeps the draft | "Sent" would have been a guess | `src/runtime.ts`, `public/` |
| D37 | SMS notifications | Cleared when the message is read, deleted, or disappears from the router; the "connecting" link state raises no notification | They used to stay in alert forever | `src/runtime.ts` |
| D38 | A refused write in the webapp | A 401 on a write while reads work means "admin rights required" (the Signal K server answers a signed-in non-admin with 401, not 403); with reads failing it means "log in" | Found by testing against a real server | `public/lib/format.js` (`writeDenial`) |
| D39 | Local test server | Built outside the repo by `scripts/dev-server.sh`, against a mock router with synthetic data, with throwaway test users for `secure` | Never needs a real router; never a dependency | `scripts/dev-server.sh`, `docs/DEVELOPMENT.md` |
| D40 | WAN IP and uptime source | `getConnection` also calls `device/information` (`WanIPAddress`, `uptime`); `monitoring/status` has neither on a real B311-221. If that second call fails with a bad answer, the link state is still published without them | Found by the first real capture; the mock router had put them in the wrong place | `src/router-client.ts`, `src/parsers.ts` |
| D41 | Cell identifiers in committed fixtures | `cell_id`, `enodeb_id`, `tac`, `lac`, `cellinfo` replaced with made-up values of the same format | Together they locate the cell tower, so roughly where the boat was | `test/fixtures/real/README.md` |
| D42 | SMS paging | Each SMS poll reads the router's totals (`sms/sms-count`) and the newest page (20). If the inbox total grew by more than a page since the last poll, further pages are read (at most 5 pages, 100 messages) so no new message is missed. The unread count published and shown in the status is the router's own `LocalUnread`, kept in step locally when a message is marked read or deleted. Older messages are not browsable in the webapp; use the router's own page | The owner only needs new messages as notifications and readable in the webapp. The real inbox had 87 of 500 messages | `src/pollers.ts`, `src/runtime.ts`, `src/router-client.ts` |

## Open questions (need you or the hardware)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | ~~Real router responses~~ Captured 2026-10-07 on a B311-221 (11.0.2.2): login mode `password_type` 4, field names pinned, round of data requests about 1 s. Still open: other firmware versions | Re-run `scripts/capture-fixtures.mjs` on other firmware if reports come in | `test/fixtures/real/` |
| Q3 | Mostly answered on 2026-10-08. ASCII (7-bit) and non-ASCII (UCS2: `ü`, `ß`, `€`) messages sent from the plugin both arrived intact; `send-status` answers pending, then the number in `SucPhone`, and the parser reads that. Still open: behaviour with concurrent sessions, and receiving non-ASCII text | The receive check | SPEC §13.3 |
| Q5 | Are the tile stale times (D16) right for the real polling rates? Router link, plan and SMS paths must be re-emitted at least every 5 minutes | Publish these paths on every poll, not only on change | Tile accuracy |
| Q6 | Are the send limits (D20) right for you, and should sending also work when server security is disabled (D19)? | Keep as is; turn on Signal K security if the boat network is shared | `src/routes.ts` |
| Q7 | The webapp's phone layout clips the last SMS in the list box, and has no tabs | Fine for now; refine after seeing real use | `public/lib/styles.js` |
| Q9 | Half answered. `CurrentConnectTime` is the connection time (31 h against 43 h of router uptime), so it is not the boot uptime. Still open: whether the SMS `Date` is really server-local time | Receive a message at a known time and compare | `src/parsers.ts` |

Resolved: Q4 and Q11 (SMS inbox larger than one page) by D42. Not verified on the router: whether it accepts a `ReadCount` above 20, and whether page order holds while messages arrive.

Resolved: Q2 (does a Signal K server accept `zones` / `displayScale` in `meta` and raise the zone notifications?) is answered yes by a real server, see `docs/DEVELOPMENT.md`.

Resolved: Q8 (where do time and token numbers go?). The tool is BoatHacks/laserbrain; this project's rows were added to its `TIME-TRACKING.md` (commit `310b788`), see `docs/TIME_AND_TOKENS.md`.

Resolved: Q10 (archive the subagent transcripts?). Archived as they are, with the owner's go-ahead, under `laserbrain/subagent-logs/signalk-huawei-B311-221-plugin/` (laserbrain commit `f8f3646`).
