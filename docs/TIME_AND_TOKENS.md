# Time and token ledger

Raw working notes for the time and token numbers of this plugin. **The
system of record is the BoatHacks time-tracking log**, `TIME-TRACKING.md` in
[BoatHacks/laserbrain](https://github.com/BoatHacks/laserbrain), where this
project's rows were added on 2026-10-07 (commit `310b788`) in that log's own
format: one row per task with durations from commit timestamps, one row per
subagent with its own token budget, and a session-totals row. This file keeps
the working detail behind them.

Sources: the session record (`get_session`) for the main session, and the
completion notices of each subagent for theirs. Nothing here is estimated;
where a figure may be incomplete it says so.

## Main session

| Snapshot (UTC) | Wall clock since start | Input tokens | Output tokens | Cache read | Cache write | Cost (USD) |
|---|---|---|---|---|---|---|
| 2026-10-06 23:15 | 0 h 50 min | 89,836 | 61,325 | 10,109,478 | 151,210 | 3.36 |

Session started 2026-10-06 22:25 UTC. Model: claude-sonnet-5-5.

Caveat: this usage counter read identically at two snapshots about ten
minutes apart (while a lot of work happened between them), so it is
probably updated only at turn boundaries and should be read as a lower
bound. It is also unknown whether it already includes the subagent tokens
below.

## Subagents

Tokens as reported in each agent's completion notice (a single total per
agent; input and output are not split). Agents ran in parallel, so their
durations overlap and must not be added to wall-clock time.

| Work | Tokens | Duration |
|---|---|---|
| UsageTracker | 62,837 | 1 min 26 s |
| SmsStore and StateStore | 69,076 | 1 min 36 s |
| Status Tiles set and provider | 99,691 | 1 min 47 s |
| Publisher, paths, radioQuality | 89,615 | 2 min 10 s |
| Webapp (with screenshots) | 94,169 | 3 min 35 s |
| RouterClient and parsers | 169,865 | 7 min 39 s |
| Independent code review (forked skill run) | ~107k, derived from its transcript | 2 min 10 s |
| **Subtotal** | **~692k** | **~20 min 24 s of agent time** |

## Harness token budget

A second, live figure: the harness shows the remaining token budget for
this session. It measures something different from the usage record above
(it is a countdown of the budget, not the billing counters), so the two do
not need to match.

| Snapshot (UTC) | Budget | Remaining | Consumed |
|---|---|---|---|
| 2026-10-06 23:24 | 15,000,000 | 14,930,849 | 69,151 |
| 2026-10-06 23:31 | 15,000,000 | 14,878,256 | 121,744 |

## Rate limit

The session is in a five-hour usage window that resets at 2026-10-07
03:50 UTC. The hourly routine `trig_01JvLxNvzWZFXZhmWTZWBSBx` resumes the
work after the window runs out.

## Log of resumed runs

Each automatic resume appends one line: time (UTC), what ran, usage from
`get_session` at the end, and the usage difference from the previous line.

| Time (UTC) | Work | Usage at end | Since last line |
|---|---|---|---|
| 2026-10-06 23:25 | Built the router client's review, plugin runtime, routes wiring, package checks, docs; went from supervised to running alone | counter unchanged from the first snapshot (89,836 in / 61,325 out); not updating mid-run | none visible |
| 2026-10-06 23:35 | Independent code review of the whole branch (a forked review run; its own token use is not reported), then fixes for nine findings, test-first; docs, ledger; routine disabled | counter still unchanged (89,836 in / 61,325 out); wall clock 1 h 10 min since start | harness budget used 121,744 since start |
| 2026-10-07 00:20 | Installed a local Signal K server (2.33), tested the plugin on it incl. security, Status Tiles and a real browser; wrote and proved `scripts/dev-server.sh`; webapp 401 fix | session counter still frozen at 89,836 in / 61,325 out | harness budget at 14,939,900 left of 15,000,000 (about 60,100 consumed in this task; the budget counter restarts at 15,000,000 on each new request) |


## Real main-thread figures (from the session transcript)

The session record's own usage and context counters stayed frozen all
session (89,836 in / 61,325 out; 193,004 of 1,000,000), so the figures used
in the laserbrain log come from the session transcript instead, as of
2026-10-07 07:25 UTC: 249 API calls, all `claude-sonnet-5-5`; 315,531 output
tokens; 1,063,985 cache-write; 82,460,245 cache-read (re-reads of the same
context on every call, not new work); 502 uncached input; context window
590,862 of 1,000,000 at the last call.

The subagent token totals reported in completion notices match each agent's
final context size to within about 2-3k, which is how the review run's figure
was derived.

The seven subagent transcripts (six build agents and the review run) are archived complete and unedited in `laserbrain/subagent-logs/signalk-huawei-B311-221-plugin/`, and each subagent row in `TIME-TRACKING.md` links its file.
