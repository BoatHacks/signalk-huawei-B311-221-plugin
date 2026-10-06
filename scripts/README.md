# scripts

## capture-fixtures.mjs

Records read-only responses from a Huawei B311-221 so they can become
`test/fixtures/` for the router client and parsers. Plan:
[docs/plans/capture-fixtures.md](../docs/plans/capture-fixtures.md).

Needs Node 22 or newer and nothing else (`npm install` is not required).
Run it from a machine on the router's LAN.

```sh
# 1. Without logging in. Safe, and already shows the login scheme.
node scripts/capture-fixtures.mjs --no-login

# 2. Full capture. The password comes from the environment or a hidden
#    prompt, never from an argument.
HUAWEI_PASS='...' node scripts/capture-fixtures.mjs
```

Options: `--url` (default `http://192.168.8.1`), `--out`, `--skip-sms`,
`--repeat <n>` with `--interval <sec>`, `--keep-raw`. `--help` lists them.
`HUAWEI_USER` defaults to `admin`.

### What it does and does not do

- Calls only an allowlist of read endpoints. The one POST besides login
  and logout lists up to five inbox messages. It never sends, deletes,
  marks, reconnects, reboots or changes any setting.
- Logs in **once**. A rejected login ends the run, because repeated
  attempts trigger the router's lockout (error 108007). It always logs
  out. Logging in can log you out of the router's own web page.
- One update round by default. `manifest.json` records the time of every
  request, of one round of the data endpoints (`dataRoundMs`) and of the
  whole run (`totalMs`). That tells us what polling interval is realistic.
- Does not implement the RSA-encrypted login some newer firmware offers.
  If the router reports a `password_type` the script does not know, it
  stops and saves `user_state-login.xml` so the scheme can be added.

### Output

```
capture-out/<timestamp>/
├── redacted/       phone numbers, SMS text, IMEI/IMSI/ICCID, serial,
│                   MACs, SSIDs, public IPs, tokens and passwords removed;
│                   element names, structure and value formats kept
│   ├── manifest.json
│   └── *.xml
└── UNREDACTED/     only with --keep-raw, or when the leak scan objects
```

After redacting, the script scans the result. If anything still looks
sensitive it writes **no** `redacted/` directory, saves the raw responses
in `UNREDACTED/`, and lists the kinds of finding (never the values) in
`WITHHELD.txt`. Never share or commit `UNREDACTED/`. `capture-out/` is
git-ignored.

Read the files in `redacted/` before sharing them. Redaction is rule
based; a human check is the last line of defence.

### What to hand back

The whole `redacted/` directory, or copy its files into `test/fixtures/`
and commit them. Also note the router's reported `password_type` and
`rsapadingtype` (both are in `manifest.json` under `login`).
