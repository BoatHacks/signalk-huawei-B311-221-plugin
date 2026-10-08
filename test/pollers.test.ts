import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouterPort } from "../src/pollers.ts";
import { createPollers } from "../src/pollers.ts";
import type {
  ConnectionStatus,
  LinkState,
  OperatorInfo,
  SignalSample,
  SmsMessage,
  TrafficSample,
} from "../src/types.ts";
import { createFakeTimers } from "./helpers/fake-timers.ts";

const named = (name: string, message = name) =>
  Object.assign(new Error(message), { name });
const SEC = 1000;
const INTERVALS = { signalMs: 10 * SEC, trafficMs: 60 * SEC, smsMs: 60 * SEC };

function harness(
  overrides: Partial<Record<string, () => Promise<unknown>>> = {},
) {
  const timers = createFakeTimers();
  const calls: string[] = [];
  const events: string[] = [];
  const links: LinkState[] = [];
  let active = 0;
  let maxActive = 0;
  const wrap = (name: string, value: unknown) => async (): Promise<unknown> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(name);
    try {
      if (overrides[name]) return await overrides[name]();
      return value;
    } finally {
      active -= 1;
    }
  };
  const router = {
    getSignal: wrap("signal", { rsrp: -90 } satisfies SignalSample),
    getOperator: wrap("operator", { name: "Telia" } satisfies OperatorInfo),
    getConnection: wrap("connection", {
      connected: true,
      serviceAvailable: true,
    } satisfies ConnectionStatus),
    getTraffic: wrap("traffic", {
      uploadBytes: 1,
      downloadBytes: 2,
      at: 0,
    } satisfies TrafficSample),
    getSmsCounts: wrap("smsCounts", { inbox: 0, unread: 0 }),
    listSmsPage: wrap("sms", {
      messages: [] as SmsMessage[],
      unreadReports: 0,
      reports: [],
    }),
  } as unknown as RouterPort;
  const pollers = createPollers({
    router,
    intervals: INTERVALS,
    timers,
    handlers: {
      onSignal: () => events.push("onSignal"),
      onTraffic: () => events.push("onTraffic"),
      onSms: () => events.push("onSms"),
      onLink: (s) => links.push(s),
    },
    log: () => {},
  });
  return { timers, calls, events, links, pollers, maxActive: () => maxActive };
}

test("start polls signal, traffic and SMS once each, one after the other", async () => {
  const h = harness();
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.calls, [
    "signal",
    "operator",
    "connection",
    "traffic",
    "smsCounts",
    "sms",
  ]);
  assert.deepEqual(h.events, ["onSignal", "onTraffic", "onSms"]);
  assert.deepEqual(h.links, ["connecting", "ok"]);
  assert.equal(h.maxActive(), 1);
  await h.pollers.stop();
});

test("each poll repeats on its own interval", async () => {
  const h = harness();
  h.pollers.start();
  await h.timers.flush();
  h.calls.length = 0;
  await h.timers.advance(10 * SEC);
  assert.deepEqual(h.calls, ["signal", "operator", "connection"]);
  h.calls.length = 0;
  await h.timers.advance(50 * SEC);
  assert.equal(h.calls.filter((c) => c === "signal").length, 5);
  assert.equal(h.calls.filter((c) => c === "traffic").length, 1);
  assert.equal(h.calls.filter((c) => c === "sms").length, 1);
  await h.pollers.stop();
});

test("a slow poll never overlaps another request", async () => {
  let release: (() => void) | undefined;
  let first = true;
  const slow = harness({
    signal: async () => {
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return { rsrp: -90 };
    },
  });
  slow.pollers.start();
  await slow.timers.flush();
  await slow.timers.advance(30 * SEC);
  assert.equal(slow.maxActive(), 1);
  release?.();
  await slow.timers.flush();
  assert.equal(slow.maxActive(), 1);
  await slow.pollers.stop();
});

test("an unreachable router flips the link, backs off, and recovers", async () => {
  let down = true;
  const h = harness({
    signal: async () => {
      if (down) throw named("Unreachable");
      return { rsrp: -90 };
    },
  });
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.links, ["connecting", "unreachable"]);
  const signalCalls = () => h.calls.filter((c) => c === "signal").length;
  assert.equal(signalCalls(), 1);

  // Backoff doubles from the signal interval: 20 s, then 40 s.
  await h.timers.advance(19 * SEC);
  assert.equal(signalCalls(), 1);
  await h.timers.advance(1 * SEC);
  assert.equal(signalCalls(), 2);
  await h.timers.advance(39 * SEC);
  assert.equal(signalCalls(), 2);
  await h.timers.advance(1 * SEC);
  assert.equal(signalCalls(), 3);
  assert.ok(
    !h.calls.includes("traffic"),
    "only the probe runs while unreachable",
  );

  down = false;
  await h.timers.advance(80 * SEC);
  assert.deepEqual(h.links, ["connecting", "unreachable", "ok"]);
  assert.ok(h.calls.includes("traffic"), "full polling resumes after recovery");
  assert.ok(h.calls.includes("sms"));
  await h.pollers.stop();
});

test("the backoff is capped", async () => {
  const h = harness({
    signal: async () => {
      throw named("Unreachable");
    },
  });
  h.pollers.start();
  await h.timers.flush();
  await h.timers.advance(2 * 60 * 60 * SEC);
  const n = h.calls.filter((c) => c === "signal").length;
  // 2 hours at a 5 minute cap is about 24 probes plus the ramp-up.
  assert.ok(n > 15 && n < 40, `probes: ${n}`);
  await h.pollers.stop();
});

test("rejected credentials stop all polling instead of retrying", async () => {
  const h = harness({
    signal: async () => {
      throw named("AuthFailed", "Password wrong");
    },
  });
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.links, ["connecting", "auth-failed"]);
  const before = h.calls.length;
  await h.timers.advance(6 * 60 * 60 * SEC);
  assert.equal(h.calls.length, before);
  assert.equal(h.timers.pendingCount(), 0);
  await h.pollers.stop();
});

test("a non-network error in one poll keeps the link up and retries on schedule", async () => {
  let fail = true;
  const h = harness({
    sms: async () => {
      if (fail) throw named("BadResponse");
      return [];
    },
  });
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.links, ["connecting", "ok"]);
  fail = false;
  h.calls.length = 0;
  await h.timers.advance(60 * SEC);
  assert.ok(h.calls.includes("sms"));
  await h.pollers.stop();
});

test("a throwing handler does not stop polling", async () => {
  const timers = createFakeTimers();
  let signals = 0;
  const router = {
    getSignal: async () => ({ rsrp: -90 }),
    getOperator: async () => ({}),
    getConnection: async () => ({ connected: true, serviceAvailable: true }),
    getTraffic: async () => ({ uploadBytes: 1, downloadBytes: 1, at: 0 }),
    listSmsPage: async () => ({ messages: [], unreadReports: 0, reports: [] }),
  } as unknown as RouterPort;
  const pollers = createPollers({
    router,
    intervals: INTERVALS,
    timers,
    handlers: {
      onSignal: () => {
        signals += 1;
        throw new Error("handler bug");
      },
      onTraffic: () => {},
      onSms: () => {},
      onLink: () => {},
    },
    log: () => {},
  });
  pollers.start();
  await timers.flush();
  await timers.advance(30 * SEC);
  assert.ok(signals >= 3);
  await pollers.stop();
});

test("stop cancels timers, waits for an in-flight poll and suppresses its results", async () => {
  let release: (() => void) | undefined;
  const h = harness({
    signal: async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { rsrp: -90 };
    },
  });
  h.pollers.start();
  await h.timers.flush();
  let stopped = false;
  const stopping = h.pollers.stop().then(() => {
    stopped = true;
  });
  await h.timers.flush();
  assert.equal(stopped, false, "stop waits for the in-flight call");
  release?.();
  await stopping;
  assert.deepEqual(h.events, []);
  assert.equal(h.timers.pendingCount(), 0);
  const before = h.calls.length;
  await h.timers.advance(60 * 60 * SEC);
  assert.equal(h.calls.length, before);
});

test("pollNow runs a poll immediately without disturbing the schedule", async () => {
  const h = harness();
  h.pollers.start();
  await h.timers.flush();
  h.calls.length = 0;
  await h.pollers.pollNow("sms");
  assert.deepEqual(h.calls, ["smsCounts", "sms"]);
  await h.pollers.stop();
});

test("a busy router session is treated like an unreachable router: back off and retry, never halt", async () => {
  let busy = true;
  const h = harness({
    signal: async () => {
      if (busy)
        throw named("SessionBusy", "another admin session is active (108003)");
      return { rsrp: -90 };
    },
  });
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.links, ["connecting", "unreachable"]);
  busy = false;
  await h.timers.advance(20 * SEC);
  assert.deepEqual(h.links, ["connecting", "unreachable", "ok"]);
  await h.pollers.stop();
});

function smsHarness(
  counts: Array<{ inbox: number; unread: number } | Error>,
  reportsPerPage = 0,
) {
  const timers = createFakeTimers();
  const pages: number[] = [];
  const delivered: Array<{ n: number; counts: unknown }> = [];
  let tick = 0;
  const msg = (i: number) =>
    ({ id: `m${i}`, index: i }) as unknown as SmsMessage;
  const router = {
    getSignal: async () => ({ rsrp: -90 }),
    getOperator: async () => ({}),
    getConnection: async () => ({ connected: true, serviceAvailable: true }),
    getTraffic: async () => ({ uploadBytes: 1, downloadBytes: 1, at: 0 }),
    getSmsCounts: async () => {
      const c = counts[Math.min(tick++, counts.length - 1)];
      if (c instanceof Error) throw c;
      return c;
    },
    listSmsPage: async (opts?: { page?: number }) => {
      const page = opts?.page ?? 1;
      pages.push(page);
      return {
        messages: Array.from({ length: 20 }, (_, i) => msg(page * 100 + i)),
        unreadReports: reportsPerPage,
        reports: [],
      };
    },
  } as unknown as RouterPort;
  const pollers = createPollers({
    router,
    intervals: INTERVALS,
    timers,
    handlers: {
      onSignal: () => {},
      onTraffic: () => {},
      onSms: (messages: SmsMessage[], c?: unknown) =>
        delivered.push({ n: messages.length, counts: c }),
      onLink: () => {},
    },
    log: () => {},
  });
  return { timers, pages, delivered, pollers };
}

test("the router's SMS totals are handed on with the messages", async () => {
  const h = smsHarness([{ inbox: 87, unread: 33 }]);
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.delivered, [{ n: 20, counts: { inbox: 87, unread: 33 } }]);
  await h.pollers.stop();
});

test("a burst of new messages is fetched page by page until covered", async () => {
  const h = smsHarness([
    { inbox: 10, unread: 0 },
    { inbox: 55, unread: 45 },
  ]);
  h.pollers.start();
  await h.timers.flush();
  h.pages.length = 0;
  await h.timers.advance(60 * SEC);
  // 45 new messages need pages 1, 2 and 3 at 20 per page.
  assert.deepEqual(h.pages, [1, 2, 3]);
  assert.equal(h.delivered[1]?.n, 60);
  await h.pollers.stop();
});

test("a few new messages need only the first page", async () => {
  const h = smsHarness([
    { inbox: 10, unread: 0 },
    { inbox: 13, unread: 3 },
  ]);
  h.pollers.start();
  await h.timers.flush();
  h.pages.length = 0;
  await h.timers.advance(60 * SEC);
  assert.deepEqual(h.pages, [1]);
  await h.pollers.stop();
});

test("a fall in the inbox total (deleted on the router) fetches nothing extra", async () => {
  const h = smsHarness([
    { inbox: 90, unread: 0 },
    { inbox: 10, unread: 0 },
  ]);
  h.pollers.start();
  await h.timers.flush();
  h.pages.length = 0;
  await h.timers.advance(60 * SEC);
  assert.deepEqual(h.pages, [1]);
  await h.pollers.stop();
});

test("an absurd jump is capped at five pages", async () => {
  const h = smsHarness([
    { inbox: 0, unread: 0 },
    { inbox: 500, unread: 500 },
  ]);
  h.pollers.start();
  await h.timers.flush();
  h.pages.length = 0;
  await h.timers.advance(60 * SEC);
  assert.deepEqual(h.pages, [1, 2, 3, 4, 5]);
  await h.pollers.stop();
});

test("unusable totals do not stop the messages", async () => {
  const h = smsHarness([named("BadResponse", "no counts") as Error]);
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.delivered, [{ n: 20, counts: undefined }]);
  await h.pollers.stop();
});

test("unread delivery reports are taken off the router's unread total", async () => {
  const h = smsHarness([{ inbox: 87, unread: 37 }], 2);
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.delivered, [{ n: 20, counts: { inbox: 87, unread: 35 } }]);
  await h.pollers.stop();
});

test("reports on every page of a burst are all taken off", async () => {
  const h = smsHarness(
    [
      { inbox: 10, unread: 10 },
      { inbox: 55, unread: 55 },
    ],
    1,
  );
  h.pollers.start();
  await h.timers.flush();
  await h.timers.advance(60 * SEC);
  // Pages 1-3 each dropped one unread report.
  assert.deepEqual(h.delivered[1]?.counts, { inbox: 55, unread: 52 });
  await h.pollers.stop();
});

test("the unread total never goes below zero", async () => {
  const h = smsHarness([{ inbox: 5, unread: 1 }], 3);
  h.pollers.start();
  await h.timers.flush();
  assert.deepEqual(h.delivered[0]?.counts, { inbox: 5, unread: 0 });
  await h.pollers.stop();
});
