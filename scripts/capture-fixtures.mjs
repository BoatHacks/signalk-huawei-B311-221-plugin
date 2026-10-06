#!/usr/bin/env node
// Records raw responses from a Huawei B311-221 so they can become test
// fixtures. Read-only by construction: only the endpoints allowlisted
// below can be called. See docs/plans/capture-fixtures.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodePassword } from "./login.mjs";
import { redactCsrfMeta, redactXml, scanLeaks } from "./redact.mjs";

const ALLOWED_GET = new Set([
  "webserver/token",
  "webserver/SesTokInfo",
  "user/state-login",
  "device/information",
  "device/basic_information",
  "device/boot_time",
  "device/signal",
  "net/cell-info",
  "net/current-plmn",
  "net/net-mode",
  "monitoring/status",
  "monitoring/converged-status",
  "monitoring/traffic-statistics",
  "monitoring/month_statistics",
  "monitoring/start_date",
  "sms/sms-count",
  "sms/sms-feature-switch",
]);
const ALLOWED_POST = new Set(["user/login", "user/logout", "sms/sms-list"]);

export function isAllowed(method, endpoint) {
  if (method === "GET") return ALLOWED_GET.has(endpoint);
  if (method === "POST") return ALLOWED_POST.has(endpoint);
  return false;
}

const DATA_ENDPOINTS = [
  "device/information",
  "device/basic_information",
  "device/boot_time",
  "device/signal",
  "net/cell-info",
  "net/current-plmn",
  "net/net-mode",
  "monitoring/status",
  "monitoring/converged-status",
  "monitoring/traffic-statistics",
  "monitoring/month_statistics",
  "monitoring/start_date",
];
const SMS_ENDPOINTS = [
  "sms/sms-count",
  "sms/sms-feature-switch",
  "sms/sms-list",
];
const REPEATED = [
  "device/signal",
  "monitoring/status",
  "monitoring/traffic-statistics",
];
const FIRMWARE_FIELDS = [
  "DeviceName",
  "HardwareVersion",
  "SoftwareVersion",
  "WebUIVersion",
  "Classify",
  "ProductFamily",
];
const SUPPORTED_PASSWORD_TYPES = [0, 3, 4];
const TOKEN_ERRORS = [125002, 125003];
const SMS_LIST_BODY =
  "<request><PageIndex>1</PageIndex><ReadCount>5</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>";

const leafValue = (xml, name) =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
const errorCodeOf = (text) => {
  const m = /<error>\s*<code>(\d+)<\/code>/.exec(text);
  return m ? Number(m[1]) : undefined;
};
const fileFor = (endpoint, sample) =>
  `${endpoint.replace(/\//g, "_")}${sample > 1 ? `.${sample}` : ""}.xml`;

export async function runCapture(opts) {
  const {
    url,
    username = "admin",
    password = "",
    noLogin = false,
    skipSms = false,
    repeat = 0,
    intervalMs = 30000,
    outDir,
    keepRaw = false,
    timeoutMs = 15000,
    log = console.log,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => performance.now(),
  } = opts;
  const base = url.replace(/\/+$/, "");
  const jar = new Map();
  let tokens = [];
  const requests = [];
  const raw = []; // { endpoint, file, text, kind }
  const manifest = {
    tool: "capture-fixtures",
    startedAt: new Date().toISOString(),
    login: { attempted: false, ok: null },
    requests,
  };
  let fatal = null;
  let loggedIn = false;

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  async function send(method, path, body, { clearTokens = false } = {}) {
    const headers = {};
    if (method === "POST") {
      headers["Content-Type"] = "application/xml";
      if (tokens.length > 1)
        headers.__RequestVerificationToken = tokens.shift();
      else if (tokens.length === 1)
        headers.__RequestVerificationToken = tokens[0];
    } else if (tokens.length === 1) {
      headers.__RequestVerificationToken = tokens[0];
    }
    if (jar.size) headers.Cookie = cookieHeader();
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (clearTokens) tokens = [];
    const one = res.headers.get("__RequestVerificationTokenone");
    if (one) {
      tokens.push(one);
      const two = res.headers.get("__RequestVerificationTokentwo");
      if (two) tokens.push(two);
    } else if (res.headers.get("__RequestVerificationToken")) {
      tokens.push(res.headers.get("__RequestVerificationToken"));
    }
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: await res.text(),
    };
  }

  async function loadTokens() {
    tokens = [];
    const home = await send("GET", "/");
    const found = [
      ...home.text.matchAll(/name="csrf_token"\s+content="(\S+?)"/g),
    ].map((m) => m[1]);
    if (found.length) tokens = found;
    return home;
  }

  async function record(
    endpoint,
    method,
    body,
    { sample = 1, store = true } = {},
  ) {
    if (!isAllowed(method, endpoint)) {
      throw new Error(
        `Refusing to call ${method} ${endpoint}: not on the allowlist`,
      );
    }
    const t0 = now();
    const entry = { endpoint, method };
    let res = null;
    try {
      res = await send(method, `/api/${endpoint}`, body, {
        clearTokens: endpoint === "user/login",
      });
      const code = errorCodeOf(res.text);
      if (
        code !== undefined &&
        TOKEN_ERRORS.includes(code) &&
        endpoint !== "user/login"
      ) {
        entry.retried = true;
        await loadTokens();
        res = await send(method, `/api/${endpoint}`, body);
      }
    } catch (e) {
      entry.outcome = "network-error";
      entry.error = e?.name ?? "Error";
    }
    entry.ms = Math.round((now() - t0) * 100) / 100;
    if (res) {
      entry.status = res.status;
      entry.contentType = res.contentType;
      const code = errorCodeOf(res.text);
      if (res.status >= 300 && res.status < 400) entry.outcome = "redirect";
      else if (code === 100002) {
        entry.outcome = "unsupported";
        entry.errorCode = code;
      } else if (code !== undefined) {
        entry.outcome = "error";
        entry.errorCode = code;
      } else entry.outcome = "ok";
      if (store && entry.outcome !== "redirect") {
        entry.file = fileFor(endpoint, sample);
        raw.push({ endpoint, file: entry.file, text: res.text, kind: "xml" });
      }
    }
    requests.push(entry);
    return { entry, res };
  }

  const totalStart = now();
  let dataStart = null;
  let dataEnd = null;

  try {
    log("Discovering session token...");
    const t0 = now();
    const home = await loadTokens().catch(() => null);
    const homeEntry = {
      endpoint: "/",
      method: "GET",
      ms: Math.round((now() - t0) * 100) / 100,
    };
    if (home) {
      homeEntry.status = home.status;
      homeEntry.outcome = "ok";
      raw.push({
        endpoint: "/",
        file: "home_csrf-meta.txt",
        text: home.text,
        kind: "csrf",
      });
      homeEntry.file = "home_csrf-meta.txt";
    } else {
      homeEntry.outcome = "network-error";
    }
    requests.push(homeEntry);
    if (!home) {
      fatal = "router-unreachable";
    } else {
      if (!tokens.length) {
        for (const ep of ["webserver/token", "webserver/SesTokInfo"]) {
          const { res } = await record(ep, "GET");
          const tok =
            res &&
            (leafValue(res.text, "token") ?? leafValue(res.text, "TokInfo"));
          if (tok) {
            tokens = [tok];
            break;
          }
        }
      }
      const { entry, res } = await record("user/state-login", "GET");
      if (!res || entry.outcome !== "ok") {
        fatal = "router-unreachable";
      } else {
        manifest.login.passwordType = Number(
          leafValue(res.text, "password_type") ?? 0,
        );
        const rsa = leafValue(res.text, "rsapadingtype");
        manifest.login.rsaPaddingType = rsa === undefined ? null : Number(rsa);
        manifest.login.loginState = Number(
          leafValue(res.text, "State") ?? Number.NaN,
        );
      }
    }

    if (!fatal && !noLogin) {
      if (!SUPPORTED_PASSWORD_TYPES.includes(manifest.login.passwordType)) {
        fatal = "unsupported-password-type";
      } else {
        log("Logging in (one attempt, no retries)...");
        manifest.login.attempted = true;
        const encoded = encodePassword(
          manifest.login.passwordType,
          username,
          password,
          tokens[0] ?? "",
        );
        const body = `<request><Username>${username}</Username><Password>${encoded}</Password><password_type>${manifest.login.passwordType}</password_type></request>`;
        const { entry, res } = await record("user/login", "POST", body, {
          store: false,
        });
        if (!res || entry.outcome !== "ok") {
          manifest.login.ok = false;
          if (entry.errorCode !== undefined)
            manifest.login.errorCode = entry.errorCode;
          fatal = "login-failed";
        } else {
          manifest.login.ok = true;
          loggedIn = true;
        }
      }
    }

    if (loggedIn) {
      try {
        dataStart = now();
        log("Capturing...");
        for (const ep of DATA_ENDPOINTS) await record(ep, "GET");
        if (!skipSms) {
          for (const ep of SMS_ENDPOINTS) {
            if (ep === "sms/sms-list") await record(ep, "POST", SMS_LIST_BODY);
            else await record(ep, "GET");
          }
        }
        dataEnd = now();
        for (let i = 1; i <= repeat; i += 1) {
          log(`Waiting ${intervalMs / 1000}s before sample ${i + 1}...`);
          await sleep(intervalMs);
          for (const ep of REPEATED)
            await record(ep, "GET", undefined, { sample: i + 1 });
        }
      } finally {
        const { entry } = await record(
          "user/logout",
          "POST",
          "<request><Logout>1</Logout></request>",
          {
            store: false,
          },
        );
        loggedIn = entry.outcome === "ok" ? false : loggedIn;
      }
    }
  } catch (e) {
    fatal = `unexpected-error: ${e?.message ?? e}`;
  }

  const totalMs = Math.round((now() - totalStart) * 100) / 100;
  manifest.timing = {
    totalMs,
    dataRoundMs:
      dataStart !== null && dataEnd !== null
        ? Math.round((dataEnd - dataStart) * 100) / 100
        : null,
  };

  // Redact, then check the result before anything is written.
  const redacted = [];
  const counts = {};
  const notes = { smsNonAscii: 0, smsAstral: 0 };
  const findings = [];
  for (const r of raw) {
    const out = r.kind === "csrf" ? redactCsrfMeta(r.text) : redactXml(r.text);
    for (const [k, n] of Object.entries(out.counts))
      counts[k] = (counts[k] ?? 0) + n;
    if (out.notes) {
      notes.smsNonAscii += out.notes.smsNonAscii;
      notes.smsAstral += out.notes.smsAstral;
    }
    redacted.push({ ...r, text: out.text });
    for (const f of scanLeaks(out.text)) findings.push(`${r.endpoint}: ${f}`);
  }
  manifest.redactions = counts;
  manifest.notes = notes;
  const info = redacted.find((r) => r.endpoint === "device/information");
  if (info) {
    manifest.firmware = {};
    for (const f of FIRMWARE_FIELDS) {
      const v = leafValue(info.text, f);
      if (v !== undefined) manifest.firmware[f] = v;
    }
  }
  manifest.leakFindings = findings;

  mkdirSync(outDir, { recursive: true });
  const writeAll = (dir, files) => {
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.file), f.text);
  };
  const redactedWritten = findings.length === 0;
  if (redactedWritten) {
    writeAll(join(outDir, "redacted"), redacted);
    writeFileSync(
      join(outDir, "redacted", "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (keepRaw) writeAll(join(outDir, "UNREDACTED"), raw);
  } else {
    writeAll(join(outDir, "UNREDACTED"), raw);
    writeFileSync(
      join(outDir, "WITHHELD.txt"),
      [
        "The redacted output was NOT written because the leak scan found values",
        "that still look sensitive. Findings (kinds only, never values):",
        "",
        ...findings,
        "",
        "The raw responses are in UNREDACTED/. Do not share or commit them.",
        "",
      ].join("\n"),
    );
  }

  return {
    ok: fatal === null,
    reason: fatal ?? undefined,
    outDir,
    redactedWritten,
    leakFindings: findings,
    manifest,
  };
}

function parseArgs(argv) {
  const args = { url: "http://192.168.8.1", repeat: 0, interval: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--repeat") args.repeat = Number(argv[++i]);
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--no-login") args.noLogin = true;
    else if (a === "--skip-sms") args.skipSms = true;
    else if (a === "--keep-raw") args.keepRaw = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const HELP = `Usage: node scripts/capture-fixtures.mjs [options]

Records read-only responses from a Huawei B311-221 for use as test fixtures.
Credentials: HUAWEI_USER (default admin) and HUAWEI_PASS, or a hidden prompt.
Never pass the password as an argument.

  --url <url>        router address (default http://192.168.8.1)
  --out <dir>        output directory (default capture-out/<timestamp>)
  --no-login         only capture what the router serves without a login
  --skip-sms         do not read the SMS inbox
  --repeat <n>       re-capture signal/status/traffic n more times
  --interval <sec>   seconds between repeats (default 30)
  --keep-raw         also keep the unredacted responses in UNREDACTED/
`;

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("Cancelled"));
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const username = process.env.HUAWEI_USER || "admin";
  let password = process.env.HUAWEI_PASS ?? "";
  if (!args.noLogin) {
    if (!password) {
      if (!process.stdin.isTTY) {
        console.error("Set HUAWEI_PASS, or run in a terminal to be prompted.");
        return 2;
      }
      password = await promptHidden(`Router password for ${username}: `);
    }
    console.log(
      "Note: logging in can log you out of the router's own web page (limited admin sessions).",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out ?? join("capture-out", stamp);
  const result = await runCapture({
    url: args.url,
    username,
    password,
    noLogin: args.noLogin,
    skipSms: args.skipSms,
    repeat: args.repeat,
    intervalMs: args.interval * 1000,
    keepRaw: args.keepRaw,
    outDir,
  });
  if (result.reason) console.error(`Stopped: ${result.reason}`);
  if (result.redactedWritten) {
    console.log(`Redacted capture written to ${join(outDir, "redacted")}`);
    console.log("Read the files before sharing or committing them.");
  } else {
    console.error(
      `Redacted output WITHHELD (see ${join(outDir, "WITHHELD.txt")}). Raw files are in UNREDACTED/: do not share them.`,
    );
  }
  const t = result.manifest.timing;
  console.log(
    `One data round: ${t.dataRoundMs ?? "n/a"} ms (whole run ${t.totalMs} ms)`,
  );
  return result.ok && result.redactedWritten ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e?.message ?? e);
      process.exit(2);
    },
  );
}
