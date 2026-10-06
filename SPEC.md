# signalk-huawei-b311-221 Specification

Status: **draft v0.1**. Items marked *(verify)* rest on recollection of the
router's undocumented web API and must be confirmed against a real B311-221
before implementation (see §13).

## 1. Introduction

### 1.1 Purpose

A Signal K server plugin that turns a Huawei B311-221 LTE router, the
common boat-internet box, into a first-class data source. It publishes
cellular signal quality, connection status and data usage as Signal K
paths, tracks consumption against a user-configured data plan, and lets
the user read and send SMS. Everything is visible without opening the
router's own web UI, usable by other plugins and apps, and glanceable
through Status Tiles.

### 1.2 Background

- The B311-221 exposes an undocumented XML web API (the one its own
  admin pages use). It requires a login session and CSRF-style tokens.
  No official documentation exists; behaviour is known from community
  clients.
- [signalk-status-tiles](https://github.com/meri-imperiumi/signalk-status-tiles)
  reduces many raw paths to a grid of green/amber/red/neutral/opportunity
  tiles. It is *config-driven*: plugins do not push tiles. Instead a
  plugin registers a read-only resource provider of type
  `statusTileExamples`, and users copy the offered tile set into their
  Status Tiles config with the `+` button. Tile checks read ordinary
  Signal K paths (`banded`, `zone` via path `meta.zones`, `stateMatch`,
  `notification`, …) and treat missing or stale data as unknown, never
  green. This spec's "compatible output" requirement follows from that
  (§6.3).

### 1.3 Terminology

- **Router**: the B311-221 on the boat's LAN.
- **Plan**: the user's data allowance for a billing period (size, reset
  day).
- **Plan period**: the interval from one reset day to the next.
- **Router counters**: traffic totals the router itself reports. These
  can reset on reboot or on the router's own monthly reset.
- **Plugin-tracked usage**: usage accumulated by this plugin from counter
  deltas, robust against router counter resets (§3).

## 2. Domain Rules

- LTE signal quality is described by RSSI, RSRP, RSRQ and SINR. Only
  RSRP, RSRQ and SINR are meaningful for judging service quality;
  RSSI alone is not. Tile thresholds use RSRP and SINR.
- Router counters are not authoritative for the plan period: the plan
  period is defined by the user's carrier, not by the router.
- The router allows limited concurrent admin sessions. The plugin must
  hold one session, reuse it, and re-login on expiry, never log in per
  poll.
- A boat may have no cellular service for days. "No data" is a normal
  state, not an error to be hidden, and must be published as such.

## 3. State / Lifecycle Model

### 3.1 Router link state

| State | Meaning |
|---|---|
| `connecting` | Plugin started, first login in progress |
| `ok` | Session valid, polls succeeding |
| `auth-failed` | Credentials rejected. Do not retry-loop (lockout risk); wait for config change |
| `unreachable` | Network or timeout errors. Retry with backoff |

### 3.2 Plan period

`active` → (reset day reached) → `active` with a fresh baseline. Usage
since the last router-counter reset is added to the accumulated total;
a router counter that goes *down* is treated as a reset, not negative
usage.

### 3.3 SMS message

`new` (seen first time, notification raised) → `known` (ID recorded, no
re-notification, even after plugin restart).

## 4. Data Model

- **SignalSample**: rssi, rsrp, rsrq, sinr, band, cellId, pci,
  networkType (e.g. LTE / LTE-A), operator name and PLMN.
- **ConnectionStatus**: link state (§3.1), WAN IP, connection state,
  roaming flag, signal bars, connection uptime.
- **UsageAccount**: planBytes, periodStart, accumulatedBytes (up and
  down), lastCounterSample (to compute deltas).
- **SmsMessage**: id, direction (in / out), peer number, text,
  timestamp, read flag.

## 5. Sources / Inputs

- **Router web API** (polled). Signal and status on a fast interval,
  traffic counters medium, SMS slow. Defaults in §9.
- **Plugin config** (plan, credentials, intervals).
- **User actions** via REST (send SMS, mark read, delete).

If the router disappears, all router-derived paths stop updating and
the plugin raises the unreachable notification. Paths are *not* zeroed:
timestamps going stale is the signal consumers (and Status Tiles) use.

## 6. API Specification

### 6.1 Signal K paths *(naming to verify against the spec and
existing plugins, see §13)*

Under `networking.cellular.` (proposed):

| Path | Content |
|---|---|
| `signal.rsrp`, `signal.rsrq`, `signal.sinr`, `signal.rssi` | dBm / dB values, each with `meta` (units, displayName, `zones`) |
| `signal.bars` | 0-5 |
| `network.type`, `network.band`, `network.operator`, `network.roaming`, `network.cellId` | strings / booleans |
| `connection.state`, `connection.wanIp`, `connection.uptime` | connection status |
| `link` | plugin↔router state (§3.1) |
| `usage.plan.totalBytes`, `.usedBytes`, `.remainingBytes`, `.usedRatio`, `.periodEnd` | plugin-tracked plan |
| `usage.router.up`, `usage.router.down` | router-reported counters |
| `sms.unread`, `sms.lastReceived` | SMS summary |

Notifications under `notifications.networking.cellular.*`:
`plan` (warn/alarm at configured thresholds), `link` (unreachable / auth
failed), `signal` (weak signal / no service / roaming), `sms.<id>` (new
message).

### 6.2 REST API (under `/plugins/signalk-huawei-b311-221/`)

All routes use the Signal K server's authentication. Write routes
require an authenticated admin or read-write user.

| Route | Purpose |
|---|---|
| `GET /status` | Current signal, connection, link state, plan snapshot |
| `GET /sms?limit=` | List messages |
| `POST /sms` `{to, text}` | Send an SMS. Returns accepted/failed. Validates number and length |
| `POST /sms/:id/read`, `DELETE /sms/:id` | Mark read / delete (also on the router) |
| `POST /plan/reset` | Manually restart the plan period baseline |

### 6.3 Status Tiles compatibility

1. Every published numeric path carries `meta` with `units`,
   `displayName`, and `zones` where thresholds are meaningful (RSRP,
   SINR), so `zone` checks work without extra config.
2. Plan state is published as a ratio (`usedRatio`) and also via
   notifications, so both `banded` and `notification` checks work.
3. The plugin registers a `statusTileExamples` resource provider
   offering one set (`huawei-b311`) with tiles: Signal quality, Cellular
   connection, Data plan, SMS. Tiles must degrade to neutral/stale, not
   green, when the plugin is not running.

## 7. User Interface

An embedded webapp, listed in the Signal K server's webapps, shows:

- Signal quality and connection status at a glance.
- Data plan gauge (used / remaining / days to reset).
- SMS inbox and a compose form.

Constraints: must work on a phone-sized screen over the boat LAN, must
work offline from the internet (no CDN assets), and must follow the
Signal K light/dark behaviour if available. Settings live in the
standard plugin config form, not in the webapp.

## 8. Persistence

Must survive restart: UsageAccount, plan baseline, and the set of
seen SMS IDs. Everything else is re-derived from the router. Stored in
the plugin's data directory as small JSON files; write on change, with a
write rate limit.

## 9. Configuration

Via the standard plugin JSON-schema form.

| Setting | Default |
|---|---|
| Router URL | `http://192.168.8.1` |
| Username / password | `admin` / (none, required) |
| Signal/status poll interval | 10 s |
| Traffic poll interval | 60 s |
| SMS poll interval | 60 s |
| Plan size, reset day of month | none: plan tracking disabled until set |
| Plan warn / alarm thresholds | 80 % / 95 % |
| Notify on new SMS | on |
| Signal-quality notification thresholds (RSRP, SINR) | derived from the zones in §6.3 |

## 10. MVP Scope

### 10.1 MVP Features (v0.1)

The user chose to ship everything in v0.1:

- Login, session reuse, re-login, backoff.
- Signal, status and traffic paths with metadata.
- Plugin-tracked data plan with threshold notifications.
- SMS receive (notifications) and send (REST).
- Webapp (status, plan, inbox, compose).
- Status Tiles example provider.

Note: this is a large first release. If scope pressure appears, the
natural fall-back order is (1) webapp polish, (2) SMS delete/mark-read,
(3) tile provider, with core metrics and the plan staying in v0.1.

### 10.2 Post-MVP / Deferred

- Multiple routers (one router is enough for a boat; revisit on demand).
- Router control (reconnect, reboot, band lock). Higher risk, not asked
  for.
- SignalK PUT handler for SMS send: more surface, needs a recipient
  allowlist. REST was chosen first.
- Other Huawei models.

## 11. References

- signalk-status-tiles: https://github.com/meri-imperiumi/signalk-status-tiles
  (SPEC.md §3.3 check types, §6 output; `index.js` `statusTileExamples`
  provider and `status-tiles-examples.json` set format)
- Signal K specification (notifications, meta/zones):
  https://signalk.org/specification/
- Community Huawei LTE API clients, for endpoint behaviour *(verify; to
  be chosen and cited once reviewed)*

## 12. Design Decisions

- **Web API with login, not unauthenticated endpoints.** The
  unauthenticated endpoints do not expose signal detail or SMS.
- **Plugin-tracked plan usage over mirroring router counters.** The
  router's counters reset on reboot and follow its own month, not the
  carrier's billing period.
- **Tiles via `statusTileExamples` provider, not by pushing tiles.**
  This is how Status Tiles is designed; users own their config.
- **SMS send over REST, not PUT.** Narrower, auditable surface; PUT can
  follow later with an allowlist.
- **No zeroing of paths on outage.** Stale timestamps are the truthful
  signal.

## 13. Open Questions

1. **Exact router endpoints and login hashing** on the B311-221's
   firmware. Needs verification against a real device; none available
   in the design session.
2. **Path naming**: does `networking.cellular.*` collide with or
   duplicate an existing convention or plugin? Check the spec and the
   plugin registry before fixing names.
3. **Units**: Signal K prefers SI. dBm/dB values are logarithmic;
   decide whether to publish as-is with meta units or convert.
4. **SMS permissions**: should send require admin, or any read-write
   user? Should numbers be allowlisted from day one?
5. **Prior art**: is there an existing Huawei LTE SignalK plugin worth
   building on or mirroring? Not yet searched.
6. **Webapp stack**: framework-free vs. a small framework, given the
   offline and size constraints.
