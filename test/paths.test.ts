import assert from "node:assert/strict";
import { test } from "node:test";
import { META, PATHS, RSRP_ZONES, SINR_ZONES } from "../src/paths.ts";

test("paths follow SPEC 6.1", () => {
  assert.equal(PATHS.rssi, "networking.lte.rssi");
  assert.equal(PATHS.rsrp, "networking.lte.rsrp");
  assert.equal(PATHS.rsrq, "networking.lte.rsrq");
  assert.equal(PATHS.sinr, "networking.lte.sinr");
  assert.equal(PATHS.bars, "networking.lte.bars");
  assert.equal(PATHS.radioQuality, "networking.lte.radioQuality");
  assert.equal(PATHS.connectionType, "networking.lte.connectionType");
  assert.equal(
    PATHS.registerNetworkDisplay,
    "networking.lte.registerNetworkDisplay",
  );
  assert.equal(PATHS.connectionText, "networking.lte.connectionText");
  assert.equal(PATHS.curBand, "networking.lte.curBand");
  assert.equal(PATHS.cellId, "networking.lte.cellId");
  assert.equal(PATHS.pci, "networking.lte.pci");
  assert.equal(PATHS.roaming, "networking.lte.roaming");
  assert.equal(PATHS.wanIp, "networking.wan.ip");
  assert.equal(PATHS.modemUptime, "networking.modem.uptime");
  assert.equal(PATHS.usageRx, "networking.lte.usage.rx");
  assert.equal(PATHS.usageTx, "networking.lte.usage.tx");
  assert.equal(PATHS.planTotalBytes, "networking.lte.plan.totalBytes");
  assert.equal(PATHS.planUsedBytes, "networking.lte.plan.usedBytes");
  assert.equal(PATHS.planRemainingBytes, "networking.lte.plan.remainingBytes");
  assert.equal(PATHS.planUsedRatio, "networking.lte.plan.usedRatio");
  assert.equal(PATHS.planPeriodEnd, "networking.lte.plan.periodEnd");
  assert.equal(PATHS.lastMessage, "networking.lte.lastMessage");
  assert.equal(PATHS.lastMessageTime, "networking.lte.lastMessageTime");
  assert.equal(PATHS.smsUnread, "networking.lte.sms.unread");
  assert.equal(PATHS.routerLink, "networking.lte.routerLink");
});

test("every path has meta with description and a unit-free displayName", () => {
  for (const path of Object.values(PATHS)) {
    const meta = META[path];
    assert.ok(meta, `meta for ${path}`);
    assert.ok(meta.description.length > 0, `description for ${path}`);
    assert.ok(meta.displayName.length > 0);
    assert.doesNotMatch(meta.displayName, /\(|dBm|\bdB\b/);
  }
});

test("meta uses only spec-defined fields", () => {
  const allowed = new Set([
    "displayName",
    "description",
    "units",
    "displayScale",
    "zones",
  ]);
  for (const meta of Object.values(META)) {
    for (const key of Object.keys(meta)) assert.ok(allowed.has(key), key);
  }
});

test("units", () => {
  assert.equal(META[PATHS.rssi]?.units, "dBm");
  assert.equal(META[PATHS.rsrp]?.units, "dBm");
  assert.equal(META[PATHS.rsrq]?.units, "dB");
  assert.equal(META[PATHS.sinr]?.units, "dB");
  assert.equal(META[PATHS.usageRx]?.units, "B");
  assert.equal(META[PATHS.modemUptime]?.units, "s");
  assert.equal(META[PATHS.radioQuality]?.units, "ratio");
});

test("only rsrp and sinr carry zones", () => {
  const withZones = Object.entries(META)
    .filter(([, m]) => m.zones)
    .map(([p]) => p)
    .sort();
  assert.deepEqual(withZones, [PATHS.rsrp, PATHS.sinr].sort());
});

test("zones: states, contiguous, no overlap", () => {
  assert.deepEqual(
    RSRP_ZONES.map((z) => z.state),
    ["alarm", "warn", "normal"],
  );
  assert.equal(RSRP_ZONES[0]?.lower, undefined);
  assert.equal(RSRP_ZONES[0]?.upper, -115);
  assert.equal(RSRP_ZONES[1]?.lower, -115);
  assert.equal(RSRP_ZONES[1]?.upper, -105);
  assert.equal(RSRP_ZONES[2]?.lower, -105);
  assert.equal(RSRP_ZONES[2]?.upper, undefined);
  assert.equal(SINR_ZONES[0]?.upper, 0);
  assert.equal(SINR_ZONES[1]?.lower, 0);
  assert.equal(SINR_ZONES[1]?.upper, 5);
  assert.equal(SINR_ZONES[2]?.lower, 5);
  for (const z of [...RSRP_ZONES, ...SINR_ZONES]) {
    assert.ok(z.message && z.message.length > 0);
  }
});

test("displayScale is linear with lower < upper", () => {
  for (const meta of Object.values(META)) {
    if (!meta.displayScale) continue;
    assert.equal(meta.displayScale.type, "linear");
    assert.ok(meta.displayScale.lower < meta.displayScale.upper);
  }
  assert.ok(META[PATHS.rsrp]?.displayScale);
  assert.ok(META[PATHS.sinr]?.displayScale);
});
