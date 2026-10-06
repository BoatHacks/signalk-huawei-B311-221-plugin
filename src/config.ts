import type { PlanConfig, PluginConfig } from "./types.ts";

/** Decimal gigabyte, as carriers quote plan sizes. */
export const GB = 1_000_000_000;

export const DEFAULTS = {
  routerUrl: "http://192.168.8.1",
  username: "admin",
  signalPollSeconds: 10,
  trafficPollSeconds: 60,
  smsPollSeconds: 60,
  notifyNewSms: true,
  planResetDay: 1,
  planWarnPercent: 80,
  planAlarmPercent: 95,
} as const;

/** Polling faster than this risks overloading the router's small web server. */
const MIN_SECONDS = { signal: 5, traffic: 30, sms: 30 } as const;

export interface NormalizedConfig {
  config: PluginConfig;
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function interval(raw: unknown, fallback: number, min: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, raw);
}

function routerUrl(raw: unknown, errors: string[]): string {
  if (raw === undefined || raw === "") return DEFAULTS.routerUrl;
  if (typeof raw !== "string") {
    errors.push("routerUrl must be a string");
    return DEFAULTS.routerUrl;
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    errors.push(`routerUrl is not a valid URL: ${raw.trim() || "(empty)"}`);
    return DEFAULTS.routerUrl;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push("routerUrl must start with http:// or https://");
    return DEFAULTS.routerUrl;
  }
  if (url.username || url.password) {
    errors.push(
      "routerUrl must not contain credentials; use the username and password fields",
    );
    return DEFAULTS.routerUrl;
  }
  return url.origin;
}

function plan(raw: unknown, errors: string[]): PlanConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const sizeGB = raw.sizeGB;
  if (typeof sizeGB !== "number" || !Number.isFinite(sizeGB) || sizeGB <= 0)
    return undefined;

  const problems: string[] = [];
  const resetDay =
    raw.resetDay === undefined ? DEFAULTS.planResetDay : raw.resetDay;
  if (
    typeof resetDay !== "number" ||
    !Number.isInteger(resetDay) ||
    resetDay < 1 ||
    resetDay > 31
  ) {
    problems.push("plan.resetDay must be a whole number from 1 to 31");
  }
  const warn =
    raw.warnPercent === undefined ? DEFAULTS.planWarnPercent : raw.warnPercent;
  const alarm =
    raw.alarmPercent === undefined
      ? DEFAULTS.planAlarmPercent
      : raw.alarmPercent;
  const okPercent = (p: unknown) =>
    typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 100;
  if (!okPercent(warn))
    problems.push("plan.warnPercent must be above 0 and at most 100");
  if (!okPercent(alarm))
    problems.push("plan.alarmPercent must be above 0 and at most 100");
  if (
    okPercent(warn) &&
    okPercent(alarm) &&
    (warn as number) >= (alarm as number)
  ) {
    problems.push("plan.warnPercent must be lower than plan.alarmPercent");
  }
  if (problems.length > 0) {
    errors.push(
      ...problems,
      "Data plan tracking is off until the plan settings are fixed",
    );
    return undefined;
  }
  return {
    totalBytes: sizeGB * GB,
    resetDay: resetDay as number,
    warnRatio: (warn as number) / 100,
    alarmRatio: (alarm as number) / 100,
  };
}

/**
 * Turns the raw plugin configuration into a validated one. Never throws:
 * problems are returned as readable messages so the plugin can show them as
 * its status and keep running with safe defaults where that is sensible.
 */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const errors: string[] = [];
  const src = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) errors.push("Plugin configuration is missing");

  const password = typeof src.password === "string" ? src.password : "";
  if (!password)
    errors.push("password is required (the router's admin password)");

  const username =
    typeof src.username === "string" && src.username.trim()
      ? src.username.trim()
      : DEFAULTS.username;

  const config: PluginConfig = {
    routerUrl: routerUrl(src.routerUrl, errors),
    username,
    password,
    signalPollSeconds: interval(
      src.signalPollSeconds,
      DEFAULTS.signalPollSeconds,
      MIN_SECONDS.signal,
    ),
    trafficPollSeconds: interval(
      src.trafficPollSeconds,
      DEFAULTS.trafficPollSeconds,
      MIN_SECONDS.traffic,
    ),
    smsPollSeconds: interval(
      src.smsPollSeconds,
      DEFAULTS.smsPollSeconds,
      MIN_SECONDS.sms,
    ),
    notifyNewSms:
      typeof src.notifyNewSms === "boolean"
        ? src.notifyNewSms
        : DEFAULTS.notifyNewSms,
    plan: plan(src.plan, errors),
  };
  return { config, errors };
}

/** JSON schema for the Signal K admin plugin-configuration form. */
export function configSchema(): object {
  return {
    type: "object",
    required: ["password"],
    properties: {
      routerUrl: {
        type: "string",
        title: "Router address",
        description: "Address of the B311-221 on the boat network.",
        default: DEFAULTS.routerUrl,
      },
      username: {
        type: "string",
        title: "Router username",
        default: DEFAULTS.username,
      },
      password: {
        type: "string",
        title: "Router admin password",
        description:
          "Stored in the Signal K server's plugin configuration. Logging in can log you out of the router's own web page.",
        format: "password",
      },
      signalPollSeconds: {
        type: "number",
        title: "Signal and status update interval (seconds)",
        description: `At least ${MIN_SECONDS.signal}.`,
        default: DEFAULTS.signalPollSeconds,
      },
      trafficPollSeconds: {
        type: "number",
        title: "Data usage update interval (seconds)",
        description: `At least ${MIN_SECONDS.traffic}.`,
        default: DEFAULTS.trafficPollSeconds,
      },
      smsPollSeconds: {
        type: "number",
        title: "SMS check interval (seconds)",
        description: `At least ${MIN_SECONDS.sms}.`,
        default: DEFAULTS.smsPollSeconds,
      },
      notifyNewSms: {
        type: "boolean",
        title: "Raise a notification for each new SMS",
        default: DEFAULTS.notifyNewSms,
      },
      plan: {
        type: "object",
        title: "Data plan",
        description: "Leave the size empty to turn plan tracking off.",
        properties: {
          sizeGB: {
            type: "number",
            title: "Plan size (GB, decimal)",
          },
          resetDay: {
            type: "integer",
            title: "Day of month the plan resets",
            minimum: 1,
            maximum: 31,
            default: DEFAULTS.planResetDay,
          },
          warnPercent: {
            type: "number",
            title: "Warn at (% used)",
            default: DEFAULTS.planWarnPercent,
          },
          alarmPercent: {
            type: "number",
            title: "Alarm at (% used)",
            default: DEFAULTS.planAlarmPercent,
          },
        },
      },
    },
  };
}
