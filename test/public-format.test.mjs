import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysUntil,
  formatAge,
  formatBytes,
  formatNumber,
  isStale,
  metricState,
  planState,
  smsSegments,
} from "../public/lib/format.js";

test("formatBytes uses decimal units and a dash for unknown", () => {
  assert.equal(formatBytes(undefined), "-");
  assert.equal(formatBytes(Number.NaN), "-");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1500), "1.5 kB");
  assert.equal(formatBytes(1_230_000_000), "1.23 GB");
  assert.equal(formatBytes(50_000_000_000), "50.0 GB");
  assert.equal(formatBytes(2.5e12), "2.50 TB");
});

test("formatNumber", () => {
  assert.equal(formatNumber(undefined, "dBm"), "-");
  assert.equal(formatNumber(null, "dB"), "-");
  assert.equal(formatNumber(-98, "dBm"), "-98 dBm");
  assert.equal(formatNumber(12.34, "dB"), "12.3 dB");
});

test("RSRP bands match the Signal K zones", () => {
  assert.equal(metricState("rsrp", -80), "green");
  assert.equal(metricState("rsrp", -105), "green");
  assert.equal(metricState("rsrp", -105.1), "amber");
  assert.equal(metricState("rsrp", -115), "amber");
  assert.equal(metricState("rsrp", -115.1), "red");
});

test("SINR bands match the Signal K zones", () => {
  assert.equal(metricState("sinr", 20), "green");
  assert.equal(metricState("sinr", 5), "green");
  assert.equal(metricState("sinr", 4.9), "amber");
  assert.equal(metricState("sinr", 0), "amber");
  assert.equal(metricState("sinr", -0.1), "red");
});

test("unknown, missing or unbanded metrics are neutral", () => {
  assert.equal(metricState("rsrp", undefined), "neutral");
  assert.equal(metricState("rsrp", Number.NaN), "neutral");
  assert.equal(metricState("rssi", -60), "neutral");
  assert.equal(metricState("rsrq", -10), "neutral");
  assert.equal(metricState("rsrp", -60, { stale: true }), "neutral");
});

test("planState thresholds 0.8 and 0.95", () => {
  assert.equal(planState(0.1), "green");
  assert.equal(planState(0.8), "amber");
  assert.equal(planState(0.95), "red");
  assert.equal(planState(undefined), "neutral");
});

test("isStale: old, missing, bad link or bad date", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(isStale("2026-01-01T11:59:30Z", now, "ok"), false);
  assert.equal(isStale("2026-01-01T11:58:00Z", now, "ok"), true);
  assert.equal(isStale("2026-01-01T11:59:30Z", now, "unreachable"), true);
  assert.equal(isStale("2026-01-01T11:59:30Z", now, "auth-failed"), true);
  assert.equal(isStale("2026-01-01T11:59:30Z", now, "connecting"), true);
  assert.equal(isStale(undefined, now, "ok"), true);
  assert.equal(isStale("garbage", now, "ok"), true);
});

test("formatAge", () => {
  assert.equal(formatAge(undefined), "never");
  assert.equal(formatAge(-5), "now");
  assert.equal(formatAge(4000), "4 s ago");
  assert.equal(formatAge(125_000), "2 min ago");
  assert.equal(formatAge(3 * 3600_000), "3 h ago");
  assert.equal(formatAge(2 * 86400_000), "2 d ago");
});

test("daysUntil rounds up and clamps at 0", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(daysUntil("2026-01-02T00:00:00Z", now), 1);
  assert.equal(daysUntil("2026-01-02T01:00:00Z", now), 2);
  assert.equal(daysUntil("2025-12-01T00:00:00Z", now), 0);
  assert.equal(daysUntil(undefined, now), undefined);
});

test("smsSegments: 7-bit", () => {
  assert.deepEqual(smsSegments(""), {
    encoding: "gsm7",
    length: 0,
    segments: 0,
    perSegment: 160,
    remaining: 160,
  });
  assert.equal(smsSegments("a".repeat(160)).segments, 1);
  assert.equal(smsSegments("a".repeat(160)).remaining, 0);
  const two = smsSegments("a".repeat(161));
  assert.equal(two.segments, 2);
  assert.equal(two.perSegment, 153);
  assert.equal(two.remaining, 306 - 161);
  assert.equal(smsSegments("a".repeat(306)).segments, 2);
  assert.equal(smsSegments("a".repeat(307)).segments, 3);
});

test("smsSegments: GSM extension chars count double", () => {
  const r = smsSegments("{}[]€");
  assert.equal(r.encoding, "gsm7");
  assert.equal(r.length, 10);
  assert.equal(smsSegments("€".repeat(80)).segments, 1);
  assert.equal(smsSegments("€".repeat(81)).segments, 2);
});

test("smsSegments: UCS2 when a char is outside GSM", () => {
  const one = smsSegments(`${"a".repeat(69)}ж`);
  assert.equal(one.encoding, "ucs2");
  assert.equal(one.length, 70);
  assert.equal(one.segments, 1);
  assert.equal(one.perSegment, 70);
  const two = smsSegments(`${"a".repeat(70)}ж`);
  assert.equal(two.segments, 2);
  assert.equal(two.perSegment, 67);
  assert.equal(smsSegments("ж".repeat(134)).segments, 2);
  assert.equal(smsSegments("ж".repeat(135)).segments, 3);
});

test("smsSegments: astral chars are two UCS2 units", () => {
  const r = smsSegments("😀".repeat(35));
  assert.equal(r.encoding, "ucs2");
  assert.equal(r.length, 70);
  assert.equal(r.segments, 1);
  assert.equal(smsSegments("😀".repeat(36)).segments, 2);
});

test("metricFraction maps ranges onto 0..1 and clamps", async () => {
  const { metricFraction } = await import("../public/lib/format.js");
  assert.equal(metricFraction("rsrp", -140), 0);
  assert.equal(metricFraction("rsrp", -40), 1);
  assert.equal(metricFraction("rsrp", -200), 0);
  assert.equal(metricFraction("rsrp", 0), 1);
  assert.equal(metricFraction("rsrp", -90), 0.5);
  assert.equal(metricFraction("rsrp", undefined), 0);
  assert.equal(metricFraction("nope", 1), 0);
});

test("a send the router confirmed reads as sent", async () => {
  const { sendOutcome } = await import("../public/lib/format.js");
  for (const res of [{ ok: true, status: "sent" }, { ok: true }, undefined]) {
    assert.deepEqual(sendOutcome(res), {
      kind: "ok",
      message: "Message sent.",
    });
  }
});

test("a send the router never confirmed is a warning that keeps the draft", async () => {
  const { sendOutcome } = await import("../public/lib/format.js");
  const out = sendOutcome({ ok: true, status: "unknown" });
  assert.equal(out.kind, "warn");
  assert.match(out.message, /not confirm/i);
  assert.match(out.message, /before sending again/i);
});
