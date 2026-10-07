import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerAPI } from "@signalk/server-api";
import createPlugin, { PLUGIN_ID } from "../src/index.ts";
import type { Req, Res } from "../src/routes.ts";
import type { Runtime } from "../src/runtime.ts";

type Handler = (req: Req, res: Res) => unknown;

function fakeApp() {
  const log = {
    errors: [] as string[],
    statuses: [] as string[],
    providers: 0,
  };
  const app = {
    setPluginStatus: (m: string) => log.statuses.push(m),
    setPluginError: (m: string) => log.errors.push(m),
    error: (m: string) => log.errors.push(m),
    debug: () => {},
    handleMessage: () => {},
    getDataDirPath: () => "/tmp/signalk-huawei-test-data",
    registerResourceProvider: () => {
      log.providers += 1;
    },
  } as unknown as ServerAPI;
  return { app, log };
}

function fakeRouter() {
  const handlers = new Map<string, Handler>();
  const reg =
    (m: string) =>
    (path: string, ...hs: Handler[]) => {
      handlers.set(`${m} ${path}`, hs.at(-1) as Handler);
    };
  return {
    handlers,
    router: {
      get: reg("GET"),
      post: reg("POST"),
      delete: reg("DELETE"),
      access: () => ({ get: reg("GET") }),
    },
  };
}

function fakeRuntimeFactory() {
  const created: {
    config: unknown;
    dataDir: string;
    started: number;
    stopped: number;
  }[] = [];
  const factory = (opts: { config: unknown; dataDir: string }): Runtime => {
    const rec = {
      config: opts.config,
      dataDir: opts.dataDir,
      started: 0,
      stopped: 0,
    };
    created.push(rec);
    return {
      start: async () => {
        rec.started += 1;
      },
      stop: async () => {
        rec.stopped += 1;
      },
      pollNow: async () => {},
      status: () => ({ link: "ok", sms: { unread: 3 } }),
      routeDeps: () => ({
        getStatus: () => ({ link: "ok", sms: { unread: 3 } }),
        sms: { list: () => [], markRead: () => true, remove: () => true },
        actions: {
          send: async () => {},
          markRead: async () => {},
          remove: async () => {},
        },
        resetPlan: () => {},
        isAdmin: () => true,
      }),
    } as unknown as Runtime;
  };
  return { factory, created };
}

const call = async (h: Handler | undefined) => {
  assert.ok(h, "route not registered");
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  await h({ query: {}, params: {}, body: {} }, res);
  return res;
};

const VALID = { password: "pw", routerUrl: "http://192.168.8.1" };

test("the plugin exposes id, name and a schema that requires the password", () => {
  const { app } = fakeApp();
  const plugin = createPlugin(app);
  assert.equal(plugin.id, PLUGIN_ID);
  assert.ok(plugin.name.length > 0);
  const schema = (
    typeof plugin.schema === "function" ? plugin.schema() : plugin.schema
  ) as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.ok(schema.required.includes("password"));
  assert.ok(schema.properties.plan);
});

test("without a password the plugin says it is waiting for settings, as a status and not an error", async () => {
  const { app, log } = fakeApp();
  const { factory, created } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  plugin.start({}, () => {});
  assert.equal(created.length, 0);
  assert.equal(
    log.errors.length,
    0,
    "a fresh install must not show a red error",
  );
  assert.ok(log.statuses.some((m) => /password/i.test(m)));
  await plugin.stop();
});

test("a valid configuration builds and starts a runtime in the data directory", async () => {
  const { app } = fakeApp();
  const { factory, created } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  plugin.start(VALID, () => {});
  assert.equal(created.length, 1);
  assert.equal(created[0]?.dataDir, "/tmp/signalk-huawei-test-data");
  assert.equal(
    (created[0] as { config: { routerUrl: string } }).config.routerUrl,
    "http://192.168.8.1",
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(created[0]?.started, 1);
  await plugin.stop();
  assert.equal(created[0]?.stopped, 1);
});

test("routes answer 503 until the plugin runs and again after it stops", async () => {
  const { app } = fakeApp();
  const { factory } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  const { router, handlers } = fakeRouter();
  plugin.registerWithRouter?.(router as never);
  assert.ok(handlers.has("GET /status"));
  assert.ok(handlers.has("POST /sms"));
  assert.equal((await call(handlers.get("GET /status"))).statusCode, 503);

  plugin.start(VALID, () => {});
  const running = await call(handlers.get("GET /status"));
  assert.equal(running.statusCode, 200);
  assert.deepEqual(running.body, { link: "ok", sms: { unread: 3 } });

  await plugin.stop();
  assert.equal((await call(handlers.get("GET /status"))).statusCode, 503);
  assert.equal((await call(handlers.get("POST /plan/reset"))).statusCode, 503);
});

test("restarting builds a fresh runtime", async () => {
  const { app } = fakeApp();
  const { factory, created } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  plugin.start(VALID, () => {});
  await plugin.stop();
  plugin.start({ ...VALID, signalPollSeconds: 20 }, () => {});
  assert.equal(created.length, 2);
  assert.equal(
    (created[1] as { config: { signalPollSeconds: number } }).config
      .signalPollSeconds,
    20,
  );
  await plugin.stop();
  assert.equal(created[0]?.stopped, 1);
  assert.equal(created[1]?.stopped, 1);
});

test("a runtime that fails to start is reported, not thrown", async () => {
  const { app, log } = fakeApp();
  const factory = () =>
    ({
      start: async () => {
        throw new Error("disk full");
      },
      stop: async () => {},
    }) as unknown as Runtime;
  const plugin = createPlugin(app, { createRuntime: factory });
  plugin.start(VALID, () => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(log.errors.some((e) => /disk full/.test(e)));
  await plugin.stop();
});

test("the Status Tiles example set is offered while the plugin runs", async () => {
  const { app, log } = fakeApp();
  const { factory } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  plugin.start(VALID, () => {});
  assert.equal(log.providers, 1);
  await plugin.stop();
});

test("routes still register on a server whose router has no access()", async () => {
  const { app } = fakeApp();
  const { factory } = fakeRuntimeFactory();
  const plugin = createPlugin(app, { createRuntime: factory });
  const handlers = new Map<string, Handler>();
  const reg =
    (m: string) =>
    (path: string, ...hs: Handler[]) => {
      handlers.set(`${m} ${path}`, hs.at(-1) as Handler);
    };
  const oldRouter = {
    get: reg("GET"),
    post: reg("POST"),
    delete: reg("DELETE"),
  };
  assert.doesNotThrow(() => plugin.registerWithRouter?.(oldRouter as never));
  for (const key of [
    "GET /status",
    "GET /sms",
    "POST /sms",
    "POST /sms/:id/read",
    "DELETE /sms/:id",
    "POST /plan/reset",
  ]) {
    assert.ok(handlers.has(key), key);
  }
  plugin.start(VALID, () => {});
  assert.equal((await call(handlers.get("GET /status"))).statusCode, 200);
  await plugin.stop();
});
