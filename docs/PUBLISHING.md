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

## Before the first release

1. **Pick the version.** `package.json` says `0.0.0`. Use `0.1.0` for the first
   release and move the `CHANGELOG.md` "Unreleased" section under it.
2. **Capture a real router** (`scripts/capture-fixtures.mjs`, see
   `scripts/README.md`) and check the parsers against it. Until then every
   response field name is a guess (`docs/OPEN_QUESTIONS.md`, Q1). This is the
   one thing that should not ship unverified.
3. **Set the GitHub repo metadata** (not scored, but the registry skill asks for
   it). Needs a GitHub login with admin rights on the repo:

   ```sh
   REPO=BoatHacks/signalk-huawei-B311-221-plugin
   PKG=signalk-huawei-b311-221
   gh api --method PATCH "repos/$REPO" \
     -f description="Signal K plugin for the Huawei B311-221 LTE router: signal, connection, data plan and SMS" \
     -f homepage="https://www.npmjs.com/package/$PKG"
   jq -n '{names:["signalk","signalk-plugin","marine","lte","huawei","sms"]}' |
     gh api --method PUT "repos/$REPO/topics" --input -
   ```

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
