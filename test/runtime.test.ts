import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeApp, RuntimeOptions } from "../src/runtime.ts";
import { createRuntime } from "../src/runtime.ts";
import type { PluginConfig, SmsMessage } from "../src/types.ts";
import { createFakeTimers } from "./helpers/fake-timers.ts";
// @ts-expect-error plain JS test helper
import { startMockRouter } from "./helpers/mock-router.mjs";

const xml = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;
const traffic = (up: number, down: number) =>
  xml(`<TotalUpload>${up}</TotalUpload><TotalDownload>${down}</TotalDownload>`);
const message = (index: number, phone: string, text: string, date: string) =>
  `<Message><Smstat>0</Smstat><Index>${index}</Index><Phone>${phone}</Phone><Content>${text}</Content><Date>${date}</Date></Message>`;
const smsList = (...msgs: string[]) =>
  xml(`<Count>${msgs.length}</Count><Messages>${msgs.join("")}</Messages>`);

interface Entry {
  path: string;
  value: unknown;
}

function fakeApp() {
  const deltas: {
    context: string;
    updates: { values?: Entry[]; meta?: Entry[] }[];
  }[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  const app: RuntimeApp = {
    handleMessage: (_id, delta) =>
      deltas.push(delta as (typeof deltas)[number]),
    setPluginStatus: (s) => statuses.push(s),
    setPluginError: (s) => errors.push(s),
    error: (s) => errors.push(s),
    debug: () => {},
  };
  const values = (path: string) =>
    deltas
      .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
      .filter((e) => e.path === path)
      .map((e) => e.value);
  const states = (path: string) =>
    values(path).map((v) => (v as { state?: string }).state);
  return { app, deltas, errors, statuses, values, states };
}

async function settle(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Waits until the three initial polls (signal, traffic, SMS) have all published. */
async function initialPollsDone(f: ReturnType<typeof fakeApp>) {
  await settle(
    () =>
      f.values("networking.lte.rsrp").length > 0 &&
      f.values("networking.lte.usage.rx").length > 0 &&
      f.values("networking.lte.sms.unread").length > 0,
  );
}

const baseConfig = (
  url: string,
  over: Partial<PluginConfig> = {},
): PluginConfig => ({
  routerUrl: url,
  username: "admin",
  password: "p4ssw0rd-XYZ",
  signalPollSeconds: 10,
  trafficPollSeconds: 60,
  smsPollSeconds: 60,
  notifyNewSms: true,
  plan: {
    totalBytes: 1_000_000_000,
    resetDay: 1,
    warnRatio: 0.8,
    alarmRatio: 0.95,
  },
  ...over,
});

async function boot(
  routerOpts: object = {},
  cfg: Partial<PluginConfig> = {},
  dataDir?: string,
  clientOptions?: RuntimeOptions["clientOptions"],
) {
  const extra: Record<string, string> = {
    "monitoring/traffic-statistics": traffic(0, 0),
    "sms/sms-list": smsList(
      message(40001, "+358401234567", "first", "2023-10-06 12:00:00"),
    ),
    ...((routerOpts as { extra?: Record<string, string> }).extra ?? {}),
  };
  const router = await startMockRouter({ ...routerOpts, extra });
  const f = fakeApp();
  const timers = createFakeTimers();
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "runtime-test-"));
  const runtime = createRuntime({
    app: f.app,
    config: baseConfig(router.url, {
      password: router.credentials.password,
      ...cfg,
    }),
    dataDir: dir,
    timers,
    ...(clientOptions ? { clientOptions } : {}),
  });
  return { router, extra, f, timers, dir, runtime };
}

test("start sends meta first, then publishes signal, operator, link and status", async () => {
  const { router, f, runtime } = await boot();
  try {
    await runtime.start();
    await settle(
      () =>
        f.values("networking.lte.routerLink").includes("ok") &&
        f.values("networking.lte.rsrp").length > 0,
    );
    assert.ok(f.deltas[0]?.updates[0]?.meta, "meta is the first delta");
    assert.equal(f.values("networking.lte.rsrp")[0], -98);
    assert.equal(f.values("networking.lte.sinr")[0], 9);
    assert.equal(f.values("networking.lte.connectionText")[0], "Telia");
    const status = runtime.status();
    assert.equal(status.link, "ok");
    assert.equal(status.signal?.rsrp, -98);
    assert.equal(status.operator?.name, "Telia");
    assert.ok(status.updatedAt);
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("the plan raises a warning and then an alarm, once per change", async () => {
  const { router, extra, f, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    extra["monitoring/traffic-statistics"] = traffic(0, 850_000_000);
    await runtime.pollNow("traffic");
    await settle(
      () => f.states("notifications.networking.lte.plan").length >= 1,
    );
    extra["monitoring/traffic-statistics"] = traffic(0, 970_000_000);
    await runtime.pollNow("traffic");
    await runtime.pollNow("traffic");
    await settle(
      () => f.states("notifications.networking.lte.plan").length >= 2,
    );
    assert.deepEqual(f.states("notifications.networking.lte.plan"), [
      "warn",
      "alarm",
    ]);
    const ratios = f.values("networking.lte.plan.usedRatio") as number[];
    assert.ok(Math.abs((ratios.at(-1) as number) - 0.97) < 0.001);
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("usage survives a stop and start", async () => {
  const a = await boot();
  try {
    await a.runtime.start();
    await initialPollsDone(a.f);
    a.extra["monitoring/traffic-statistics"] = traffic(0, 500_000_000);
    await a.runtime.pollNow("traffic");
    await settle(
      () =>
        (a.f.values("networking.lte.plan.usedRatio").at(-1) as number) > 0.49,
    );
    await a.runtime.stop();

    const b = await boot(
      { extra: { "monitoring/traffic-statistics": traffic(0, 500_000_000) } },
      {},
      a.dir,
    );
    try {
      await b.runtime.start();
      await settle(
        () => b.f.values("networking.lte.plan.usedRatio").length > 0,
      );
      const first = b.f.values("networking.lte.plan.usedRatio")[0] as number;
      assert.ok(Math.abs(first - 0.5) < 0.001, `ratio after restart: ${first}`);
    } finally {
      await b.runtime.stop();
      await b.router.close();
    }
  } finally {
    await a.router.close();
  }
});

test("rejected credentials end in auth-failed after a single login attempt", async () => {
  const { router, f, timers, runtime } = await boot({ failLogin: true });
  try {
    await runtime.start();
    await settle(() =>
      f.values("networking.lte.routerLink").includes("auth-failed"),
    );
    assert.ok(f.errors.length > 0);
    assert.ok(!f.errors.join(" ").includes("p4ssw0rd"));
    await timers.advance(6 * 60 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 50));
    const logins = router.calls.filter(
      (c: { path: string }) => c.path === "/api/user/login",
    );
    assert.equal(logins.length, 1);
    assert.equal(runtime.status().link, "auth-failed");
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("a router that goes away flips the link without blanking the last values", async () => {
  const { router, f, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    await router.close();
    await runtime.pollNow("signal");
    await settle(() =>
      f.values("networking.lte.routerLink").includes("unreachable"),
    );
    assert.ok(f.states("notifications.networking.lte.link").includes("warn"));
    assert.ok(!f.values("networking.lte.rsrp").includes(null));
    assert.equal(runtime.status().signal?.rsrp, -98);
  } finally {
    await runtime.stop();
  }
});

test("a new SMS raises one notification, and a restart does not repeat it", async () => {
  const a = await boot();
  try {
    await a.runtime.start();
    await initialPollsDone(a.f);
    const smsNotes = (f: ReturnType<typeof fakeApp>) =>
      f.deltas
        .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
        .filter((e) => e.path.startsWith("notifications.networking.lte.sms."));
    assert.equal(
      smsNotes(a.f).length,
      0,
      "existing messages are not announced on first run",
    );

    a.extra["sms/sms-list"] = smsList(
      message(40002, "+358409999999", "second", "2023-10-07 08:00:00"),
      message(40001, "+358401234567", "first", "2023-10-06 12:00:00"),
    );
    await a.runtime.pollNow("sms");
    await settle(() => smsNotes(a.f).length === 1);
    await a.runtime.pollNow("sms");
    assert.equal(smsNotes(a.f).length, 1);
    await a.runtime.stop();

    const b = await boot(
      { extra: { "sms/sms-list": a.extra["sms/sms-list"] } },
      {},
      a.dir,
    );
    try {
      await b.runtime.start();
      await initialPollsDone(b.f);
      assert.equal(smsNotes(b.f).length, 0);
    } finally {
      await b.runtime.stop();
      await b.router.close();
    }
  } finally {
    await a.router.close();
  }
});

test("SMS notifications can be switched off", async () => {
  const { router, extra, f, runtime } = await boot({}, { notifyNewSms: false });
  try {
    await runtime.start();
    await initialPollsDone(f);
    extra["sms/sms-list"] = smsList(
      message(40002, "+358409999999", "second", "2023-10-07 08:00:00"),
      message(40001, "+358401234567", "first", "2023-10-06 12:00:00"),
    );
    await runtime.pollNow("sms");
    await new Promise((r) => setTimeout(r, 50));
    const notes = f.deltas
      .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
      .filter((e) => e.path.includes("sms."));
    assert.equal(
      notes.filter((e) => e.path.startsWith("notifications.")).length,
      0,
    );
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("route actions reach the router, and a plan reset zeroes usage", async () => {
  const { router, extra, f, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    const deps = runtime.routeDeps(() => true);
    await deps.actions.send("+358401234567", "hello");
    assert.ok(
      router.calls.some(
        (c: { path: string }) => c.path === "/api/sms/send-sms",
      ),
    );

    extra["monitoring/traffic-statistics"] = traffic(0, 400_000_000);
    await runtime.pollNow("traffic");
    await settle(
      () => (f.values("networking.lte.plan.usedRatio").at(-1) as number) > 0.39,
    );
    deps.resetPlan();
    await settle(
      () => (f.values("networking.lte.plan.usedRatio").at(-1) as number) === 0,
    );
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("stop logs out, flushes state and leaves no timers behind", async () => {
  const { router, f, timers, dir, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    await runtime.stop();
    assert.equal(router.calls.at(-1)?.path, "/api/user/logout");
    assert.ok(existsSync(join(dir, "usage.json")));
    assert.equal(timers.pendingCount(), 0);
  } finally {
    await router.close();
  }
});

const smsNoteStates = (f: ReturnType<typeof fakeApp>) =>
  f.deltas
    .flatMap((d) => d.updates.flatMap((u) => u.values ?? []))
    .filter((e) => e.path.startsWith("notifications.networking.lte.sms."))
    .map((e) => ({
      path: e.path,
      state: (e.value as { state: string }).state,
    }));

const twoMessages = () =>
  smsList(
    message(40002, "+358409999999", "second", "2023-10-07 08:00:00"),
    message(40001, "+358401234567", "first", "2023-10-06 12:00:00"),
  );

test("an SMS notification is cleared when the message is marked read", async () => {
  const { router, extra, f, runtime } = await boot({
    extra: { "sms/set-read": xml("OK") },
  });
  try {
    await runtime.start();
    await initialPollsDone(f);
    extra["sms/sms-list"] = twoMessages();
    await runtime.pollNow("sms");
    await settle(() => smsNoteStates(f).length === 1);
    assert.equal(smsNoteStates(f)[0]?.state, "alert");
    const path = smsNoteStates(f)[0]?.path;

    const deps = runtime.routeDeps(() => true);
    const msg = deps.sms.list().find((m) => m.text === "second");
    assert.ok(msg);
    await deps.actions.markRead(msg);
    deps.sms.markRead(msg.id);
    await settle(() =>
      smsNoteStates(f).some((n) => n.path === path && n.state === "normal"),
    );
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("an SMS notification is cleared when the message disappears from the router", async () => {
  const { router, extra, f, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    extra["sms/sms-list"] = twoMessages();
    await runtime.pollNow("sms");
    await settle(() => smsNoteStates(f).length === 1);
    extra["sms/sms-list"] = smsList(
      message(40001, "+358401234567", "first", "2023-10-06 12:00:00"),
    );
    await runtime.pollNow("sms");
    await settle(() => smsNoteStates(f).some((n) => n.state === "normal"));
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("starting while the router is down never reports the link as ok first", async () => {
  const { router, f, runtime } = await boot();
  await router.close();
  try {
    await runtime.start();
    await settle(() =>
      f.values("networking.lte.routerLink").includes("unreachable"),
    );
    assert.deepEqual(f.states("notifications.networking.lte.link"), ["warn"]);
  } finally {
    await runtime.stop();
  }
});

test("deleting or marking a message that changed on the router is refused", async () => {
  const { router, extra, f, runtime } = await boot();
  try {
    await runtime.start();
    await initialPollsDone(f);
    const deps = runtime.routeDeps(() => true);
    const cached = deps.sms.list().find((m) => m.text === "first");
    assert.ok(cached);
    // The router reuses index 40001 for a different message.
    extra["sms/sms-list"] = smsList(
      message(40001, "+358407777777", "someone else", "2023-10-08 09:00:00"),
    );
    for (const act of [deps.actions.remove, deps.actions.markRead]) {
      await assert.rejects(
        act(cached),
        (e: unknown) => e instanceof Error && e.name === "Conflict",
      );
    }
    const writes = router.calls.filter((c: { path: string }) =>
      /delete-sms|set-read/.test(c.path),
    );
    assert.equal(writes.length, 0);
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("a send the router never confirms is reported as unknown, not as sent", async () => {
  const pending = xml(
    "<Phone>+358401234567</Phone><SucPhone></SucPhone><FailPhone></FailPhone><TotalCount>1</TotalCount><CurIndex>0</CurIndex>",
  );
  const { router, f, runtime } = await boot(
    { sendStatus: [pending] },
    {},
    undefined,
    { sleep: async () => {}, sendTimeoutMs: 0 },
  );
  try {
    await runtime.start();
    await initialPollsDone(f);
    const result = await runtime
      .routeDeps(() => true)
      .actions.send("+358401234567", "hello");
    assert.deepEqual(result, { status: "unknown" });
    const sent = runtime.routeDeps(() => true).sms.list();
    assert.equal(sent[0]?.direction, "out");
    assert.equal(sent[0]?.delivery, "unknown");
    // A sent message lives only in the plugin: removing it never calls the router.
    const deps = runtime.routeDeps(() => true);
    const before = router.calls.length;
    await deps.actions.remove(sent[0] as SmsMessage);
    assert.ok(deps.sms.remove((sent[0] as SmsMessage).id));
    assert.equal(router.calls.length, before);
    assert.equal(
      deps.sms.list().filter((m) => m.direction === "out").length,
      0,
    );
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("a busy router session shows as retrying, not as a login failure", async () => {
  const { router, f, runtime } = await boot({
    failLogin: true,
    loginErrorCode: 108003,
  });
  try {
    await runtime.start();
    await settle(() => f.statuses.some((s) => /another/i.test(s)));
    assert.ok(!f.errors.some((e) => /rejected/i.test(e)));
    assert.equal(runtime.status().link, "unreachable");
  } finally {
    await runtime.stop();
    await router.close();
  }
});

test("the unread count follows the router's total, not the page we read", async () => {
  const sms = Array.from({ length: 30 }, (_, i) => ({
    index: 40100 - i,
    phone: "DIGI",
    content: `message ${i}`,
    date: `2026-10-05 17:${String(59 - i).padStart(2, "0")}:00`,
  }));
  const { router, f, runtime } = await boot({ sms });
  try {
    await runtime.start();
    await initialPollsDone(f);
    assert.equal(f.values("networking.lte.sms.unread").at(-1), 30);
    assert.equal((runtime.status().sms as { unread: number }).unread, 30);
  } finally {
    await runtime.stop();
    await router.close();
  }
});
