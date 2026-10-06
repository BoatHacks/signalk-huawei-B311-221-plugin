import assert from "node:assert/strict";
import { test } from "node:test";
import type { Req, Res, RoutesDeps } from "../src/routes.ts";
import { createAdminCheck, registerRoutes } from "../src/routes.ts";
import type { SmsMessage, StatusSnapshot } from "../src/types.ts";

type Handler = (req: Req, res: Res) => unknown;
interface Registration {
  method: string;
  path: string;
  level: string;
  handler: Handler;
}

function fakeRouter() {
  const regs: Registration[] = [];
  const add =
    (level: string) =>
    (method: string) =>
    (path: string, ...handlers: Handler[]) => {
      regs.push({ method, path, level, handler: handlers.at(-1) as Handler });
      return undefined;
    };
  const plain = add("admin");
  const scoped = (level: string) => ({
    get: add(level)("GET"),
    post: add(level)("POST"),
    delete: add(level)("DELETE"),
  });
  const router = {
    get: plain("GET"),
    post: plain("POST"),
    delete: plain("DELETE"),
    access: (level: "readonly" | "readwrite") => scoped(level),
  };
  return { router, regs };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const MSG = (n: number): SmsMessage => ({
  id: `id-${n}`,
  index: 40000 + n,
  direction: "in",
  peer: "+358401234567",
  text: `m${n}`,
  timestamp: "2026-10-05T10:00:00Z",
  read: false,
});

const SNAPSHOT: StatusSnapshot = { link: "ok", sms: { unread: 1 } };

function setup(over: Partial<RoutesDeps> = {}) {
  const { router, regs } = fakeRouter();
  const calls: string[] = [];
  let clock = 1_000_000;
  const stored = [MSG(1), MSG(2)];
  const deps: RoutesDeps = {
    getStatus: () => SNAPSHOT,
    sms: {
      list: () => stored.map((m) => ({ ...m })),
      markRead: (id) => {
        calls.push(`store.markRead ${id}`);
        return true;
      },
      remove: (id) => {
        calls.push(`store.remove ${id}`);
        return true;
      },
    },
    actions: {
      send: async (to, text) => {
        calls.push(`send ${to} ${text}`);
      },
      markRead: async (index) => {
        calls.push(`router.markRead ${index}`);
      },
      remove: async (index) => {
        calls.push(`router.remove ${index}`);
      },
    },
    resetPlan: () => {
      calls.push("resetPlan");
    },
    isAdmin: () => true,
    now: () => clock,
    log: () => {},
    ...over,
  };
  registerRoutes(router, deps);
  const find = (method: string, path: string) => {
    const r = regs.find((x) => x.method === method && x.path === path);
    assert.ok(r, `${method} ${path} not registered`);
    return r.handler;
  };
  return { regs, calls, find, advance: (ms: number) => (clock += ms) };
}

const call = async (h: Handler, req: object = {}) => {
  const res = fakeRes();
  await h({ query: {}, params: {}, body: {}, ...req }, res);
  return res;
};

test("reads are registered readonly, writes get no access() so the server makes them admin-only", () => {
  const { regs } = setup();
  const level = (m: string, p: string) =>
    regs.find((r) => r.method === m && r.path === p)?.level;
  assert.equal(level("GET", "/status"), "readonly");
  assert.equal(level("GET", "/sms"), "readonly");
  assert.equal(level("POST", "/sms"), "admin");
  assert.equal(level("POST", "/sms/:id/read"), "admin");
  assert.equal(level("DELETE", "/sms/:id"), "admin");
  assert.equal(level("POST", "/plan/reset"), "admin");
  assert.equal(regs.length, 6);
});

test("GET /status returns the snapshot", async () => {
  const { find } = setup();
  const res = await call(find("GET", "/status"));
  assert.deepEqual(res.body, SNAPSHOT);
});

test("GET /sms returns messages and clamps the limit", async () => {
  const { find } = setup();
  const all = await call(find("GET", "/sms"));
  assert.equal((all.body as { messages: unknown[] }).messages.length, 2);
  const one = await call(find("GET", "/sms"), { query: { limit: "1" } });
  assert.equal((one.body as { messages: unknown[] }).messages.length, 1);
  for (const limit of ["abc", "-4", "0", "9999999"]) {
    const res = await call(find("GET", "/sms"), { query: { limit } });
    assert.equal(res.statusCode, 200, limit);
  }
});

test("POST /sms sends a normalised number", async () => {
  const { find, calls } = setup();
  const res = await call(find("POST", "/sms"), {
    body: { to: "+358 40-123 4567", text: "Hello" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ["send +358401234567 Hello"]);
});

test("POST /sms rejects bad input without touching the router", async () => {
  const { find, calls } = setup();
  const bad = [
    {},
    { to: "+358401234567" },
    { text: "x" },
    { to: 5, text: "x" },
    { to: "+358401234567", text: "" },
    { to: "+358401234567", text: "   " },
    { to: "+358401234567", text: 5 },
    { to: "abc", text: "x" },
    { to: "+12", text: "x" },
    { to: "+358401234567; DROP", text: "x" },
    { to: "+358401234567", text: "x".repeat(501) },
  ];
  for (const body of bad) {
    const res = await call(find("POST", "/sms"), { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(typeof (res.body as { error: string }).error === "string");
  }
  assert.deepEqual(calls, []);
});

test("sending is rate limited and recovers", async () => {
  const { find, calls, advance } = setup();
  const send = () =>
    call(find("POST", "/sms"), { body: { to: "+358401234567", text: "hi" } });
  for (let i = 0; i < 5; i += 1) assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 429);
  assert.equal(calls.length, 5);
  advance(61_000);
  assert.equal((await send()).statusCode, 200);
});

test("a router failure becomes a generic 502 that does not leak details", async () => {
  const { find } = setup({
    actions: {
      send: async () => {
        throw new Error("password wrong at http://192.168.8.1 token=abc");
      },
      markRead: async () => {},
      remove: async () => {},
    },
  });
  const res = await call(find("POST", "/sms"), {
    body: { to: "+358401234567", text: "hi" },
  });
  assert.equal(res.statusCode, 502);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("password"));
  assert.ok(!text.includes("192.168"));
  assert.ok(!text.includes("token"));
});

test("write routes refuse non-admins before doing anything", async () => {
  const { find, calls } = setup({ isAdmin: () => false });
  const reqs: [string, string, object][] = [
    ["POST", "/sms", { body: { to: "+358401234567", text: "hi" } }],
    ["POST", "/sms/:id/read", { params: { id: "id-1" } }],
    ["DELETE", "/sms/:id", { params: { id: "id-1" } }],
    ["POST", "/plan/reset", {}],
  ];
  for (const [m, p, req] of reqs) {
    const res = await call(find(m, p), req);
    assert.equal(res.statusCode, 403, `${m} ${p}`);
  }
  assert.deepEqual(calls, []);
});

test("read routes do not require admin", async () => {
  const { find } = setup({ isAdmin: () => false });
  assert.equal((await call(find("GET", "/status"))).statusCode, 200);
  assert.equal((await call(find("GET", "/sms"))).statusCode, 200);
});

test("mark read and delete go to the router first, then the local store", async () => {
  const { find, calls } = setup();
  const read = await call(find("POST", "/sms/:id/read"), {
    params: { id: "id-1" },
  });
  assert.equal(read.statusCode, 200);
  const del = await call(find("DELETE", "/sms/:id"), {
    params: { id: "id-2" },
  });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(calls, [
    "router.markRead 40001",
    "store.markRead id-1",
    "router.remove 40002",
    "store.remove id-2",
  ]);
});

test("an unknown message id is a 404", async () => {
  const { find, calls } = setup();
  for (const [m, p] of [
    ["POST", "/sms/:id/read"],
    ["DELETE", "/sms/:id"],
  ] as const) {
    const res = await call(find(m, p), { params: { id: "nope" } });
    assert.equal(res.statusCode, 404);
  }
  assert.deepEqual(calls, []);
});

test("if the router refuses, the local store is left alone", async () => {
  const { find, calls } = setup({
    actions: {
      send: async () => {},
      markRead: async () => {
        throw new Error("boom");
      },
      remove: async () => {
        throw new Error("boom");
      },
    },
  });
  const res = await call(find("DELETE", "/sms/:id"), {
    params: { id: "id-1" },
  });
  assert.equal(res.statusCode, 502);
  assert.ok(!calls.some((c) => c.startsWith("store.")));
});

test("POST /plan/reset resets the plan", async () => {
  const { find, calls } = setup();
  const res = await call(find("POST", "/plan/reset"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ["resetPlan"]);
});

test("the body is read from the stream when the server did not parse it", async () => {
  const { find, calls } = setup();
  const { Readable } = await import("node:stream");
  const stream = Object.assign(
    Readable.from([Buffer.from('{"to":"+358401234567","text":"streamed"}')]),
    {
      query: {},
      params: {},
    },
  );
  const res = fakeRes();
  await find("POST", "/sms")(stream, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ["send +358401234567 streamed"]);
});

test("an oversized or malformed stream body is rejected", async () => {
  const { find } = setup();
  const { Readable } = await import("node:stream");
  const mk = (data: string) =>
    Object.assign(Readable.from([Buffer.from(data)]), {
      query: {},
      params: {},
    });
  const big = fakeRes();
  await find("POST", "/sms")(
    mk(`{"to":"+358401234567","text":"${"x".repeat(20_000)}"}`),
    big,
  );
  assert.equal(big.statusCode, 413);
  const bad = fakeRes();
  await find("POST", "/sms")(mk("{not json"), bad);
  assert.equal(bad.statusCode, 400);
});

test("admin check: security disabled means unrestricted, enabled means admin only", () => {
  const req = {};
  assert.equal(createAdminCheck({})(req), true);
  assert.equal(
    createAdminCheck({ securityStrategy: { isDummy: () => true } })(req),
    true,
  );
  const strict = (admin: boolean | undefined) =>
    createAdminCheck({
      securityStrategy: {
        isDummy: () => false,
        hasAdminAccess: admin === undefined ? undefined : () => admin,
      },
    });
  assert.equal(strict(true)(req), true);
  assert.equal(strict(false)(req), false);
  assert.equal(strict(undefined)(req), false);
});
