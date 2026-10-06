// Pure helpers for the webapp. No DOM, no network: importable from Node tests.

const toNum = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Decimal units, as routers and carriers count data. */
export function formatBytes(bytes) {
  const n = toNum(bytes);
  if (n === undefined) return "-";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const text =
    i === 0 && Number.isInteger(v * 10) && v < 10
      ? v.toFixed(1)
      : v.toFixed(digits);
  return `${text} ${units[i]}`;
}

export function formatNumber(value, unit) {
  const n = toNum(value);
  if (n === undefined) return "-";
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

// Same bands as the Signal K meta zones (SPEC 6.4).
const BANDS = {
  rsrp: { green: -105, amber: -115 },
  sinr: { green: 5, amber: 0 },
};

/** @returns {"green"|"amber"|"red"|"neutral"} */
export function metricState(metric, value, { stale = false } = {}) {
  const n = toNum(value);
  const band = BANDS[metric];
  if (stale || n === undefined || !band) return "neutral";
  if (n >= band.green) return "green";
  if (n >= band.amber) return "amber";
  return "red";
}

export function planState(ratio, warn = 0.8, alarm = 0.95) {
  const n = toNum(ratio);
  if (n === undefined) return "neutral";
  if (n >= alarm) return "red";
  if (n >= warn) return "amber";
  return "green";
}

export const STALE_AFTER_MS = 60_000;

export function isStale(updatedAt, now, link, maxAge = STALE_AFTER_MS) {
  if (link !== "ok") return true;
  const t = Date.parse(updatedAt ?? "");
  if (Number.isNaN(t)) return true;
  return now - t > maxAge;
}

export function formatAge(ms) {
  const n = toNum(ms);
  if (n === undefined) return "never";
  if (n < 0) return "now";
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function daysUntil(iso, now) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXT = new Set("^{}\\[~]|€\f");

/**
 * Count SMS segments. GSM 7-bit: 160 single / 153 concatenated, extension
 * characters take two septets. Anything else forces UCS2: 70 / 67 UTF-16 units.
 */
export function smsSegments(text) {
  const chars = Array.from(String(text ?? ""));
  let septets = 0;
  let gsm = true;
  for (const c of chars) {
    if (GSM_BASIC.has(c)) septets += 1;
    else if (GSM_EXT.has(c)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  const encoding = gsm ? "gsm7" : "ucs2";
  const length = gsm ? septets : String(text).length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  const segments =
    length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
  const perSegment = segments <= 1 ? single : multi;
  const remaining = segments <= 1 ? single - length : segments * multi - length;
  return { encoding, length, segments, perSegment, remaining };
}

// Display ranges for the bars (SPEC 6.4 displayScale for RSRP).
const RANGES = {
  rsrp: [-140, -40],
  rssi: [-110, -50],
  rsrq: [-20, -3],
  sinr: [-10, 30],
};

export function metricFraction(metric, value) {
  const n = toNum(value);
  const r = RANGES[metric];
  if (n === undefined || !r) return 0;
  return Math.min(1, Math.max(0, (n - r[0]) / (r[1] - r[0])));
}

/**
 * How to report the answer to a send. `unknown` means the router took the
 * message but never confirmed it went out, which must not read as success.
 */
export function sendOutcome(response) {
  if (response?.status === "unknown") {
    return {
      kind: "warn",
      message:
        "The router accepted the message but did not confirm it was sent. Check before sending again.",
    };
  }
  return { kind: "ok", message: "Message sent." };
}

/**
 * Why a write was refused. A Signal K server answers a signed-in user who is
 * not an admin with 401 ("please log in"), the same as someone not signed in
 * at all, so the two are told apart by whether reads are working.
 */
export function writeDenial(status, signedIn) {
  if (status === 403) return "admin";
  if (status === 401) return signedIn ? "admin" : "login";
  return null;
}
