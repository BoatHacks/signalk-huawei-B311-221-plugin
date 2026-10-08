import assert from "node:assert/strict";
import { test } from "node:test";
import { cesu8Encode, cesu8Fix } from "../src/cesu8.ts";
import {
  AuthFailed,
  BadResponse,
  InvalidRequest,
  SessionBusy,
  Unreachable,
} from "../src/errors.ts";
import { formatRouterDate, routerDateToIso } from "../src/parsers.ts";
import type { RouterClientOptions } from "../src/router-client.ts";
import { chooseSmsMode, RouterClient } from "../src/router-client.ts";
// @ts-expect-error plain-JS test helper without type declarations
import { COOKIE, startMockRouter, TOKENS } from "./helpers/mock-router.mjs";

// Everything here talks to the in-process mock router or to a fake fetch.
// No real network, no real sleeping.

interface Mock {
  url: string;
  calls: {
    method: string;
    path: string;
    body: string;
    cookie: string;
    token: string;
  }[];
  sent: {
    phone: string;
    content: string;
    length: number;
    reserved: number;
    raw: string;
  }[];
  sms:
    | {
        index: number;
        phone: string;
        content: string;
        date: string;
        stat?: number;
      }[]
    | null;
  expireSession(): void;
  credentials: { username: string; password: string };
  close(): Promise<void>;
}

async function withRouter(
  opts: Record<string, unknown>,
  fn: (
    router: Mock,
    make: (o?: Partial<RouterClientOptions>) => RouterClient,
  ) => Promise<void>,
) {
  const router = (await startMockRouter(opts)) as Mock;
  const make = (o: Partial<RouterClientOptions> = {}) =>
    new RouterClient({
      baseUrl: router.url,
      ...router.credentials,
      sleep: async () => {},
      ...o,
    });
  try {
    await fn(router, make);
  } finally {
    await router.close();
  }
}

const count = (router: Mock, method: string, path: string) =>
  router.calls.filter((c) => c.method === method && c.path === path).length;

test("nothing is requested until the first call, then one login serves all calls", async () => {
  await withRouter({}, async (router, make) => {
    const client = make();
    assert.equal(router.calls.length, 0);
    await client.getSignal();
    await client.getOperator();
    await client.getConnection();
    assert.equal(count(router, "POST", "/api/user/login"), 1);
    assert.equal(count(router, "GET", "/"), 1);
  });
});

test("the login request carries a hashed password, never the plaintext", async () => {
  await withRouter({}, async (router, make) => {
    await make().getSignal();
    const login = router.calls.find((c) => c.path === "/api/user/login");
    assert.ok(login);
    assert.ok(!login.body.includes(router.credentials.password));
    assert.match(login.body, /<password_type>4<\/password_type>/);
    assert.ok(login.cookie.includes(COOKIE));
    assert.equal(login.token, TOKENS.home);
    const after = router.calls.find((c) => c.path === "/api/device/signal");
    assert.ok(after?.cookie.includes(COOKIE));
  });
});

test("getSignal, getOperator, getConnection parse the router's answers", async () => {
  await withRouter({}, async (_router, make) => {
    const client = make();
    const s = await client.getSignal();
    assert.equal(s.rsrp, -98);
    assert.equal(s.rsrq, -11);
    assert.equal(s.sinr, 9);
    assert.equal(s.rssi, -67);
    assert.equal(s.band, "3");
    assert.equal(s.pci, "123");
    assert.deepEqual(await client.getOperator(), {
      name: "Telia",
      plmn: "24001",
    });
    const c = await client.getConnection();
    assert.equal(c.connected, true);
    assert.equal(c.serviceAvailable, true);
    assert.equal(c.bars, 4);
    assert.equal(c.wanIp, "100.75.91.205");
    assert.equal(c.uptimeSeconds, 86400);
  });
});

test("getConnection survives a device/information answer it cannot use", async () => {
  const extra = { "device/information": "not xml" };
  await withRouter({ extra }, async (_router, make) => {
    const c = await make().getConnection();
    assert.equal(c.connected, true);
    assert.equal(c.wanIp, undefined);
  });
});

test("getTraffic returns the cumulative totals stamped with the injected clock", async () => {
  const extra = {
    "monitoring/traffic-statistics":
      "<?xml version='1.0'?><response><TotalUpload>500</TotalUpload><TotalDownload>900</TotalDownload></response>",
  };
  await withRouter({ extra }, async (_router, make) => {
    const t = await make({ now: () => 1234 }).getTraffic();
    assert.deepEqual(t, { uploadBytes: 500, downloadBytes: 900, at: 1234 });
  });
});

test("getTraffic without a total counter is a BadResponse", async () => {
  await withRouter({}, async (_router, make) => {
    await assert.rejects(make().getTraffic(), BadResponse);
  });
});

test("a rejected login is AuthFailed, tried once, and later calls fail without touching the router", async () => {
  await withRouter({ failLogin: true }, async (router, make) => {
    const client = make();
    await assert.rejects(
      client.getSignal(),
      (e: unknown) =>
        e instanceof AuthFailed && e.code === 108006 && !e.lockout,
    );
    const before = router.calls.length;
    await assert.rejects(client.getSignal(), AuthFailed);
    await assert.rejects(client.login(), AuthFailed);
    assert.equal(router.calls.length, before);
    assert.equal(count(router, "POST", "/api/user/login"), 1);
    assert.equal(client.authFailed, true);
  });
});

test("login error codes map to reasons, and 108007 is a lockout", async () => {
  const expected: [number, string, boolean][] = [
    [108001, "username-wrong", false],
    [108002, "password-wrong", false],
    [108006, "credentials-wrong", false],
    [108007, "lockout", true],
    [108004, "rejected", false],
    [108005, "rejected", false],
    [115002, "password-change-required", false],
  ];
  for (const [code, reason, lockout] of expected) {
    await withRouter(
      { failLogin: true, loginErrorCode: code },
      async (_r, make) => {
        await assert.rejects(
          make().getSignal(),
          (e: unknown) =>
            e instanceof AuthFailed &&
            e.code === code &&
            e.reason === reason &&
            e.lockout === lockout,
          String(code),
        );
      },
    );
  }
});

test("an empty password is refused locally without any request", async () => {
  await withRouter({}, async (router, make) => {
    await assert.rejects(
      make({ password: "" }).getSignal(),
      (e: unknown) => e instanceof AuthFailed,
    );
    assert.equal(router.calls.length, 0);
  });
});

test("clearAuthFailure allows a fresh login attempt", async () => {
  await withRouter({ failLogin: true }, async (router, make) => {
    const client = make();
    await assert.rejects(client.getSignal(), AuthFailed);
    client.clearAuthFailure();
    await assert.rejects(client.getSignal(), AuthFailed);
    assert.equal(count(router, "POST", "/api/user/login"), 2);
  });
});

test("an unsupported password_type is AuthFailed without a login attempt", async () => {
  await withRouter({ passwordType: 7 }, async (router, make) => {
    await assert.rejects(
      make().getSignal(),
      (e: unknown) =>
        e instanceof AuthFailed && e.reason === "unsupported-password-type",
    );
    assert.equal(count(router, "POST", "/api/user/login"), 0);
  });
});

test("an expired session logs in again once and retries the call", async () => {
  await withRouter({ expireAfter: 2 }, async (router, make) => {
    const client = make();
    await client.getSignal();
    const s = await client.getSignal();
    assert.equal(s.rsrp, -98);
    assert.equal(count(router, "POST", "/api/user/login"), 2);
    await client.getSignal();
    assert.equal(count(router, "POST", "/api/user/login"), 2);
  });
});

test("a session that dies between calls is re-established", async () => {
  await withRouter({}, async (router, make) => {
    const client = make();
    await client.getSignal();
    router.expireSession();
    await client.getOperator();
    assert.equal(count(router, "POST", "/api/user/login"), 2);
  });
});

test("a token error reloads the tokens once and retries once", async () => {
  await withRouter(
    { csrfFailOnce: ["device/signal"] },
    async (router, make) => {
      const s = await make().getSignal();
      assert.equal(s.rsrp, -98);
      assert.equal(count(router, "GET", "/"), 2);
      assert.equal(count(router, "GET", "/api/device/signal"), 2);
    },
  );
});

test("a token error that persists becomes a BadResponse after one retry", async () => {
  const f = fakeRouter({ "device/signal": () => error(125003) });
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  await assert.rejects(
    client.getSignal(),
    (e: unknown) => e instanceof BadResponse && e.code === 125003,
  );
  assert.equal(f.count("device/signal"), 2);
});

test("a session that keeps expiring does not loop", async () => {
  const f = fakeRouter({ "device/signal": () => error(100003) });
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  await assert.rejects(client.getSignal(), BadResponse);
  assert.equal(f.count("device/signal"), 2);
  assert.equal(f.count("user/login"), 2);
});

test("an unsupported endpoint is a BadResponse carrying the code", async () => {
  await withRouter({ unsupported: ["net/current-plmn"] }, async (_r, make) => {
    await assert.rejects(
      make().getOperator(),
      (e: unknown) => e instanceof BadResponse && e.code === 100002,
    );
  });
});

test("a refused connection is Unreachable", async () => {
  const router = (await startMockRouter({})) as Mock;
  const url = router.url;
  await router.close();
  const client = new RouterClient({
    baseUrl: url,
    username: "admin",
    password: "x",
    sleep: async () => {},
  });
  await assert.rejects(client.getSignal(), Unreachable);
});

test("a dropped connection is Unreachable", async () => {
  await withRouter({ destroy: ["device/signal"] }, async (_r, make) => {
    await assert.rejects(make().getSignal(), Unreachable);
  });
});

test("a request that never answers times out as Unreachable", async () => {
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      // AbortSignal.timeout timers are unref'd; a real socket would keep the
      // loop alive, so hold it open here.
      const keepAlive = setTimeout(() => {}, 5000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal?.reason);
      });
    });
  const client = new RouterClient({ ...fakeOpts, fetch: hang, timeoutMs: 20 });
  await assert.rejects(client.getSignal(), Unreachable);
});

test("a redirect is an error and is never followed", async () => {
  await withRouter({ redirect: ["device/signal"] }, async (router, make) => {
    await assert.rejects(make().getSignal(), BadResponse);
    assert.ok(!router.calls.some((c) => c.path.includes("evil")));
  });
});

test("a response that is not router XML is a BadResponse", async () => {
  const f = fakeRouter({
    "device/signal": () => ({
      status: 200,
      body: "<html><body>captive portal",
    }),
  });
  await assert.rejects(
    new RouterClient({ ...fakeOpts, fetch: f.fetch }).getSignal(),
    BadResponse,
  );
});

test("an HTTP error status without a router error code is a BadResponse", async () => {
  const f = fakeRouter({
    "device/signal": () => ({ status: 503, body: "busy" }),
  });
  await assert.rejects(
    new RouterClient({ ...fakeOpts, fetch: f.fetch }).getSignal(),
    BadResponse,
  );
});

test("a response that came from another origin is refused", async () => {
  const f = fakeRouter({});
  const wrapped: typeof fetch = async (url, init) => {
    const res = await f.fetch(url, init);
    if (String(url).includes("device/signal")) {
      Object.defineProperty(res, "url", {
        value: "http://evil.example/api/device/signal",
      });
    }
    return res;
  };
  await assert.rejects(
    new RouterClient({ ...fakeOpts, fetch: wrapped }).getSignal(),
    BadResponse,
  );
});

test("requests never overlap, even when issued concurrently", async () => {
  const f = fakeRouter({}, { delayMs: 5 });
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  await Promise.all([
    client.getSignal(),
    client.getOperator(),
    client.getConnection(),
    client.getSignal(),
  ]);
  assert.equal(f.maxConcurrent(), 1);
  assert.equal(f.count("user/login"), 1);
});

test("a failed call does not block the queue", async () => {
  const f = fakeRouter({
    "net/current-plmn": () => ({ status: 503, body: "x" }),
  });
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  const [a, b] = await Promise.allSettled([
    client.getOperator(),
    client.getSignal(),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
});

test("only the configured host is contacted", async () => {
  const f = fakeRouter({});
  const client = new RouterClient({
    ...fakeOpts,
    baseUrl: "http://user:pw@192.168.8.1/",
    fetch: f.fetch,
  });
  await client.getSignal();
  assert.ok(f.urls.length > 3);
  for (const u of f.urls) {
    assert.equal(new URL(u).origin, "http://192.168.8.1");
    assert.equal(new URL(u).username, "");
  }
  assert.throws(
    () => new RouterClient({ ...fakeOpts, baseUrl: "ftp://x" }),
    InvalidRequest,
  );
  assert.throws(
    () => new RouterClient({ ...fakeOpts, baseUrl: "nonsense" }),
    InvalidRequest,
  );
});

test("errors and logs never contain the password, tokens or cookies", async () => {
  const logs: string[] = [];
  const outcomes: string[] = [];
  await withRouter({ failLogin: true }, async (router, make) => {
    const client = make({ log: (m) => logs.push(m) });
    try {
      await client.getSignal();
    } catch (e) {
      outcomes.push(
        `${(e as Error).message} ${JSON.stringify(e)} ${(e as Error).stack}`,
      );
    }
    await withRouter({}, async (r2, make2) => {
      const ok = make2({ log: (m) => logs.push(m) });
      await ok.getSignal();
      await ok.logout();
      outcomes.push(r2.credentials.password);
    });
    outcomes.push(router.credentials.password);
  });
  const secrets = [
    "p4ssw0rd-XYZ",
    TOKENS.home,
    TOKENS.afterLogin,
    TOKENS.reload,
    COOKIE,
  ];
  const hay = [...logs, ...outcomes.slice(0, 1)].join("\n");
  for (const s of secrets) assert.ok(!hay.includes(s), `leaked ${s}`);
});

test("logout posts once, forgets the session, and the next call logs in again", async () => {
  await withRouter({}, async (router, make) => {
    const client = make();
    await client.logout();
    assert.equal(router.calls.length, 0);
    await client.getSignal();
    await client.logout();
    assert.equal(count(router, "POST", "/api/user/logout"), 1);
    await client.getSignal();
    assert.equal(count(router, "POST", "/api/user/login"), 2);
  });
});

test("logout swallows network errors", async () => {
  const f = fakeRouter({
    "user/logout": () => ({ status: 200, body: "", throws: true }),
  });
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  await client.getSignal();
  await client.logout();
});

const inbox = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    index: 40000 + i,
    phone: `+1555010${i}`,
    content: `msg ${i}`,
    date: "2023-10-06 12:00:00",
    stat: i % 2,
  }));

test("listSms pages on the router side", async () => {
  await withRouter({ sms: inbox(5) }, async (router, make) => {
    const client = make();
    const p1 = await client.listSms({ limit: 2 });
    assert.deepEqual(
      p1.map((m) => m.index),
      [40000, 40001],
    );
    const p3 = await client.listSms({ limit: 2, page: 3 });
    assert.deepEqual(
      p3.map((m) => m.index),
      [40004],
    );
    assert.deepEqual(await client.listSms({ limit: 2, page: 9 }), []);
    const req = router.calls
      .filter((c) => c.path === "/api/sms/sms-list")
      .at(1);
    assert.match(
      req?.body ?? "",
      /<PageIndex>3<\/PageIndex><ReadCount>2<\/ReadCount><BoxType>1<\/BoxType><SortType>0<\/SortType><Ascending>0<\/Ascending><UnreadPreferred>0<\/UnreadPreferred>/,
    );
    assert.equal(p1[1]?.read, true);
    assert.equal(p1[0]?.read, false);
  });
});

test("listSms defaults and clamps its paging options", async () => {
  await withRouter({ sms: inbox(1) }, async (router, make) => {
    const client = make();
    await client.listSms();
    await client.listSms({ limit: 1000, page: 0 });
    const bodies = router.calls
      .filter((c) => c.path === "/api/sms/sms-list")
      .map((c) => c.body);
    assert.match(
      bodies[0] ?? "",
      /<PageIndex>1<\/PageIndex><ReadCount>20<\/ReadCount>/,
    );
    assert.match(
      bodies[1] ?? "",
      /<PageIndex>1<\/PageIndex><ReadCount>50<\/ReadCount>/,
    );
  });
});

test("listSms on an empty inbox is an empty list", async () => {
  await withRouter({ sms: [] }, async (_r, make) => {
    assert.deepEqual(await make().listSms(), []);
  });
});

test("markRead and deleteSms act on the router's index", async () => {
  await withRouter({ sms: inbox(3) }, async (router, make) => {
    const client = make();
    await client.markRead(40000);
    assert.equal(router.sms?.find((m) => m.index === 40000)?.stat, 1);
    await client.deleteSms(40001);
    assert.deepEqual(
      router.sms?.map((m) => m.index),
      [40000, 40002],
    );
    await assert.rejects(client.deleteSms(99), BadResponse);
    await assert.rejects(client.markRead(1.5), InvalidRequest);
    await assert.rejects(client.deleteSms(-3), InvalidRequest);
  });
});

test("chooseSmsMode picks 7-bit only for the GSM 03.38 basic set", () => {
  for (const t of [
    "Hello, world 123!",
    "Grüße @£$¥ èé ñ",
    "Line1\nLine2",
    "Ä Ö Ñ Ü § ¿ ¡ ÆæßÅå ΔΦΓΛΩΠΨΣΘΞ",
  ]) {
    assert.equal(chooseSmsMode(t).mode, "gsm7", t);
  }
  for (const t of [
    "Price 5€",
    "a[b]",
    "{x}",
    "back\\slash",
    "a|b",
    "~",
    "^",
    "Привет",
    "日本",
    "hi 😀",
    "tab\t",
  ]) {
    assert.equal(chooseSmsMode(t).mode, "ucs2", t);
  }
  assert.deepEqual(chooseSmsMode("abc"), {
    mode: "gsm7",
    reserved: 1,
    length: 3,
  });
  assert.deepEqual(chooseSmsMode("Привет"), {
    mode: "ucs2",
    reserved: 0,
    length: 6,
  });
  assert.equal(chooseSmsMode("a😀").length, 3);
});

test("sendSms sends 7-bit text for GSM text and polls until done", async () => {
  await withRouter({}, async (router, make) => {
    const res = await make().sendSms("+15550123", "Hello & <you>");
    assert.deepEqual(res, { status: "sent", mode: "gsm7" });
    const [m] = router.sent;
    assert.equal(m?.phone, "+15550123");
    assert.equal(m?.content, "Hello & <you>");
    assert.equal(m?.reserved, 1);
    assert.equal(m?.length, 13);
    assert.match(
      m?.raw ?? "",
      /^<request><Index>-1<\/Index><Phones><Phone>\+15550123<\/Phone><\/Phones><Sca><\/Sca><Content>Hello &amp; &lt;you&gt;<\/Content><Length>13<\/Length><Reserved>1<\/Reserved><Date>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d<\/Date><\/request>$/,
    );
    assert.equal(count(router, "GET", "/api/sms/send-status"), 2);
  });
});

test("sendSms uses UCS2 for text outside the GSM basic set", async () => {
  await withRouter({}, async (router, make) => {
    const res = await make().sendSms("+15550123", "Привет €");
    assert.equal(res.mode, "ucs2");
    assert.equal(router.sent[0]?.reserved, 0);
    assert.equal(router.sent[0]?.content, "Привет €");
    assert.equal(router.sent[0]?.length, 8);
  });
});

test("sendSms stamps the Date from the injected clock", async () => {
  await withRouter({}, async (router, make) => {
    await make({ now: () => Date.UTC(2024, 1, 3, 4, 5, 6) }).sendSms(
      "+1555",
      "hi",
    );
    assert.match(
      router.sent[0]?.raw ?? "",
      new RegExp(
        `<Date>${formatRouterDate(Date.UTC(2024, 1, 3, 4, 5, 6))}</Date>`,
      ),
    );
  });
});

test("sendSms reports a failed send", async () => {
  const sendStatus = [
    "<?xml version='1.0'?><response><Phone></Phone><SucPhone></SucPhone><FailPhone>+1555</FailPhone><TotalCount>1</TotalCount><CurIndex>1</CurIndex></response>",
  ];
  await withRouter({ sendStatus }, async (_r, make) => {
    assert.deepEqual(await make().sendSms("+1555", "hi"), {
      status: "failed",
      mode: "gsm7",
    });
  });
});

test("sendSms gives up polling at the timeout with an unknown outcome", async () => {
  const sendStatus = [
    "<?xml version='1.0'?><response><Phone>+1555</Phone><SucPhone></SucPhone><FailPhone></FailPhone><TotalCount>1</TotalCount><CurIndex>0</CurIndex></response>",
  ];
  await withRouter({ sendStatus }, async (router, _make) => {
    let t = 0;
    const slept: number[] = [];
    const client = new RouterClient({
      baseUrl: router.url,
      ...router.credentials,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      sendPollIntervalMs: 1000,
      sendTimeoutMs: 5000,
    });
    assert.deepEqual(await client.sendSms("+1555", "hi"), {
      status: "unknown",
      mode: "gsm7",
    });
    assert.ok(slept.length >= 4 && slept.length <= 6);
    assert.ok(slept.every((ms) => ms === 1000));
  });
});

test("sendSms surfaces a router refusal as BadResponse and validates input locally", async () => {
  await withRouter({ sendSmsError: 100004 }, async (router, make) => {
    const client = make();
    await assert.rejects(
      client.sendSms("+1555", "hi"),
      (e: unknown) => e instanceof BadResponse && e.code === 100004,
    );
    const before = router.calls.length;
    for (const [to, text] of [
      ["", "hi"],
      ["abc", "hi"],
      ["+1555", ""],
      ["+1555<", "hi"],
      ["+1555", "bad\u0000char"],
    ] as const) {
      await assert.rejects(
        client.sendSms(to, text),
        InvalidRequest,
        `${to}|${text}`,
      );
    }
    assert.equal(router.calls.length, before);
  });
});

test("an SMS is not stuck behind a slow poll: queue order is preserved", async () => {
  await withRouter({ sms: inbox(1) }, async (router, make) => {
    const client = make();
    const order: string[] = [];
    await Promise.all([
      client.sendSms("+1555", "hi").then(() => order.push("send")),
      client.listSms().then(() => order.push("list")),
    ]);
    assert.deepEqual(order, ["send", "list"]);
    const paths = router.calls.map((c) => c.path);
    assert.ok(
      paths.lastIndexOf("/api/sms/send-status") <
        paths.indexOf("/api/sms/sms-list"),
    );
  });
});

test("cesu8Encode writes astral characters as surrogate pairs, cesu8Fix undoes it", () => {
  const bytes = cesu8Encode("a😀b");
  assert.deepEqual(
    [...bytes],
    [0x61, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0x62],
  );
  assert.deepEqual([...cesu8Encode("é€")], [...new TextEncoder().encode("é€")]);
  const fixed = cesu8Fix(bytes);
  assert.equal(new TextDecoder().decode(fixed), "a😀b");
  assert.deepEqual(
    [...cesu8Fix(new TextEncoder().encode("plain é"))],
    [...new TextEncoder().encode("plain é")],
  );
});

test("UCS2 text with an emoji is sent CESU-8 encoded, and CESU-8 answers are decoded", async () => {
  const bodies: Uint8Array[] = [];
  const f = fakeRouter(
    {
      "sms/send-sms": () => ({ status: 200, body: "<response>OK</response>" }),
      "sms/send-status": () => ({
        status: 200,
        body: "<response><Phone></Phone><SucPhone>+1</SucPhone><FailPhone></FailPhone><TotalCount>1</TotalCount><CurIndex>1</CurIndex></response>",
      }),
      "sms/sms-list": () => ({
        status: 200,
        bytes: cesu8Encode(
          "<response><Count>1</Count><Messages><Message><Smstat>0</Smstat><Index>1</Index><Phone>+1</Phone><Content>hi 😀</Content><Date>2023-10-06 12:00:00</Date></Message></Messages></response>",
        ),
      }),
    },
    { capture: (b) => bodies.push(b) },
  );
  const client = new RouterClient({ ...fakeOpts, fetch: f.fetch });
  await client.sendSms("+15550123", "hi 😀");
  const sentBody = bodies.find((b) =>
    Buffer.from(b).includes(Buffer.from([0xed, 0xa0, 0xbd])),
  );
  assert.ok(sentBody, "request body should hold the CESU-8 surrogate sequence");
  const [m] = await client.listSms();
  assert.equal(m?.text, "hi 😀");
});

// ---- fake fetch -----------------------------------------------------------

const fakeOpts = {
  baseUrl: "http://192.168.8.1",
  username: "admin",
  password: "p4ssw0rd-XYZ",
  sleep: async () => {},
};

interface FakeReply {
  status: number;
  body?: string;
  bytes?: Uint8Array;
  throws?: boolean;
  headers?: Record<string, string>;
}
const error = (code: number): FakeReply => ({
  status: 200,
  body: `<?xml version="1.0"?><error><code>${code}</code><message></message></error>`,
});

const DEFAULTS: Record<string, FakeReply> = {
  "user/state-login": {
    status: 200,
    body: "<response><State>-1</State><password_type>4</password_type></response>",
  },
  "user/login": {
    status: 200,
    body: "<response>OK</response>",
    headers: { __RequestVerificationToken: "T-AFTER" },
  },
  "user/logout": { status: 200, body: "<response>OK</response>" },
  "device/signal": {
    status: 200,
    body: "<response><rsrp>-98dBm</rsrp></response>",
  },
  "net/current-plmn": {
    status: 200,
    body: "<response><FullName>X</FullName></response>",
  },
  "monitoring/status": {
    status: 200,
    body: "<response><ConnectionStatus>901</ConnectionStatus></response>",
  },
};

function fakeRouter(
  handlers: Record<string, () => FakeReply>,
  o: { delayMs?: number; capture?: (b: Uint8Array) => void } = {},
) {
  const seen: string[] = [];
  const urls: string[] = [];
  let active = 0;
  let max = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    active += 1;
    max = Math.max(max, active);
    try {
      const url = String(input);
      urls.push(url);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (init?.body && o.capture) o.capture(init.body as Uint8Array);
      const path = new URL(url).pathname;
      if (path === "/") {
        return new Response(
          '<html><head><meta name="csrf_token" content="T-HOME"/></head></html>',
          { status: 200, headers: { "Set-Cookie": "SessionID=C; path=/" } },
        );
      }
      const ep = path.replace(/^\/api\//, "");
      seen.push(ep);
      const reply = handlers[ep]?.() ?? DEFAULTS[ep];
      if (!reply) return new Response("", { status: 404 });
      if (reply.throws) throw new TypeError("fetch failed");
      return new Response(
        (reply.bytes as BodyInit | undefined) ?? reply.body ?? "",
        {
          status: reply.status,
          headers: reply.headers,
        },
      );
    } finally {
      active -= 1;
    }
  };
  return {
    fetch: fetchFn,
    count: (ep: string) => seen.filter((e) => e === ep).length,
    maxConcurrent: () => max,
    urls,
  };
}

test("108003 (another session is logged in) is transient: not latched, and retried later", async () => {
  await withRouter(
    { failLogin: true, loginErrorCode: 108003 },
    async (router, make) => {
      const client = make();
      await assert.rejects(
        client.getSignal(),
        (e: unknown) => e instanceof SessionBusy && !(e instanceof AuthFailed),
      );
      assert.equal(client.authFailed, false);
      await assert.rejects(client.getSignal(), SessionBusy);
      assert.equal(count(router, "POST", "/api/user/login"), 2);
    },
  );
});

test("only the newest tokens are kept, so a POST never sends a stale one", async () => {
  await withRouter({ rotateTokens: true }, async (router, make) => {
    const client = make();
    for (let i = 0; i < 12; i += 1) await client.getSignal();
    await client.sendSms("+1555", "hi");
    const calls = router.calls as unknown as {
      path: string;
      token: string;
      issued?: string;
    }[];
    const idx = calls.findIndex((c) => c.path === "/api/sms/send-sms");
    assert.ok(idx > 0);
    const previousIssued = calls[idx - 1]?.issued;
    assert.ok(
      previousIssued,
      "the mock issued a token on the previous response",
    );
    assert.equal(calls[idx]?.token, previousIssued);
  });
});

test("cesu8Fix returns the very same bytes when there is nothing to fix", () => {
  const plain = new TextEncoder().encode("<response>hello wörld</response>");
  assert.equal(cesu8Fix(plain), plain);
});

test("cesu8Encode of text without surrogates is plain UTF-8", () => {
  const text = "Hello wörld € 123";
  assert.deepEqual(
    Array.from(cesu8Encode(text)),
    Array.from(new TextEncoder().encode(text)),
  );
});

test("sendSms stamps the Date in the server's local time, the way router dates are read", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "Pacific/Auckland";
  try {
    const at = Date.UTC(2024, 1, 3, 4, 5, 6);
    await withRouter({}, async (router, make) => {
      await make({ now: () => at }).sendSms("+1555", "hi");
      const expected = formatRouterDate(at);
      // Setting TZ at run time does not work on every platform (notably
      // Windows); only insist the zone differs from UTC where it took effect.
      if (new Date(at).getTimezoneOffset() !== 0) {
        assert.notEqual(
          expected,
          "2024-02-03 04:05:06",
          "the zone really differs from UTC",
        );
      }
      assert.match(
        router.sent[0]?.raw ?? "",
        new RegExp(`<Date>${expected}</Date>`),
      );
      assert.equal(routerDateToIso(expected), new Date(at).toISOString());
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = previous;
  }
});

test("impossible router dates are rejected instead of rolling over", () => {
  for (const bad of [
    "2024-13-45 25:61:61",
    "2023-02-30 10:00:00",
    "2024-04-31 00:00:00",
    "2024-01-01 24:00:00",
    "2024-01-01 12:60:00",
  ]) {
    assert.equal(routerDateToIso(bad), undefined, bad);
  }
  assert.ok(routerDateToIso("2024-02-29 12:30:45"));
  assert.equal(routerDateToIso("2023-02-29 12:30:45"), undefined);
});

test("getSmsCounts reads the router's own inbox and unread totals", async () => {
  const sms = [0, 1, 2].map((i) => ({
    index: 40000 + i,
    phone: "DIGI",
    content: "hi",
    date: "2026-10-05 17:45:11",
    stat: i === 0 ? 1 : 0,
  }));
  await withRouter({ sms }, async (_router, make) => {
    assert.deepEqual(await make().getSmsCounts(), { inbox: 3, unread: 2 });
  });
});

test("listSms asks for the page it is given", async () => {
  const sms = Array.from({ length: 45 }, (_, i) => ({
    index: 40000 + i,
    phone: "DIGI",
    content: "hi",
    date: "2026-10-05 17:45:11",
  }));
  await withRouter({ sms }, async (_router, make) => {
    const client = make();
    assert.equal((await client.listSms()).length, 20);
    assert.equal((await client.listSms({ page: 3 })).length, 5);
  });
});

test("listSmsPage reports the unread delivery reports it left out", async () => {
  const sms = [
    {
      index: 3,
      phone: "+491700000000",
      content: "",
      date: "2026-10-05 17:45:11",
      stat: 0,
      type: 7,
    },
    {
      index: 2,
      phone: "+491700000000",
      content: "hi",
      date: "2026-10-05 17:44:11",
      stat: 0,
    },
  ];
  await withRouter({ sms }, async (_router, make) => {
    const page = await make().listSmsPage();
    assert.equal(page.unreadReports, 1);
    assert.deepEqual(
      page.messages.map((m) => m.index),
      [2],
    );
  });
});
