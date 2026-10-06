# Implementation Plan: Plugin wiring

## Overview

Connect the finished modules (config, router client, pollers, publisher,
usage tracker, SMS store, state store, routes, tiles provider) into the
Signal K plugin in `src/index.ts`, and prove the whole chain with an
end-to-end test that uses the mock router and a fake Signal K app.

## Relevant SPEC/ARCHITECTURE Sections

- SPEC §3 (link and plan lifecycle), §5 (sources), §6 (paths, REST, tiles),
  §8 (persistence), §9 (configuration)
- ARCHITECTURE §1 (overview diagram), §2 (components), §6 (security)

## Approach

One `Runtime` object is built in `start()` and torn down in `stop()`; the
plugin object itself stays thin. This keeps the end-to-end test simple (it
can build a runtime with fakes) and makes restarts clean, since the server
calls `stop()` then `start()` on every config change.

**Start**

1. `normalizeConfig(rawConfig)`. If there are errors, show them with
   `setPluginStatus`/`setPluginError`. A missing password means we do not
   start polling at all (nothing useful can happen); other problems fall
   back to defaults and are reported.
2. `StateStore` in `app.getDataDirPath()`; load `usage` and `sms`.
3. `UsageTracker` with the saved account and the plan; `SmsStore`.
4. `Publisher`; `sendMeta()`.
5. `RouterClient` for the configured URL; `Pollers` with the handlers below.
6. Register routes (done by the server calling `registerWithRouter`, which
   needs the runtime to exist: routes read from a mutable `current` that is
   empty while stopped and answer 503 then).
7. Start the tiles provider; start the pollers.

**Handlers**

| Event | Does |
|---|---|
| `onSignal` | publish signal, operator, connection; `notifyService` only when its state changes; remember the values for `GET /status` |
| `onTraffic` | publish router counters; `tracker.update(sample)`; persist the account; publish the plan snapshot; `notifyPlan` when `levelChanged` |
| `onSms` | `smsStore.ingest`; publish the summary; `notifySms` for each new message when enabled; persist |
| `onLink` | publish `routerLink`; `notifyLink`; remember for `GET /status` |

Status Tiles marks a path stale when it stops updating (SPEC §6.3), so the
slow-changing paths (`routerLink`, `sms.unread`, `plan.*`) are re-published
on every signal tick as well as on change. Notifications are only sent on
change.

**Stop**: stop pollers (waits for any request in flight), log out of the
router, `stateStore.flush()`, stop the tiles provider, drop the runtime so
routes answer 503.

**Actions for routes**: `send` goes through the router client, then asks
the pollers for an SMS poll so the sent message shows up; `markRead` and
`remove` call the client. `resetPlan` calls `tracker.reset()` and persists.

**Alternatives considered**

- Building everything at module load: rejected, the server restarts the
  plugin on every config change and needs clean teardown.
- Letting the publisher read state itself: rejected, it stays a pure
  mapper so it can be tested without a router.

## Test Strategy

End-to-end with the mock router (`test/helpers/mock-router.mjs`), fake
timers and a fake `ServerAPI` that records deltas, notifications, status
messages and registered routes:

- start publishes meta, then signal/operator/connection/traffic/plan/SMS
  paths with the expected values and units;
- a wrong password ends in `auth-failed`, publishes it, and stops polling
  (no second login attempt);
- router going away: link `unreachable`, stale paths are not nulled, link
  notification raised; recovery clears it;
- plan crossing 80 % and 95 % raises and clears the notification once per
  change; usage survives a stop/start (state files);
- a new SMS raises one notification; a restart does not repeat it;
- routes answer 503 when stopped, and work when running;
- `stop()` logs out, flushes state and leaves no timers.

## Status

Built and tested end to end against the mock router. The built `dist/`
package was smoke-tested (loads, tile set resolves, starts against an
unresponsive router without crashing). Not run on a real router or inside a
real Signal K server.

## Implementation Steps

- [x] Wait for the router client module; confirm its API against
      `RouterPort` in `src/pollers.ts`, adapt (error names `AuthFailed`,
      `Unreachable`)
- [x] Write the end-to-end tests
- [x] Write `src/runtime.ts` (build/teardown, handlers, status snapshot)
- [x] Rewrite `src/index.ts` (schema from `configSchema()`,
      `registerWithRouter`, start/stop, tiles provider)
- [x] Add `public` to the lint script, `signalk.appIcon`, `files`
- [ ] Update SPEC/ARCHITECTURE where the build differs

## Files to Create/Modify

- `src/runtime.ts` (new), `src/index.ts`
- `test/e2e.test.ts` (new), `test/plugin.test.ts`
- `package.json`
- `docs/SPEC.md`, `docs/ARCHITECTURE.md`
