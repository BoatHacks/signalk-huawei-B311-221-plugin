import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanConfig, TrafficSample } from "../src/types.ts";
import { createUsageTracker } from "../src/usage-tracker.ts";

const GB = 1_000_000_000;
const plan = (over: Partial<PlanConfig> = {}): PlanConfig => ({
  totalBytes: 10 * GB,
  resetDay: 1,
  warnRatio: 0.8,
  alarmRatio: 0.95,
  ...over,
});
const t = (iso: string) => Date.parse(iso);
const s = (up: number, down: number, iso: string): TrafficSample => ({
  uploadBytes: up,
  downloadBytes: down,
  at: t(iso),
});

describe("usage-tracker basics", () => {
  it("first sample is a baseline and adds no usage", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    const r = u.update(s(5 * GB, 5 * GB, "2026-03-10T00:00:00Z"));
    assert.equal(r.addedBytes, 0);
    assert.equal(r.snapshot?.usedBytes, 0);
    assert.deepEqual(u.account().lastCounter, {
      uploadBytes: 5 * GB,
      downloadBytes: 5 * GB,
    });
  });

  it("adds upload and download deltas", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(100, 200, "2026-03-10T00:00:00Z"));
    const r = u.update(s(150, 500, "2026-03-10T00:05:00Z"));
    assert.equal(r.addedBytes, 350);
    assert.equal(r.snapshot?.usedBytes, 350);
    assert.equal(u.account().uploadBytes, 50);
    assert.equal(u.account().downloadBytes, 300);
  });

  it("snapshot fields: ratio, remaining, periodEnd", () => {
    const u = createUsageTracker({
      plan: plan({ resetDay: 15 }),
      now: () => t("2026-03-20T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-20T00:00:00Z"));
    u.update(s(GB, 1 * GB, "2026-03-20T01:00:00Z"));
    const snap = u.snapshot(t("2026-03-20T01:00:00Z"));
    assert.equal(snap?.totalBytes, 10 * GB);
    assert.equal(snap?.usedBytes, 2 * GB);
    assert.equal(snap?.remainingBytes, 8 * GB);
    assert.equal(snap?.usedRatio, 0.2);
    assert.equal(snap?.periodEnd, "2026-04-15T00:00:00.000Z");
    assert.equal(u.account().periodStart, "2026-03-15T00:00:00.000Z");
  });

  it("remainingBytes never negative", () => {
    const u = createUsageTracker({
      plan: plan({ totalBytes: 100 }),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    const r = u.update(s(0, 500, "2026-03-10T00:01:00Z"));
    assert.equal(r.snapshot?.remainingBytes, 0);
    assert.equal(r.snapshot?.usedRatio, 5);
  });

  it("persisted lastCounter is used after restart", () => {
    const a = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    a.update(s(100, 100, "2026-03-10T00:00:00Z"));
    a.update(s(200, 100, "2026-03-10T00:01:00Z"));
    const b = createUsageTracker({
      plan: plan(),
      account: JSON.parse(JSON.stringify(a.account())),
      now: () => t("2026-03-10T01:00:00Z"),
    });
    const r = b.update(s(300, 150, "2026-03-10T01:00:00Z"));
    assert.equal(r.addedBytes, 150);
    assert.equal(b.account().uploadBytes, 200);
  });

  it("account() returns a copy", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.account().uploadBytes = 999;
    assert.equal(u.account().uploadBytes, 0);
  });
});

describe("counter reset", () => {
  it("a decreasing counter counts the new value as usage", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(1000, 1000, "2026-03-10T00:00:00Z"));
    const r = u.update(s(10, 20, "2026-03-10T00:10:00Z"));
    assert.equal(r.counterReset, true);
    assert.equal(r.addedBytes, 30);
    assert.equal(r.snapshot?.usedBytes, 30);
    const r2 = u.update(s(15, 30, "2026-03-10T00:20:00Z"));
    assert.equal(r2.counterReset, false);
    assert.equal(r2.addedBytes, 15);
  });

  it("directions are handled independently", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(1000, 1000, "2026-03-10T00:00:00Z"));
    const r = u.update(s(1100, 5, "2026-03-10T00:10:00Z"));
    assert.equal(r.addedBytes, 105);
  });
});

describe("invalid samples", () => {
  for (const [name, bad] of [
    ["NaN", s(Number.NaN, 1, "2026-03-10T00:00:00Z")],
    ["negative", s(1, -1, "2026-03-10T00:00:00Z")],
    ["Infinity", s(Number.POSITIVE_INFINITY, 1, "2026-03-10T00:00:00Z")],
    ["bad time", { uploadBytes: 1, downloadBytes: 1, at: Number.NaN }],
  ] as const) {
    it(`ignores ${name} and leaves the account untouched`, () => {
      const u = createUsageTracker({
        plan: plan(),
        now: () => t("2026-03-10T00:00:00Z"),
      });
      u.update(s(100, 100, "2026-03-10T00:00:00Z"));
      const before = u.account();
      const r = u.update(bad);
      assert.ok(r.ignored);
      assert.equal(r.addedBytes, 0);
      assert.deepEqual(u.account(), before);
    });
  }
});

describe("period rollover", () => {
  it("starts a fresh period on the reset day", () => {
    const u = createUsageTracker({
      plan: plan({ resetDay: 15 }),
      now: () => t("2026-03-14T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-14T00:00:00Z"));
    u.update(s(0, 1000, "2026-03-14T23:59:00Z"));
    const r = u.update(s(0, 1500, "2026-03-15T00:01:00Z"));
    assert.equal(r.periodRolledOver, true);
    assert.equal(u.account().periodStart, "2026-03-15T00:00:00.000Z");
    // usage since the previous sample belongs to the period containing the sample
    assert.equal(r.snapshot?.usedBytes, 500);
  });

  it("clamps resetDay 31 to the month length", () => {
    const u = createUsageTracker({
      plan: plan({ resetDay: 31 }),
      now: () => t("2026-02-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-02-10T00:00:00Z"));
    assert.equal(
      u.snapshot(t("2026-02-10T00:00:00Z"))?.periodEnd,
      "2026-02-28T00:00:00.000Z",
    );
    assert.equal(u.account().periodStart, "2026-01-31T00:00:00.000Z");
    u.update(s(0, 10, "2026-02-27T23:00:00Z"));
    const r = u.update(s(0, 20, "2026-02-28T00:00:01Z"));
    assert.equal(r.periodRolledOver, true);
    assert.equal(
      u.snapshot(t("2026-02-28T00:00:01Z"))?.periodEnd,
      "2026-03-31T00:00:00.000Z",
    );
  });

  it("leap year February", () => {
    const u = createUsageTracker({
      plan: plan({ resetDay: 30 }),
      now: () => t("2028-02-10T00:00:00Z"),
    });
    assert.equal(u.snapshot()?.periodEnd, "2028-02-29T00:00:00.000Z");
  });

  it("handles year boundary", () => {
    const u = createUsageTracker({
      plan: plan({ resetDay: 1 }),
      now: () => t("2026-12-20T00:00:00Z"),
    });
    assert.equal(u.snapshot()?.periodEnd, "2027-01-01T00:00:00.000Z");
    assert.equal(u.account().periodStart, "2026-12-01T00:00:00.000Z");
  });

  it("survives downtime across several boundaries without double counting", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-01-10T00:00:00Z"),
    });
    u.update(s(0, 100, "2026-01-10T00:00:00Z"));
    u.update(s(0, 300, "2026-01-11T00:00:00Z"));
    const r = u.update(s(0, 1300, "2026-04-20T00:00:00Z"));
    assert.equal(r.periodRolledOver, true);
    assert.equal(u.account().periodStart, "2026-04-01T00:00:00.000Z");
    assert.equal(r.snapshot?.usedBytes, 1000);
    assert.equal(u.account().downloadBytes, 1000);
  });

  it("stale persisted account rolls over on first sample after restart", () => {
    const u = createUsageTracker({
      plan: plan(),
      account: {
        periodStart: "2026-01-01T00:00:00.000Z",
        uploadBytes: 5,
        downloadBytes: 5,
        lastCounter: { uploadBytes: 10, downloadBytes: 10 },
      },
      now: () => t("2026-03-05T00:00:00Z"),
    });
    const r = u.update(s(20, 10, "2026-03-05T00:00:00Z"));
    assert.equal(r.periodRolledOver, true);
    assert.equal(r.snapshot?.usedBytes, 10);
  });

  it("snapshot after the period end reports a fresh period", () => {
    const u = createUsageTracker({
      plan: plan(),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    u.update(s(0, 500, "2026-03-11T00:00:00Z"));
    const snap = u.snapshot(t("2026-04-02T00:00:00Z"));
    assert.equal(snap?.usedBytes, 0);
    assert.equal(snap?.periodEnd, "2026-05-01T00:00:00.000Z");
  });
});

describe("thresholds", () => {
  it("reports normal, warn, alarm", () => {
    const u = createUsageTracker({
      plan: plan({ totalBytes: 1000 }),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    assert.equal(u.update(s(0, 500, "2026-03-10T00:01:00Z")).level, "normal");
    const w = u.update(s(0, 800, "2026-03-10T00:02:00Z"));
    assert.equal(w.level, "warn");
    assert.equal(w.levelChanged, true);
    const w2 = u.update(s(0, 810, "2026-03-10T00:03:00Z"));
    assert.equal(w2.levelChanged, false);
    assert.equal(u.update(s(0, 950, "2026-03-10T00:04:00Z")).level, "alarm");
  });

  it("hysteresis after plan change keeps level until meaningfully below", () => {
    const u = createUsageTracker({
      plan: plan({ totalBytes: 1000 }),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    u.update(s(0, 810, "2026-03-10T00:01:00Z"));
    assert.equal(u.currentLevel(), "warn");
    // total grows a bit: ratio 0.79, within hysteresis of warn
    u.setPlan(plan({ totalBytes: 1025 }));
    assert.equal(u.currentLevel(), "warn");
    // total grows a lot: ratio 0.5
    u.setPlan(plan({ totalBytes: 1620 }));
    assert.equal(u.currentLevel(), "normal");
  });

  it("manual reset restarts the period and clears the level", () => {
    const u = createUsageTracker({
      plan: plan({ totalBytes: 1000 }),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    u.update(s(0, 990, "2026-03-10T00:01:00Z"));
    assert.equal(u.currentLevel(), "alarm");
    const r = u.reset(t("2026-03-12T12:00:00Z"));
    assert.equal(r.level, "normal");
    assert.equal(r.snapshot?.usedBytes, 0);
    assert.equal(u.account().periodStart, "2026-03-12T12:00:00.000Z");
    assert.deepEqual(u.account().lastCounter, {
      uploadBytes: 0,
      downloadBytes: 990,
    });
    // no calendar rollover mid-period, deltas continue from the baseline
    const r2 = u.update(s(0, 1000, "2026-03-13T00:00:00Z"));
    assert.equal(r2.periodRolledOver, false);
    assert.equal(r2.snapshot?.usedBytes, 10);
    assert.equal(r2.snapshot?.periodEnd, "2026-04-01T00:00:00.000Z");
  });
});

describe("no plan", () => {
  it("returns undefined snapshot, normal level, still tracks the counter", () => {
    const u = createUsageTracker({ now: () => t("2026-03-10T00:00:00Z") });
    u.update(s(100, 100, "2026-03-10T00:00:00Z"));
    const r = u.update(s(500, 500, "2026-03-10T00:01:00Z"));
    assert.equal(r.snapshot, undefined);
    assert.equal(r.level, "normal");
    assert.equal(u.snapshot(), undefined);
    assert.equal(u.account().uploadBytes, 0);
    assert.deepEqual(u.account().lastCounter, {
      uploadBytes: 500,
      downloadBytes: 500,
    });
  });

  it("invalid plan is treated as absent", () => {
    const u = createUsageTracker({
      plan: plan({ totalBytes: 0 }),
      now: () => t("2026-03-10T00:00:00Z"),
    });
    assert.equal(u.snapshot(), undefined);
  });

  it("setPlan enables and disables", () => {
    const u = createUsageTracker({ now: () => t("2026-03-10T00:00:00Z") });
    u.update(s(0, 0, "2026-03-10T00:00:00Z"));
    u.setPlan(plan());
    u.update(s(0, 70, "2026-03-10T00:01:00Z"));
    assert.equal(u.snapshot()?.usedBytes, 70);
    u.setPlan(undefined);
    assert.equal(u.snapshot(), undefined);
  });
});

describe("usage-tracker manual used-data offset", () => {
  const march = "2026-03-10T00:00:00Z";
  const mk = (account?: object) =>
    createUsageTracker({
      plan: plan(),
      account: account as never,
      now: () => t(march),
    });

  it("setUsed makes the snapshot show the entered total and counting continues", () => {
    const u = mk();
    u.update(s(0, 0, march));
    const r = u.setUsed(4 * GB);
    assert.equal(r.snapshot?.usedBytes, 4 * GB);
    u.update(s(GB, 0, "2026-03-10T00:10:00Z"));
    assert.equal(u.snapshot()?.usedBytes, 5 * GB);
  });

  it("entering a new figure replaces the earlier correction instead of stacking", () => {
    const u = mk();
    u.update(s(0, 0, march));
    u.setUsed(4 * GB);
    u.update(s(GB, 0, "2026-03-10T00:10:00Z"));
    u.setUsed(6 * GB);
    assert.equal(u.snapshot()?.usedBytes, 6 * GB);
  });

  it("a figure below what was tracked gives a negative offset, never negative usage", () => {
    const u = mk();
    u.update(s(0, 0, march));
    u.update(s(2 * GB, 0, "2026-03-10T00:10:00Z"));
    u.setUsed(GB);
    assert.equal(u.snapshot()?.usedBytes, GB);
    assert.equal(u.account().offsetBytes, -GB);
  });

  it("the level follows the corrected figure at once", () => {
    const u = mk();
    const r = u.setUsed(9 * GB);
    assert.equal(r.level, "warn");
    assert.equal(r.levelChanged, true);
    assert.equal(u.setUsed(9.6 * GB).level, "alarm");
    assert.equal(u.setUsed(GB).level, "normal");
  });

  it("is kept across a restart but dropped when the period ends", () => {
    const u = mk();
    u.update(s(0, 0, march));
    u.setUsed(4 * GB);
    const saved = u.account();
    const again = createUsageTracker({
      plan: plan(),
      account: saved,
      now: () => t(march),
    });
    assert.equal(again.snapshot()?.usedBytes, 4 * GB);
    const next = again.update(s(GB, 0, "2026-04-02T00:00:00Z"));
    assert.equal(next.periodRolledOver, true);
    assert.equal(again.account().offsetBytes, undefined);
    // Only the traffic counted since the rollover remains, no offset.
    assert.equal(again.snapshot(t("2026-04-02T00:00:00Z"))?.usedBytes, GB);
  });

  it("a manual reset drops the offset", () => {
    const u = mk();
    u.setUsed(4 * GB);
    u.reset();
    assert.equal(u.snapshot()?.usedBytes, 0);
    assert.equal(u.account().offsetBytes, undefined);
  });

  it("is refused without a plan or with a bad value", () => {
    const none = createUsageTracker({ now: () => t(march) });
    assert.equal(none.setUsed(GB).ignored, "no plan");
    const u = mk();
    assert.ok(u.setUsed(-1).ignored);
    assert.ok(u.setUsed(Number.NaN).ignored);
    assert.equal(u.snapshot()?.usedBytes, 0);
  });

  it("starts a new period first if the old one ended with no sample since", () => {
    const u = mk();
    u.update(s(0, 0, march));
    u.update(s(GB, 0, "2026-03-10T01:00:00Z"));
    const r = u.setUsed(2 * GB, t("2026-04-05T00:00:00Z"));
    assert.equal(r.periodRolledOver, true);
    assert.equal(r.snapshot?.usedBytes, 2 * GB);
  });
});
