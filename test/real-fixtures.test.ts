import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseConnection,
  parseOperator,
  parseSignal,
  parseSmsCounts,
  parseSmsList,
  parseTraffic,
  routerDateToIso,
} from "../src/parsers.ts";
import { parseResponseXml } from "../src/xml.ts";

// Recorded from a real B311-221 (test/fixtures/real/README.md).
const real = (name: string) =>
  parseResponseXml(
    readFileSync(
      new URL(`./fixtures/real/${name}.xml`, import.meta.url),
      "utf8",
    ),
  ).data;

test("real: device/signal", () => {
  assert.deepEqual(parseSignal(real("device-signal")), {
    rssi: -59,
    rsrp: -83,
    rsrq: -7,
    sinr: 2,
    band: "1",
    cellId: "12345678",
    pci: "69",
  });
});

test("real: net/current-plmn", () => {
  assert.deepEqual(parseOperator(real("net-current-plmn")), {
    name: "DIGI ES",
    plmn: "21422",
  });
});

test("real: monitoring/status plus device/information", () => {
  const c = parseConnection(
    real("monitoring-status"),
    real("device-information"),
  );
  assert.equal(c.connected, true);
  assert.equal(c.serviceAvailable, true);
  assert.equal(c.roaming, false);
  assert.equal(c.bars, 5);
  assert.equal(c.networkType, "LTE");
  // These two live in device/information, not in monitoring/status.
  assert.equal(c.wanIp, "10.20.153.229");
  assert.equal(c.uptimeSeconds, 153657);
});

test("real: monitoring/status alone carries neither WAN IP nor uptime", () => {
  const c = parseConnection(real("monitoring-status"));
  assert.equal(c.wanIp, undefined);
  assert.equal(c.uptimeSeconds, undefined);
});

test("real: a missing or empty device/information leaves the status intact", () => {
  const c = parseConnection(real("monitoring-status"), undefined);
  assert.equal(c.connected, true);
  assert.equal(c.bars, 5);
});

test("real: monitoring/traffic-statistics totals", () => {
  assert.deepEqual(parseTraffic(real("monitoring-traffic-statistics"), 7), {
    uploadBytes: 202771047401,
    downloadBytes: 350389065929,
    at: 7,
  });
});

test("real: sms/sms-list", () => {
  const list = parseSmsList(real("sms-sms-list"), {
    nowMs: Date.parse("2026-10-07T12:00:00Z"),
    direction: "in",
  });
  assert.equal(list.length, 5);
  assert.deepEqual(
    list.map((m) => [m.index, m.read]),
    [
      [40088, false],
      [40083, false],
      [40086, false],
      [40085, true],
      [40084, true],
    ],
  );
  assert.equal(list[0]?.peer, "DIGI");
  assert.equal(list[3]?.peer, "00000");
  // The router's date has no zone; it is read as the server's local time.
  assert.equal(list[0]?.timestamp, routerDateToIso("2026-10-05 17:45:11"));
});

test("real: sms/sms-count", () => {
  assert.deepEqual(parseSmsCounts(real("sms-sms-count")), {
    inbox: 87,
    unread: 33,
  });
});
