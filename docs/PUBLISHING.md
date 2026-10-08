# Publishing

Everything the Signal K plugin guide and the plugin registry recommend is in
place except the steps below, which need an npm or GitHub account.

## What is already done

- `package.json`: `signalk-node-server-plugin` keyword, `main`, `files`, valid
  semver, `engines.node` (>=20.19.0), `signalk.displayName`, `appIcon`,
  `screenshots` (two real images in `docs/images/`), `recommends` (Status Tiles,
  signalk-internet, both checked on npm).
- Workflows: `test.yml` (Node 20, 22, 24), `plugin-ci.yml` (the registry's
  reusable workflow, pinned to the signalk-server v2.33.0 release commit, with
  its real-server integration job on), `publish.yml` (npm trusted publishing).
- `CHANGELOG.md`, `LICENSE` (MIT), a committed `package-lock.json`, and
  `npm audit --omit=dev` reports no vulnerabilities.
- The plugin runs without a router configured (it just waits for the
  password), so the registry's load/activate/schema checks have nothing to trip
  over.

## CI evidence

On commit `7823587` (2026-10-07) both workflows passed in full:

- `Tests`: Node 20, 22 and 24 on Linux.
- The registry's `SignalK Plugin CI`, all 13 jobs: Linux x64 and arm64, macOS and
  Windows on Node 22 and 24; the Cerbo GX (armv7 under QEMU) job on Node 20; and
  the integration job, which installs the plugin into a real Signal K server
  (latest, Node 22 and 24) and checks it loads. Every step passed, including
  package validation, entry-point load, `schema()`, the start/stop lifecycle,
  "npm pack includes all required files", the deprecated-API scan, the Node 20
  compatibility check, and the simulated App Store install.

That is a good sign for the registry's load, activate and schema checks, but the
registry's own score is only computed after publishing.

## Checked on real hardware

On 2026-10-07 and 2026-10-08, against a B311-221 on software 11.0.2.2 (details
in `docs/OPEN_QUESTIONS.md`):

- Response field names were pinned from a capture (`test/fixtures/real/`).
- The plugin's own `RouterClient` logged in (`password_type` 4), reused its
  session, read signal, operator, connection, traffic and SMS totals, and
  logged out.
- One ASCII and one non-ASCII message were sent through it and arrived intact;
  two replies from a phone were received and decoded, and their dates are the
  router's local time.
- That turned up two bugs that the mock router could not show: uptime and WAN IP
  are not in `monitoring/status`, and the router files delivery reports in the
  inbox. Both are fixed.

Not checked: the whole plugin running in a Signal K server against the real
router (only the client was), other firmware versions, and concurrent admin
sessions.

## Before the first release

1. ~~**Pick the version.**~~ Done: `package.json` and the lockfile say
   `0.1.0`, and the `CHANGELOG.md` section is dated 2026-10-08.
2. ~~**Capture a real router.**~~ Done, see above.
3. ~~**Merge to `main` and check CI.**~~ Done on 2026-10-08. `main` was created
   from commit `9b499ff` (the 0.1.0 commit) and made the default branch. The
   `Tests` workflow passed on it, and the registry's `SignalK Plugin CI` passed
   on the same commit on the working branch; look at the runs for whatever
   commit you actually release.
4. ~~**Set the GitHub repo metadata.**~~ Done on 2026-10-08: description,
   homepage (the npm package page) and the topics `signalk`, `signalk-plugin`,
   `marine`, `lte`, `huawei`, `sms`.

Branch protection is not set up. The `oss-branch-protection` skill has the
template if you want it later.

## The first publish is manual

npm cannot configure a trusted publisher for a package that does not exist yet.

1. `npm publish` from a clean checkout, with your 2FA one-time code
   (`--otp=<code>`). The build runs through `prepack`.
2. On npmjs.com: the package, Settings, Trusted Publisher, GitHub Actions. Set
   the repository, the workflow file `publish.yml`, and leave the environment
   empty.
3. From then on, publishing a GitHub release runs `publish.yml` and publishes
   with no token.

The registry's JSON for the package appears after its next nightly run, at
`https://signalk.org/signalk-plugin-registry/plugins/signalk-huawei-b311-221.json`.
