# Implementation Plan: Router response capture script

## Overview

A small standalone script that you run on the boat LAN against a real
B311-221. It records the router's raw XML responses, redacts anything
personal, and writes files that become `test/fixtures/` for the
RouterClient and parsers. It also answers the questions that block the
design: which `password_type` and `rsapadingtype` the firmware reports,
and what the signal, status, traffic and SMS fields are actually called.
This cloud environment cannot reach the router, so the script has to be
run by you.

## Relevant SPEC/ARCHITECTURE Sections

- SPEC §13.1 (endpoints and login hashing unverified), §13.3 (SMS
  encoding, counters)
- SPEC §3.1 (link states), §4 (data model), §5 (sources)
- ARCHITECTURE §2.1 (RouterClient), §5.1 (router web API), §6 (security)

## Approach

A single Node ≥ 22 file with no dependencies (`node:crypto`, global
`fetch`, `node:fs`), so it can be copied to any machine with Node and run
without `npm install`. It is **read-only by construction**: an explicit
allowlist of endpoints, GET plus the one POST that only lists messages.
It never calls send, delete, set-read, reconnect, reboot or any `set`
endpoint.

**Flow**

1. `GET /` and read the `csrf_token` meta tag, falling back to
   `webserver/token`, then `webserver/SesTokInfo`. Save each raw response.
2. `GET user/state-login` and save it. This reveals `password_type` and
   `rsapadingtype` **without logging in**, so a `--no-login` run already
   answers SPEC §13.1 for the login scheme.
3. Unless `--no-login`: log in once. Implement `password_type` 0 and 4
   (the algorithm in ARCHITECTURE §5.1). If the firmware reports a type or
   RSA requirement the script does not support, stop and say so, saving
   the `state-login` response. **One attempt only, no retries**: a
   rejected login ends the run, because repeated attempts trigger the
   router's lockout (error 108007).
4. Capture the allowlisted endpoints (below), each saved as the raw
   response body plus a small header record (status, content type, the
   rotated token header names, **not** token values or cookies).
5. Optional `--repeat N --interval S`: re-capture `device/signal`,
   `monitoring/status` and `monitoring/traffic-statistics` N times,
   to show how values and unit suffixes vary and how the traffic
   counters move.
6. Log out, always, including after an error.

**Endpoint allowlist**

| Group | Endpoint |
|---|---|
| Token / login state | `/`, `webserver/token`, `webserver/SesTokInfo`, `user/state-login` |
| Device | `device/information`, `device/basic_information`, `device/boot_time` |
| Signal | `device/signal`, `net/cell-info`, `net/current-plmn`, `net/net-mode` |
| Status | `monitoring/status`, `monitoring/converged-status` |
| Traffic | `monitoring/traffic-statistics`, `monitoring/month_statistics`, `monitoring/start_date` |
| SMS (read only) | `sms/sms-count`, `sms/sms-list` (inbox, `ReadCount` 5), `sms/sms-feature-switch` |

Endpoints that answer "unsupported" (100002) are recorded as such. That
is itself useful information about this firmware.

**Credentials**

- Router URL from an argument; username and password from environment
  variables or an interactive prompt, **never** command-line arguments
  (shell history).
- The password and the hashed login value are never written to disk or
  printed. Debug output redacts `Password`, tokens and cookies.

**Redaction** (a separate, unit-tested module used by the script and
also runnable on already-captured files)

Redaction is XML-aware and keeps element names, nesting, value *formats*
and unit suffixes, which is what parsing depends on, and replaces the
values themselves with stable placeholders:

- phone numbers, SMS `Content`, IMEI, IMSI, ICCID, MSISDN, serial
  number, MAC addresses, SSIDs, hostnames, public and WAN IPs, device
  name strings that embed a serial, and any element named like a
  token, password or key.
- SMS content is replaced by a same-length placeholder, and a note
  records whether the original contained non-ASCII characters or
  characters outside the 7-bit set, because that decides the text-mode
  handling (SPEC §13.3).
- LAN addresses (`192.168.8.x`) are kept.
- Each redaction is logged by *kind and count* (never value), and a final
  leak scan flags anything still shaped like a phone number, IMEI, MAC or
  public IP. Output is written only if the scan is clean, otherwise the
  run keeps the raw files in a clearly named `UNREDACTED/` directory and
  tells you not to share it.

**Output**

```
capture-out/<timestamp>/
├── redacted/            <- safe to share and commit
│   ├── manifest.json    <- endpoints, status, content types, firmware
│   │                       strings, counts of redactions
│   └── *.xml
└── UNREDACTED/          <- raw, only if --keep-raw; gitignored, never shared
```

`capture-out/` is added to `.gitignore`. Redacted files you choose to
keep are copied by hand to `test/fixtures/`, after you read them.

**Alternatives considered**

- *Reuse the Python `huawei-lte-api` to capture.* Rejected: needs Python
  and pip on the boat, and hides the raw XML we need as fixtures.
- *Browser DevTools HAR export.* Possible as a fallback, but it contains
  cookies and tokens throughout and is hard to redact reliably.
- *Capture and redact in the plugin itself.* Rejected: wrong place for a
  one-off diagnostic, and it would ship credentials-handling code to
  every user.

## Test Strategy

No live tests, since there is no device in CI.

- **Redaction unit tests**: synthetic XML containing every sensitive kind
  (including edge cases: phone numbers with `+` and spaces, MACs in both
  separator styles, IPv6, SMS with emoji) must come out with no original
  value present and with structure and formats intact.
- **Login hashing**: known-answer tests for the `password_type` 4 and 0
  encodings with a fixed username, password and token, cross-checked
  against the algorithm in `huawei-lte-api`'s `User._encode_password`.
- **Flow tests against a local mock router** (a small `node:http`
  server in the test): serves canned XML, a token header sequence, a
  login that succeeds or fails. Assert that the script (a) makes only
  allowlisted calls, (b) never retries a failed login, (c) always logs
  out, (d) never writes the password, hashed password, token or cookie
  to any output file, and (e) stops cleanly on an unsupported
  `password_type`.
- **Manual**: you run it once with `--no-login`, then with login.

## Implementation Steps

- [ ] Write redaction tests, then `scripts/redact.mjs`
- [ ] Write login-hash known-answer tests, then the hashing helpers
- [ ] Write mock-router flow tests
- [ ] Write `scripts/capture-fixtures.mjs` (token discovery,
      `state-login`, optional single login, allowlisted capture, logout)
- [ ] Add `--repeat/--interval`, `--no-login`, `--skip-sms`, `--keep-raw`
- [ ] Add `capture-out/` to `.gitignore`; add `scripts/README.md` with
      the run instructions and what to send back
- [ ] Dry-run against the mock router, then review the output by eye
- [ ] You run it on the boat LAN; review the redacted output before
      sharing
- [ ] Copy reviewed files to `test/fixtures/`; update SPEC §13.1 and
      ARCHITECTURE §5.1 with the verified field names and login mode

## Files to Create/Modify

- `scripts/capture-fixtures.mjs` (new)
- `scripts/redact.mjs` (new)
- `scripts/README.md` (new)
- `test/redact.test.mjs`, `test/capture-login.test.mjs`,
  `test/capture-flow.test.mjs` (new)
- `.gitignore` (new: `capture-out/`, `node_modules/`)
- later: `test/fixtures/*.xml`, SPEC.md §13, ARCHITECTURE.md §5.1

## Open questions for this plan

- How do you want to send the redacted capture back: paste into chat, or
  commit the `redacted/` directory to a branch yourself?
- Do you want the optional repeated sampling on by default (say 3
  samples, 30 s apart) so one run shows variability?
