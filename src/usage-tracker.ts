// Plugin-tracked data-plan usage (SPEC §3.2). Pure logic: no I/O, no router
// or Signal K calls. Persistence is the caller's job via account().
//
// Decisions:
// - Plan periods are computed in UTC (the vessel timezone is unknown). A
//   period starts at 00:00 UTC on resetDay, clamped to the month length
//   (31 in February means the 28th/29th).
// - Usage = upload + download deltas. Upload and download are compared
//   independently against the previous counter sample.
// - A counter that goes DOWN is a router counter reset: the new value counts
//   as usage since that reset. Known limitation: a reset hidden by downtime
//   (new value >= old value) is undetectable and under-counts.
// - The first sample ever seen (no lastCounter) is only a baseline.
// - Usage during downtime across period boundaries is attributed to the
//   period containing the sample (it cannot be split); no double counting.
// - A manual offset (setUsed) covers data used before tracking began in the
//   period. It belongs to the current period only: rollover and manual reset
//   drop it. Used = max(0, upload + download + offset).
// - Thresholds escalate immediately and de-escalate only once the ratio is
//   HYSTERESIS below the threshold. Only matters when usage can fall (manual
//   reset, plan change); a period rollover drops the ratio to ~0 anyway.
// - With no (or an invalid) plan only lastCounter is tracked, usage is not
//   accumulated; snapshot() is undefined and the level is "normal".

import type {
  PlanConfig,
  PlanSnapshot,
  TrafficSample,
  UsageAccount,
} from "./types.ts";

export type UsageLevel = "normal" | "warn" | "alarm";

export interface UsageUpdate {
  snapshot: PlanSnapshot | undefined;
  level: UsageLevel;
  /** True when level differs from the previous update's level. */
  levelChanged: boolean;
  /** Bytes (up + down) added to the account by this sample. */
  addedBytes: number;
  /** A router counter reset was detected (counter went down). */
  counterReset: boolean;
  /** A new plan period started because of this sample. */
  periodRolledOver: boolean;
  /** Set when the sample was rejected; the account is untouched. */
  ignored?: string;
}

export interface UsageTrackerOptions {
  plan?: PlanConfig | undefined;
  account?: UsageAccount | undefined;
  now?: () => number;
}

export interface UsageTracker {
  update(sample: TrafficSample): UsageUpdate;
  snapshot(at?: number): PlanSnapshot | undefined;
  account(): UsageAccount;
  setPlan(plan: PlanConfig | undefined): void;
  /**
   * Set the total used so far in the current period (as the carrier shows
   * it) by storing the difference to the tracked bytes as an offset.
   * Does nothing without a valid plan or with an invalid value.
   */
  setUsed(usedBytes: number, at?: number): UsageUpdate;
  /** Manual reset: new period baseline now, usage zeroed, offset dropped. */
  reset(at?: number): UsageUpdate;
  currentLevel(): UsageLevel;
}

/** Absolute ratio margin below a threshold before the level steps down. */
export const HYSTERESIS = 0.02;

const validPlan = (p: PlanConfig | undefined): PlanConfig | undefined =>
  p && Number.isFinite(p.totalBytes) && p.totalBytes > 0 ? p : undefined;

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

function resetInstant(year: number, month: number, resetDay: number): number {
  const len = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Math.trunc(resetDay) || 1), len);
  return Date.UTC(year, month, day);
}

/** Start (epoch ms) of the calendar period containing `at`. */
function periodStartFor(at: number, resetDay: number): number {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const here = resetInstant(y, m, resetDay);
  return at >= here ? here : resetInstant(y, m - 1, resetDay);
}

/** First reset instant strictly after `at`. */
function nextResetAfter(at: number, resetDay: number): number {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const here = resetInstant(y, m, resetDay);
  return at < here ? here : resetInstant(y, m + 1, resetDay);
}

function rawLevel(ratio: number, plan: PlanConfig): UsageLevel {
  if (ratio >= plan.alarmRatio) return "alarm";
  if (ratio >= plan.warnRatio) return "warn";
  return "normal";
}

function withHysteresis(
  prev: UsageLevel,
  ratio: number,
  plan: PlanConfig,
): UsageLevel {
  const raw = rawLevel(ratio, plan);
  const rank = { normal: 0, warn: 1, alarm: 2 } as const;
  if (rank[raw] >= rank[prev]) return raw;
  // Would step down: only if meaningfully below the threshold we hold.
  const held = prev === "alarm" ? plan.alarmRatio : plan.warnRatio;
  if (ratio >= held - HYSTERESIS) return prev;
  // Stepping down from alarm may land on warn, itself subject to hysteresis.
  if (
    prev === "alarm" &&
    raw === "normal" &&
    ratio >= plan.warnRatio - HYSTERESIS
  )
    return "warn";
  return raw;
}

export function createUsageTracker(
  options: UsageTrackerOptions = {},
): UsageTracker {
  const now = options.now ?? Date.now;
  let plan = validPlan(options.plan);

  const freshPeriodStart = (at: number): number =>
    plan ? periodStartFor(at, plan.resetDay) : at;

  const acct: UsageAccount = (() => {
    const a = options.account;
    const startMs = a ? Date.parse(a.periodStart) : Number.NaN;
    if (
      a &&
      Number.isFinite(startMs) &&
      isCount(a.uploadBytes) &&
      isCount(a.downloadBytes)
    ) {
      const out: UsageAccount = {
        periodStart: new Date(startMs).toISOString(),
        uploadBytes: a.uploadBytes,
        downloadBytes: a.downloadBytes,
      };
      if (typeof a.offsetBytes === "number" && Number.isFinite(a.offsetBytes))
        out.offsetBytes = Math.trunc(a.offsetBytes);
      if (
        a.lastCounter &&
        isCount(a.lastCounter.uploadBytes) &&
        isCount(a.lastCounter.downloadBytes)
      ) {
        out.lastCounter = { ...a.lastCounter };
      }
      return out;
    }
    return {
      periodStart: new Date(freshPeriodStart(now())).toISOString(),
      uploadBytes: 0,
      downloadBytes: 0,
    };
  })();

  const buildSnapshot = (at: number): PlanSnapshot | undefined => {
    if (!plan) return undefined;
    let start = Date.parse(acct.periodStart);
    let used = Math.max(
      0,
      acct.uploadBytes + acct.downloadBytes + (acct.offsetBytes ?? 0),
    );
    const calendar = periodStartFor(at, plan.resetDay);
    if (calendar > start) {
      start = calendar;
      used = 0;
    }
    return {
      totalBytes: plan.totalBytes,
      usedBytes: used,
      remainingBytes: Math.max(0, plan.totalBytes - used),
      usedRatio: used / plan.totalBytes,
      periodEnd: new Date(nextResetAfter(start, plan.resetDay)).toISOString(),
    };
  };

  let level: UsageLevel = (() => {
    const snap = buildSnapshot(now());
    return plan && snap ? rawLevel(snap.usedRatio, plan) : "normal";
  })();

  const refreshLevel = (snap: PlanSnapshot | undefined): boolean => {
    const next =
      plan && snap ? withHysteresis(level, snap.usedRatio, plan) : "normal";
    const changed = next !== level;
    level = next;
    return changed;
  };

  return {
    update(sample) {
      const ignoredResult = (reason: string): UsageUpdate => ({
        snapshot: buildSnapshot(
          Number.isFinite(sample?.at) ? sample.at : now(),
        ),
        level,
        levelChanged: false,
        addedBytes: 0,
        counterReset: false,
        periodRolledOver: false,
        ignored: reason,
      });
      if (!sample || !Number.isFinite(sample.at))
        return ignoredResult("invalid timestamp");
      if (!isCount(sample.uploadBytes) || !isCount(sample.downloadBytes)) {
        return ignoredResult("invalid counter value");
      }

      let periodRolledOver = false;
      if (plan) {
        const calendar = periodStartFor(sample.at, plan.resetDay);
        if (calendar > Date.parse(acct.periodStart)) {
          acct.periodStart = new Date(calendar).toISOString();
          acct.uploadBytes = 0;
          acct.downloadBytes = 0;
          delete acct.offsetBytes;
          periodRolledOver = true;
        }
      }

      let addedUp = 0;
      let addedDown = 0;
      let counterReset = false;
      const last = acct.lastCounter;
      if (last) {
        const delta = (cur: number, prev: number): number => {
          if (cur >= prev) return cur - prev;
          counterReset = true;
          return cur;
        };
        addedUp = delta(sample.uploadBytes, last.uploadBytes);
        addedDown = delta(sample.downloadBytes, last.downloadBytes);
      }
      acct.lastCounter = {
        uploadBytes: sample.uploadBytes,
        downloadBytes: sample.downloadBytes,
      };
      if (plan) {
        acct.uploadBytes += addedUp;
        acct.downloadBytes += addedDown;
      }
      const snapshot = buildSnapshot(sample.at);
      const levelChanged = refreshLevel(snapshot);
      return {
        snapshot,
        level,
        levelChanged,
        addedBytes: plan ? addedUp + addedDown : 0,
        counterReset,
        periodRolledOver,
      };
    },

    snapshot(at) {
      return buildSnapshot(at ?? now());
    },

    account() {
      const out: UsageAccount = {
        periodStart: acct.periodStart,
        uploadBytes: acct.uploadBytes,
        downloadBytes: acct.downloadBytes,
      };
      if (acct.offsetBytes) out.offsetBytes = acct.offsetBytes;
      if (acct.lastCounter) out.lastCounter = { ...acct.lastCounter };
      return out;
    },

    setPlan(next) {
      plan = validPlan(next);
      refreshLevel(buildSnapshot(now()));
    },

    setUsed(usedBytes, at) {
      const when = at ?? now();
      const unchanged = (reason: string): UsageUpdate => ({
        snapshot: buildSnapshot(when),
        level,
        levelChanged: false,
        addedBytes: 0,
        counterReset: false,
        periodRolledOver: false,
        ignored: reason,
      });
      if (!plan) return unchanged("no plan");
      if (!isCount(usedBytes)) return unchanged("invalid value");
      // A period may have ended with no sample since; start the new one first.
      let periodRolledOver = false;
      const calendar = periodStartFor(when, plan.resetDay);
      if (calendar > Date.parse(acct.periodStart)) {
        acct.periodStart = new Date(calendar).toISOString();
        acct.uploadBytes = 0;
        acct.downloadBytes = 0;
        periodRolledOver = true;
      }
      const offset = Math.round(
        usedBytes - (acct.uploadBytes + acct.downloadBytes),
      );
      if (offset === 0) delete acct.offsetBytes;
      else acct.offsetBytes = offset;
      const snapshot = buildSnapshot(when);
      // An explicit correction sets the level outright, no hysteresis.
      const before = level;
      level = snapshot ? rawLevel(snapshot.usedRatio, plan) : "normal";
      return {
        snapshot,
        level,
        levelChanged: level !== before,
        addedBytes: 0,
        counterReset: false,
        periodRolledOver,
      };
    },

    reset(at) {
      const when = at ?? now();
      acct.periodStart = new Date(when).toISOString();
      acct.uploadBytes = 0;
      acct.downloadBytes = 0;
      delete acct.offsetBytes;
      const snapshot = buildSnapshot(when);
      level = "normal";
      return {
        snapshot,
        level,
        levelChanged: false,
        addedBytes: 0,
        counterReset: false,
        periodRolledOver: false,
      };
    },

    currentLevel() {
      return level;
    },
  };
}
