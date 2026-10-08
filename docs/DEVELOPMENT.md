# Development

## Checks

```sh
npm install
npm run lint && npm run typecheck && npm test
```

## A local Signal K server

`scripts/dev-server.sh` builds a real Signal K server **outside the repo**
(default `~/signalk-dev`, so it never becomes a dependency), installs this
plugin into it from a packed tarball, exactly as a user would, and points
it at a mock router with synthetic data. It never contacts a real router.

```sh
scripts/dev-server.sh setup      # first time, about half a minute
scripts/dev-server.sh start      # mock router + server
scripts/dev-server.sh status
scripts/dev-server.sh reinstall  # after changing the plugin, then: start
scripts/dev-server.sh secure     # turn on Signal K security with two test users
scripts/dev-server.sh stop
```

Then open:

- Signal K: http://localhost:3000 (admin UI at `/admin`)
- The plugin's page: http://localhost:3000/@boathacks/signalk-huawei-b311-221/
- Its data: http://localhost:3000/signalk/v1/api/vessels/self/networking/lte

Environment: `SK_DEV_DIR`, `SK_PORT` (3000), `MOCK_PORT` (8099), `MOCK_RSRP`
(-98). Restart the mock with a weak signal to see the server raise its own
notification:

```sh
MOCK_RSRP=-110 scripts/dev-server.sh start   # warn band
MOCK_RSRP=-120 scripts/dev-server.sh start   # alarm band
```

`secure` creates `admin / adminpw-123` and a non-admin `crew / crewpw-123`.
They exist only on this throwaway test server.

The server prefers Node 24 and warns on Node 22; the plugin itself needs
Node 22.18 or newer and has been run on 22.

## What was verified against a real Signal K server (2.33)

Done on 2026-10-06 with the mock router standing in for the B311:

- The server loads the plugin, lists its webapp with the icon, and shows the
  plugin status ("Connected to the router").
- It accepts our `meta`, including `zones` and `displayScale`, and **raises its
  own notification** at `notifications.networking.lte.rsrp` from the zones:
  normal at -98 dBm, `warn` ("LTE signal weak") at -110 dBm.
- After the mock router restarted, the plugin recovered by itself.
- The REST routes work; reads need a logged-in user, and with security on a
  logged-in non-admin can read but every write is refused. The server answers
  those writes with **401**, not 403, so the webapp treats a 401 on a write as
  "admin rights required" when reads are working.
- The real Status Tiles plugin discovers our example set through the
  `statusTileExamples` resource provider, adds it with its own
  `PUT /plugins/signalk-status-tiles/examples`, and evaluates the tiles from
  live data: signal amber at -110 dBm, connection green, plan green, router
  link green, SMS opportunity with one unread message.
- In a real browser, signed in as the non-admin user, the page shows the
  admin banner and hides the write controls; as admin, sending works.

Not verified: anything involving a real B311 (see
[OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md), Q1, Q3, Q9).
