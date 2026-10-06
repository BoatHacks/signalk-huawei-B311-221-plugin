# signalk-huawei-b311-221 Architecture

Requirements and rationale live in [SPEC.md](./SPEC.md). This doc covers
how the code is organized.

## 1. Overview

```
 Huawei B311-221 (XML web API)
            ▲
            │ HTTP (session + tokens)
   ┌────────┴─────────┐
   │  RouterClient    │  login, token refresh, request/parse
   └────────┬─────────┘
            │ typed samples
   ┌────────┴─────────┐     ┌──────────────┐
   │  Pollers         │────▶│  UsageTracker│──▶ state.json
   │ signal/traffic/  │     └──────────────┘
   │ sms              │     ┌──────────────┐
   └────────┬─────────┘────▶│  SmsStore    │──▶ sms-state.json
            │              └──────────────┘
   ┌────────┴─────────┐
   │  Publisher       │  deltas + meta + notifications
   └────────┬─────────┘
            ▼
      Signal K server ◀── REST routes ◀── Webapp (public/)
            ▲
            └── statusTileExamples resource provider
```

## 2. System Components

### 2.1 RouterClient
Owns the HTTP session: fetches the session cookie and token, performs
login, attaches the rotating request token, and re-logins on session
expiry. Parses the router's XML into plain objects and surfaces errors as
typed failures (`AuthFailed`, `Unreachable`, `BadResponse`). It is the
only module that knows endpoint URLs or the router's response shapes.
Depends on nothing else in the plugin.

### 2.2 Pollers
Three independent timers (signal/status, traffic, SMS) driving
RouterClient calls. Requests are serialized through one queue so they
never overlap on the single session. Failures update the link state and
back off. `AuthFailed` stops polling until config changes.

### 2.3 UsageTracker
Turns counter samples into plan usage: delta from the last sample,
negative delta treated as a counter reset, plan-period rollover on the
configured reset day. Pure logic (no I/O) plus a persistence adapter, so
it is unit-testable with synthetic counter sequences.

### 2.4 SmsStore
Holds seen message IDs and a bounded recent-message cache. Decides which
messages are new (for notifications) and performs send / delete /
mark-read through RouterClient.

### 2.5 Publisher
The only module that talks to the Signal K app object for output:
`handleMessage` deltas, `meta` deltas (units, displayName, zones),
notification set/clear. Maps domain objects to paths from SPEC §6.1.

### 2.6 HTTP routes
Registered through the plugin's `registerWithRouter`. Thin handlers over
SmsStore, UsageTracker and the current status snapshot. Input validation
lives here (§6).

### 2.7 Tile examples provider
`app.registerResourceProvider({ type: 'statusTileExamples', ... })`,
read-only, returning the set from `status-tiles-examples.json`. Mirrors
the pattern in signalk-status-tiles's `index.js`.

### 2.8 Webapp
Static files in `public/`, calling the REST routes. No build step in v0.1
if it can be avoided (see SPEC §13.6).

## 3. Data Models

Shapes follow SPEC §4. TypeScript types (or JSDoc typedefs) in
`src/types`, shared by the client, pollers and publisher.

## 4. Technology Stack

| Area | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22 | Matches Status Tiles; built-in `fetch`, `node:test` |
| Language | TypeScript, compiled to `dist/` | `@signalk/server-api` types; catches shape drift in the router parsing |
| Plugin API | `@signalk/server-api` | Standard plugin/resource-provider types |
| XML | small parser dependency (e.g. `fast-xml-parser`) | Router speaks XML; avoid hand-rolled parsing |
| Tests | `node:test`, recorded XML fixtures | No framework dependency |
| Lint/format | Biome | Same as the Status Tiles plugin |
| Webapp | static HTML/JS | Offline, small |

## 5. Integration Points

- **Router web API**: the contract is only what RouterClient assumes;
  recorded fixtures pin it. Endpoint list to be confirmed on a device
  (SPEC §13.1).
- **Signal K server**: deltas, meta, notifications, router registration,
  resource provider, data directory (`app.getDataDirPath()`).
- **Signal K Status Tiles**: only via the `statusTileExamples` provider
  and via published paths/meta/notifications. No code dependency.

## 6. Security Considerations

- **Router credentials** are in the plugin config on the server. They are
  never logged and never returned by any REST route.
- **Routes** rely on the Signal K server's authentication; `POST`/`DELETE`
  require write access.
- **SMS send** validates the number (E.164-ish) and text length, and
  rate limits sends, since this spends real money and can message anyone.
- **Router TLS**: the router speaks plain HTTP on the LAN. The plugin
  should only talk to the configured LAN host and refuse redirects to
  other hosts.
- **Untrusted content**: SMS text is attacker-controlled. The webapp must
  render it as text, never HTML, and notification messages must truncate
  it.
- **Lockout**: no login retry loops on rejected credentials.

## 7. File Structure

```
signalk-huawei-b311-221/
├── package.json
├── SPEC.md
├── ARCHITECTURE.md
├── src/
│   ├── index.ts              plugin entry, lifecycle, config schema
│   ├── router-client.ts
│   ├── pollers.ts
│   ├── usage-tracker.ts
│   ├── sms-store.ts
│   ├── publisher.ts
│   ├── routes.ts
│   ├── tiles-provider.ts
│   └── types.ts
├── status-tiles-examples.json
├── public/                   webapp
├── test/
│   ├── fixtures/             recorded router XML
│   └── *.test.ts
└── docs/plans/               per-feature plans (if adopted)
```

## 8. Deployment

Published to npm with the `signalk-node-server-plugin` and
`signalk-webapp` keywords, installed from the Signal K appstore. Needs
network reachability to the router (default `192.168.8.1`). Persistent
state lives in the plugin data directory, so it survives upgrades.
Release procedure is the BoatHacks plugin release flow.

## 9. Future Considerations

- Keep RouterClient behind an interface so other Huawei models, or a
  mock router for tests, can slot in.
- Keep Publisher path mapping in one table so path renames (SPEC §13.2)
  are a one-file change.
- Leave room for a PUT handler for SMS and router control without
  restructuring the routes layer.
