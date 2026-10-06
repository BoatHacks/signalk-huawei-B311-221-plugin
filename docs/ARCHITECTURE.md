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
notification set/clear. Maps domain objects to paths from SPEC §6.1 and attaches the `meta`
from SPEC §6.4. Values are published in the router's units; there is no
conversion layer.

### 2.6 HTTP routes
Registered through the plugin's `registerWithRouter`. Thin handlers over
SmsStore, UsageTracker and the current status snapshot. Input validation
lives here (§6).

### 2.7 Tile examples provider
`app.registerResourceProvider({ type: 'statusTileExamples', ... })`,
read-only, returning the set from `status-tiles-examples.json`. Mirrors
the pattern in signalk-status-tiles's `index.js`.

### 2.8 Webapp
Static files in `public/`, calling the REST routes. Vanilla ES modules
and web components with shadow DOM, mirroring signalk-status-tiles: CSS
custom properties on `:root` (dark base, `data-mode` day/night set from
the `environment.mode` delta), flat panels, `system-ui` plus monospace.
No build step, no framework, and **no network dependencies**: every
asset is vendored in `public/`. A test greps `public/` for `http(s)://`
references to enforce this.

## 3. Data Models

Shapes follow SPEC §4. TypeScript types (or JSDoc typedefs) in
`src/types`, shared by the client, pollers and publisher.

### 3.1 `radioQuality`

`networking.lte.radioQuality` (0-1) is the quality figure other LTE
plugins also publish; here it is computed from RSRP and SINR in dB:
each mapped linearly onto 0-1 between a poor and a good anchor
(RSRP -120..-80 dBm, SINR 0..20 dB, clamped), then the lower of the two
is used, since either one being bad makes the link bad. The anchors are
the same ones used for the `zones` in `meta`, so tiles and the number
agree. Exact anchors are tunable constants in one file.

## 4. Technology Stack

| Area | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22 | Matches Status Tiles; built-in `fetch`, `node:test` |
| Language | TypeScript, compiled to `dist/` | `@signalk/server-api` types; catches shape drift in the router parsing |
| Plugin API | `@signalk/server-api` | Standard plugin/resource-provider types |
| XML | small parser dependency (e.g. `fast-xml-parser`) | Router speaks XML; avoid hand-rolled parsing |
| Tests | `node:test`, recorded XML fixtures | No framework dependency |
| Lint/format | Biome | Same as the Status Tiles plugin |
| Webapp | vanilla ES modules + web components, vendored | Matches Status Tiles; offline-safe, no build |

## 5. Integration Points

- **Router web API**: the contract is only what RouterClient assumes;
  recorded fixtures pin it. Endpoint list to be confirmed on a device
  (SPEC §13.1).
- **Signal K server**: deltas, meta, notifications, router registration,
  resource provider, data directory (`app.getDataDirPath()`).
- **Signal K Status Tiles**: only via the `statusTileExamples` provider
  and via published paths/meta/notifications. No code dependency.

### 5.1 Router web API

Source: the community client
[Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api),
which lists the B311-221 as tested. Paths below are under `<router>/api/`.
Field names inside the responses are **not** taken from that library
(it passes raw dicts through) and must be pinned by recording fixtures.

| Concern | Calls |
|---|---|
| Session and token | `GET /` and read `<meta name="csrf_token" content="…">` from the HTML head; otherwise `GET webserver/token`, then `GET webserver/SesTokInfo` (`TokInfo`). A session cookie is set by the router |
| Request headers | `__RequestVerificationToken` on every request. Responses may rotate it via `__RequestVerificationTokenone` / `…two` headers, or `__RequestVerificationToken`. The client keeps a small token queue |
| Request/response format | XML, wrapped in `<request>…</request>`; errors arrive as `<error><code>…` (100002 unsupported, 100003 login required, 100004 busy, 125002 session/CSRF error, 125003 wrong session token; login errors 108001-108007, where 108007 is the password-attempt lockout) |
| Login | `GET user/state-login` (state, `password_type`, `rsapadingtype`), then `POST user/login` with `Username`, `Password`, `password_type`. `password_type` 4: `base64(sha256(user + base64(sha256(password) hex) + token) hex)`; type 0 is base64 of the password; type 3 also exists (base64, after a password change) and its handling is unverified. Login then refreshes the CSRF token |
| Signal | `GET device/signal` (rssi, rsrp, rsrq, sinr, cell, band, pci; values usually carry unit suffixes such as `dBm`, `dB`, and may be prefixed `>`/`<`, so parsing must be tolerant) |
| Status | `GET monitoring/status` (connection status, signal icon, network type, roaming, WAN IP, …) |
| Operator | `GET net/current-plmn` |
| Cell | `GET net/cell-info` |
| Traffic | `GET monitoring/traffic-statistics` (current session and total), `GET monitoring/month_statistics` (router's own month) |
| SMS read | `POST sms/sms-list` with ordered fields `PageIndex, ReadCount, BoxType (1=local inbox), SortType, Ascending, UnreadPreferred`; `GET sms/sms-count` |
| SMS send | `POST sms/send-sms` with `Index=-1, Phones/Phone, Sca, Content, Length, Reserved (text mode), Date`; poll `GET sms/send-status` |
| SMS manage | `POST sms/set-read`, `POST sms/delete-sms` (`Index`) |
| Logout | `POST user/logout` |

Notes that shape the design: field order in POST bodies matters on some
models; messages are identified by the router's `Index`, which can be
reused after deletion, so SmsStore dedupes on index plus date plus
sender; the router speaks CESU-8 for characters outside the BMP.

## 6. Security Considerations

- **Router credentials** are in the plugin config on the server. They are
  never logged and never returned by any REST route.
- **Routes** rely on the Signal K server's authentication. Reads need an
  authenticated user; SMS send/delete/mark-read and plan reset check for
  an admin user in the handler and return 403 otherwise.
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
├── scripts/                  capture-fixtures.mjs, redact.mjs
├── test/
│   ├── fixtures/             recorded router XML
│   └── *.test.ts
└── docs/
    ├── SPEC.md
    ├── ARCHITECTURE.md
    ├── IMPLEMENTATION_CHECKLIST.md
    └── plans/                per-feature plans and plan-template.md
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
