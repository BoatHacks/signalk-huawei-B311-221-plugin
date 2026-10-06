import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAllowed, runCapture } from "../scripts/capture-fixtures.mjs";
import { encodePassword } from "../scripts/login.mjs";
import {
  COOKIE,
  SENSITIVE,
  startMockRouter,
  TOKENS,
} from "./helpers/mock-router.mjs";

const quiet = () => {};

async function capture(routerOpts = {}, runOpts = {}) {
  const router = await startMockRouter(routerOpts);
  const outDir = mkdtempSync(join(tmpdir(), "capture-test-"));
  try {
    const result = await runCapture({
      url: router.url,
      ...router.credentials,
      outDir,
      log: quiet,
      sleep: async () => {},
      ...runOpts,
    });
    return { router, outDir, result, calls: router.calls };
  } finally {
    await router.close();
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const allFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
const sig = (c) => `${c.method} ${c.path}`;

test("--no-login captures only the unauthenticated login state", async () => {
  const { outDir, calls, result } = await capture({}, { noLogin: true });
  assert.equal(result.ok, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.ok(!calls.some((c) => c.path.includes("device/")));
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.equal(manifest.login.attempted, false);
  assert.equal(manifest.login.passwordType, 4);
  assert.equal(manifest.login.rsaPaddingType, 1);
  assert.ok(existsSync(join(outDir, "redacted", "user_state-login.xml")));
  assert.ok(existsSync(join(outDir, "redacted", "home_csrf-meta.txt")));
});

test("a normal run logs in once, captures only allowlisted calls, and logs out last", async () => {
  const { calls, result, outDir } = await capture();
  assert.equal(result.ok, true);
  assert.equal(
    calls.filter((c) => sig(c) === "POST /api/user/login").length,
    1,
  );
  assert.equal(sig(calls.at(-1)), "POST /api/user/logout");
  for (const c of calls) {
    if (c.path === "/") continue;
    assert.ok(
      isAllowed(c.method, c.path.replace(/^\/api\//, "")),
      `not allowed: ${sig(c)}`,
    );
  }
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.equal(manifest.login.ok, true);
  assert.equal(manifest.firmware.DeviceName, "B311-221");
  assert.equal(manifest.firmware.SoftwareVersion, "21.318.03.00.01");
  assert.ok(existsSync(join(outDir, "redacted", "device_signal.xml")));
  assert.ok(existsSync(join(outDir, "redacted", "sms_sms-list.xml")));
});

test("--skip-sms makes no SMS calls at all", async () => {
  const { calls } = await capture({}, { skipSms: true });
  assert.ok(!calls.some((c) => c.path.includes("sms/")));
});

test("the sms-list request is read-only and limited to five inbox messages", async () => {
  const { calls } = await capture();
  const list = calls.find((c) => c.path === "/api/sms/sms-list");
  assert.ok(list);
  assert.match(list.body, /<ReadCount>5<\/ReadCount>/);
  assert.match(list.body, /<BoxType>1<\/BoxType>/);
});

test("cookies and the rotating token are sent back to the router", async () => {
  const { calls } = await capture();
  const login = calls.find((c) => c.path === "/api/user/login");
  assert.ok(login.cookie.includes(COOKIE));
  assert.equal(login.token, TOKENS.home);
  const after = calls.find((c) => c.path === "/api/device/information");
  assert.ok(after.cookie.includes(COOKIE));
});

test("no secret, token, cookie or personal value reaches any output file", async () => {
  const { outDir, router } = await capture();
  const encoded = encodePassword(
    4,
    "admin",
    router.credentials.password,
    TOKENS.home,
  );
  const forbidden = [
    router.credentials.password,
    encoded,
    TOKENS.home,
    TOKENS.afterLogin,
    TOKENS.reload,
    COOKIE,
    SENSITIVE.imei,
    SENSITIVE.serial,
    SENSITIVE.mac,
    SENSITIVE.wanIp,
    SENSITIVE.phone,
    "Hello",
  ];
  const files = allFiles(outDir);
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const s of forbidden) {
      assert.ok(!text.includes(s), `${file} contains a forbidden value`);
    }
  }
});

test("a rejected login is attempted once, never retried, and nothing else is requested", async () => {
  const { calls, result, outDir } = await capture({ failLogin: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "login-failed");
  assert.equal(calls.filter((c) => c.path === "/api/user/login").length, 1);
  assert.ok(!calls.some((c) => c.path === "/api/user/logout"));
  assert.ok(
    !calls.some((c) => c.path.includes("device/") || c.path.includes("sms/")),
  );
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.equal(manifest.login.errorCode, 108006);
  assert.ok(existsSync(join(outDir, "redacted", "user_state-login.xml")));
});

test("an unsupported password_type stops before any login attempt", async () => {
  const { calls, result, outDir } = await capture({ passwordType: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-password-type");
  assert.ok(!calls.some((c) => c.path === "/api/user/login"));
  assert.ok(existsSync(join(outDir, "redacted", "user_state-login.xml")));
});

test("an endpoint the firmware does not support is recorded and the run continues", async () => {
  const { outDir, result } = await capture({ unsupported: ["net/cell-info"] });
  assert.equal(result.ok, true);
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  const entry = manifest.requests.find((r) => r.endpoint === "net/cell-info");
  assert.equal(entry.outcome, "unsupported");
  assert.equal(entry.errorCode, 100002);
  assert.equal(
    manifest.requests.find((r) => r.endpoint === "device/signal").outcome,
    "ok",
  );
});

test("a token error triggers one token reload and one retry", async () => {
  const { calls, outDir } = await capture({ csrfFailOnce: ["device/signal"] });
  const homeGets = calls.filter(
    (c) => c.method === "GET" && c.path === "/",
  ).length;
  assert.equal(homeGets, 2);
  assert.equal(calls.filter((c) => c.path === "/api/device/signal").length, 2);
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  const entry = manifest.requests.find((r) => r.endpoint === "device/signal");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.retried, true);
});

test("a dropped connection is recorded and logout still happens", async () => {
  const { calls, outDir, result } = await capture({
    destroy: ["monitoring/status"],
  });
  assert.equal(result.ok, true);
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.equal(
    manifest.requests.find((r) => r.endpoint === "monitoring/status").outcome,
    "network-error",
  );
  assert.equal(sig(calls.at(-1)), "POST /api/user/logout");
});

test("a redirect is recorded but never followed", async () => {
  const { outDir, result } = await capture({ redirect: ["net/net-mode"] });
  assert.equal(result.ok, true);
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.equal(
    manifest.requests.find((r) => r.endpoint === "net/net-mode").outcome,
    "redirect",
  );
});

test("output that still looks sensitive is withheld, with the raw copy kept apart", async () => {
  const blob = "0123456789abcdef0123456789abcdef01234567";
  const { outDir, result } = await capture({
    extra: {
      "net/net-mode": `<?xml version="1.0"?><response><Blob>${blob}</Blob></response>`,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.redactedWritten, false);
  assert.ok(result.leakFindings.length > 0);
  assert.ok(!existsSync(join(outDir, "redacted")));
  assert.ok(existsSync(join(outDir, "UNREDACTED", "net_net-mode.xml")));
  const note = readFileSync(join(outDir, "WITHHELD.txt"), "utf8");
  assert.ok(note.includes("net/net-mode"));
  assert.ok(!note.includes(blob));
});

test("--keep-raw also writes the unredacted copy", async () => {
  const { outDir } = await capture({}, { keepRaw: true });
  assert.ok(existsSync(join(outDir, "redacted", "manifest.json")));
  const raw = readFileSync(
    join(outDir, "UNREDACTED", "device_information.xml"),
    "utf8",
  );
  assert.ok(raw.includes(SENSITIVE.imei));
});

test("by default no unredacted copy is written", async () => {
  const { outDir } = await capture();
  assert.ok(!existsSync(join(outDir, "UNREDACTED")));
});

test("--repeat re-captures signal, status and traffic as numbered samples", async () => {
  const { outDir, calls } = await capture({}, { repeat: 1, intervalMs: 0 });
  for (const name of [
    "device_signal.2.xml",
    "monitoring_status.2.xml",
    "monitoring_traffic-statistics.2.xml",
  ]) {
    assert.ok(existsSync(join(outDir, "redacted", name)), name);
  }
  assert.equal(calls.filter((c) => c.path === "/api/device/signal").length, 2);
  assert.equal(
    calls.filter((c) => c.path === "/api/device/information").length,
    1,
  );
});

test("every request is timed, and one data round is timed separately from the whole run", async () => {
  let t = 0;
  const { outDir } = await capture({}, { now: () => (t += 5) });
  const manifest = readJson(join(outDir, "redacted", "manifest.json"));
  assert.ok(manifest.requests.length > 10);
  for (const r of manifest.requests) assert.equal(typeof r.ms, "number");
  const sum = manifest.requests.reduce((a, r) => a + r.ms, 0);
  assert.ok(manifest.timing.totalMs >= sum);
  assert.ok(manifest.timing.dataRoundMs > 0);
  assert.ok(manifest.timing.dataRoundMs < manifest.timing.totalMs);
});

test("the allowlist refuses anything that writes or controls the router", () => {
  for (const [m, p] of [
    ["POST", "sms/send-sms"],
    ["POST", "sms/delete-sms"],
    ["POST", "sms/set-read"],
    ["POST", "net/reconnect"],
    ["POST", "device/control"],
    ["POST", "user/pwd"],
    ["GET", "wlan/security-settings"],
    ["POST", "device/signal"],
    ["GET", "user/login"],
  ]) {
    assert.equal(isAllowed(m, p), false, `${m} ${p}`);
  }
  for (const [m, p] of [
    ["GET", "device/signal"],
    ["GET", "user/state-login"],
    ["POST", "user/login"],
    ["POST", "user/logout"],
    ["POST", "sms/sms-list"],
  ]) {
    assert.equal(isAllowed(m, p), true, `${m} ${p}`);
  }
});

test("output directory contains only files, with the redacted tree under redacted/", async () => {
  const { outDir } = await capture();
  for (const f of allFiles(outDir)) assert.ok(statSync(f).isFile());
  assert.ok(allFiles(outDir).every((f) => f.includes("redacted")));
});
