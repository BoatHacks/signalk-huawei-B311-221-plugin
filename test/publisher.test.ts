import assert from "node:assert/strict";
import { test } from "node:test";
import { PATHS } from "../src/paths.ts";
import { createPublisher } from "../src/publisher.ts";
import type { SmsMessage } from "../src/types.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");

interface Delta {
  context?: string;
  updates: {
    values?: { path: string; value: unknown }[];
    meta?: { path: string; value: Record<string, unknown> }[];
  }[];
}

function setup() {
  const calls: { pluginId: string; delta: Delta }[] = [];
  const sink = {
    handleMessage(pluginId: string, delta: object) {
      calls.push({ pluginId, delta: delta as Delta });
    },
  };
  const pub = createPublisher(sink, "test-plugin", { now: () => NOW });
  const values = () =>
    Object.fromEntries(
      calls.flatMap((c) =>
        c.delta.updates.flatMap((u) =>
          (u.values ?? []).map((v) => [v.path, v.value] as const),
        ),
      ),
    );
  return { calls, pub, values };
}

function sms(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    id: "abc-1",
    index: 1,
    direction: "in",
    peer: "+3585550100",
    text: "hello",
    timestamp: "2026-01-02T03:00:00.000Z",
    read: false,
    ...over,
  };
}

test("signal sample publishes router units unconverted plus radioQuality", () => {
  const { pub, values, calls } = setup();
  pub.publishSignal({
    rssi: -65,
    rsrp: -100,
    rsrq: -9,
    sinr: 15,
    band: "B20",
    cellId: "12345",
    pci: "321",
    networkType: "LTE",
  });
  assert.deepEqual(values(), {
    [PATHS.rssi]: -65,
    [PATHS.rsrp]: -100,
    [PATHS.rsrq]: -9,
    [PATHS.sinr]: 15,
    [PATHS.radioQuality]: 0.5,
    [PATHS.curBand]: "B20",
    [PATHS.cellId]: "12345",
    [PATHS.pci]: "321",
    [PATHS.connectionType]: "LTE",
  });
  assert.equal(calls[0]?.pluginId, "test-plugin");
  assert.equal(calls[0]?.delta.context, "vessels.self");
});

test("missing signal fields are omitted, never undefined", () => {
  const { pub, values, calls } = setup();
  pub.publishSignal({ rsrp: -100 });
  assert.deepEqual(values(), {
    [PATHS.rsrp]: -100,
    [PATHS.radioQuality]: 0.5,
  });
  pub.publishSignal({});
  assert.equal(calls.length, 1, "empty sample emits no delta");
});

test("operator registered", () => {
  const { pub, values } = setup();
  pub.publishOperator({
    operator: { name: "Elisa" },
    serviceAvailable: true,
    networkType: "LTE-A",
  });
  assert.deepEqual(values(), {
    [PATHS.registerNetworkDisplay]: "Elisa",
    [PATHS.connectionText]: "Elisa",
    [PATHS.connectionType]: "LTE-A",
  });
});

test("not registered gives No service and clears the operator name", () => {
  const { pub, values } = setup();
  pub.publishOperator({
    operator: { name: "Elisa" },
    serviceAvailable: false,
  });
  assert.deepEqual(values(), {
    [PATHS.registerNetworkDisplay]: null,
    [PATHS.connectionText]: "No service",
  });
});

test("registered without a name falls back to No service text", () => {
  const { pub, values } = setup();
  pub.publishOperator({ serviceAvailable: true });
  assert.equal(values()[PATHS.connectionText], "No service");
});

test("connection", () => {
  const { pub, values } = setup();
  pub.publishConnection({
    connected: true,
    serviceAvailable: true,
    roaming: false,
    bars: 4,
    wanIp: "10.1.2.3",
    uptimeSeconds: 99,
  });
  assert.deepEqual(values(), {
    [PATHS.bars]: 4,
    [PATHS.wanIp]: "10.1.2.3",
    [PATHS.modemUptime]: 99,
    [PATHS.roaming]: false,
  });
});

test("connection omits absent fields", () => {
  const { pub, values } = setup();
  pub.publishConnection({ connected: false, serviceAvailable: false });
  assert.deepEqual(values(), {});
});

test("traffic counters", () => {
  const { pub, values } = setup();
  pub.publishTraffic({ uploadBytes: 10, downloadBytes: 20, at: 0 });
  assert.deepEqual(values(), {
    [PATHS.usageRx]: 20,
    [PATHS.usageTx]: 10,
  });
});

test("plan snapshot", () => {
  const { pub, values } = setup();
  pub.publishPlan({
    totalBytes: 100,
    usedBytes: 40,
    remainingBytes: 60,
    usedRatio: 0.4,
    periodEnd: "2026-02-01T00:00:00.000Z",
  });
  assert.deepEqual(values(), {
    [PATHS.planTotalBytes]: 100,
    [PATHS.planUsedBytes]: 40,
    [PATHS.planRemainingBytes]: 60,
    [PATHS.planUsedRatio]: 0.4,
    [PATHS.planPeriodEnd]: "2026-02-01T00:00:00.000Z",
  });
});

test("sms summary truncates and strips control characters", () => {
  const { pub, values } = setup();
  pub.publishSms({
    unread: 2,
    lastMessage: `a\u0000b\nc${"x".repeat(500)}`,
    lastMessageTime: "2026-01-02T03:00:00.000Z",
  });
  const v = values();
  assert.equal(v[PATHS.smsUnread], 2);
  assert.equal(v[PATHS.lastMessageTime], "2026-01-02T03:00:00.000Z");
  const text = v[PATHS.lastMessage] as string;
  assert.ok(text.startsWith("ab c"));
  assert.ok(text.length <= 160);
  assert.ok(text.endsWith("…"));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the test
  assert.doesNotMatch(text, /[\u0000-\u001f]/);
});

test("sms summary without a message publishes only the count", () => {
  const { pub, values } = setup();
  pub.publishSms({ unread: 0 });
  assert.deepEqual(values(), { [PATHS.smsUnread]: 0 });
});

test("router link state", () => {
  const { pub, values } = setup();
  pub.publishRouterLink("unreachable");
  assert.deepEqual(values(), { [PATHS.routerLink]: "unreachable" });
});

test("meta: one delta, spec fields only, zones on rsrp and sinr", () => {
  const { pub, calls } = setup();
  pub.sendMeta();
  assert.equal(calls.length, 1);
  const meta = calls[0]?.delta.updates[0]?.meta ?? [];
  const byPath = Object.fromEntries(meta.map((m) => [m.path, m.value]));
  assert.ok(byPath[PATHS.rsrp]?.zones);
  assert.ok(byPath[PATHS.sinr]?.zones);
  assert.equal(byPath[PATHS.rssi]?.units, "dBm");
  assert.equal(byPath[PATHS.rssi]?.zones, undefined);
  for (const m of meta) assert.ok(m.value.description);
  assert.equal(meta.length, Object.values(PATHS).length);
});

test("sendMeta can be repeated", () => {
  const { pub, calls } = setup();
  pub.sendMeta();
  pub.sendMeta();
  assert.equal(calls.length, 2);
});

test("meta has no undefined fields", () => {
  const { pub, calls } = setup();
  pub.sendMeta();
  const round = JSON.parse(JSON.stringify(calls[0]?.delta));
  assert.deepEqual(round, calls[0]?.delta);
});

function notif(calls: { delta: Delta }[], path: string) {
  for (const c of calls)
    for (const u of c.delta.updates)
      for (const v of u.values ?? [])
        if (v.path === path)
          return v.value as {
            state: string;
            method: string[];
            message: string;
            timestamp: string;
          };
  return undefined;
}

test("plan notification levels", () => {
  const p = "notifications.networking.lte.plan";
  const snap = {
    totalBytes: 100,
    usedBytes: 96,
    remainingBytes: 4,
    usedRatio: 0.96,
    periodEnd: "2026-02-01T00:00:00.000Z",
  };
  const a = setup();
  a.pub.notifyPlan("alarm", snap);
  const n = notif(a.calls, p);
  assert.equal(n?.state, "alarm");
  assert.ok(n?.method.includes("sound"));
  assert.match(n?.message ?? "", /96%/);
  assert.equal(n?.timestamp, NOW.toISOString());

  const w = setup();
  w.pub.notifyPlan("warn", { ...snap, usedRatio: 0.8 });
  assert.equal(notif(w.calls, p)?.state, "warn");

  const c = setup();
  c.pub.notifyPlan("normal");
  const cleared = notif(c.calls, p);
  assert.equal(cleared?.state, "normal");
  assert.ok(Array.isArray(cleared?.method));
  assert.ok(cleared?.message);
});

test("link notification", () => {
  const p = "notifications.networking.lte.link";
  for (const [state, expected] of [
    ["unreachable", "warn"],
    ["auth-failed", "alarm"],
    ["ok", "normal"],
    ["connecting", "normal"],
  ] as const) {
    const { pub, calls } = setup();
    pub.notifyLink(state);
    assert.equal(notif(calls, p)?.state, expected, state);
  }
});

test("service notification", () => {
  const p = "notifications.networking.lte.service";
  const a = setup();
  a.pub.notifyService({ connected: false, serviceAvailable: false });
  assert.equal(notif(a.calls, p)?.state, "alarm");
  assert.match(notif(a.calls, p)?.message ?? "", /No service/);

  const b = setup();
  b.pub.notifyService({
    connected: true,
    serviceAvailable: true,
    roaming: true,
  });
  assert.equal(notif(b.calls, p)?.state, "warn");
  assert.match(notif(b.calls, p)?.message ?? "", /oaming/);

  const c = setup();
  c.pub.notifyService({ connected: true, serviceAvailable: true });
  assert.equal(notif(c.calls, p)?.state, "normal");
});

test("sms notification: path from id, text sanitised and truncated", () => {
  const { pub, calls } = setup();
  pub.notifySms(sms({ id: "a/b.c d", text: `hi\u0007\r\n${"y".repeat(300)}` }));
  const p = "notifications.networking.lte.sms.a_b_c_d";
  const n = notif(calls, p);
  assert.ok(n);
  assert.equal(n.state, "alert");
  assert.ok(n.message.length <= 200);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the test
  assert.doesNotMatch(n.message, /[\u0000-\u001f]/);
  assert.match(n.message, /\+3585550100/);
});

test("sms notification can be cleared", () => {
  const { pub, calls } = setup();
  pub.clearSmsNotification("abc-1");
  const n = notif(calls, "notifications.networking.lte.sms.abc-1");
  assert.equal(n?.state, "normal");
});
