import { smsId } from "./sms-id.ts";
import type {
  ConnectionStatus,
  OperatorInfo,
  SignalSample,
  SmsMessage,
  TrafficSample,
} from "./types.ts";

// ---------------------------------------------------------------------------
// FIELD NAME TABLE. ALL FIELD NAMES ARE UNVERIFIED (SPEC §13.1): no real
// capture exists yet, so every name below is a guess from community
// knowledge of Huawei firmwares. This is the ONE place to change once
// fixtures from a real B311-221 exist.
//
// Matching is tolerant: a response key matches a candidate when both are
// equal after lower-casing and dropping "_" and "-". So "cellid" covers
// cell_id, CellID and cellId. Candidates are tried in order; the first one
// that is present with a non-empty value wins.
// ---------------------------------------------------------------------------
export const FIELDS = {
  // device/signal
  signal: {
    rssi: ["rssi"],
    rsrp: ["rsrp"],
    rsrq: ["rsrq"],
    sinr: ["sinr", "snr"],
    band: ["band"],
    cellId: ["cellid"],
    pci: ["pci"],
    networkType: ["workmode", "networktype"],
  },
  // net/current-plmn
  operator: {
    fullName: ["fullname", "operatorname", "spn"],
    shortName: ["shortname"],
    plmn: ["numeric", "plmn"],
  },
  // monitoring/status
  status: {
    connectionStatus: ["connectionstatus"], // 901 = connected
    bars: ["signalicon", "signalbars", "signaliconnr"],
    roaming: ["roamingstatus", "roaming"], // 1 = roaming
    serviceStatus: ["servicestatus"], // 2 = valid service
    networkTypeCode: ["currentnetworktype", "currentnetworktypeex"], // 0 = none
  },
  // device/information. The WAN address and the router's uptime (seconds
  // since boot) are not in monitoring/status on a real B311-221.
  info: {
    wanIp: ["wanipaddress", "wanip"],
    uptime: ["uptime"],
  },
  // monitoring/traffic-statistics. The cumulative "Total" counters feed plan
  // tracking (docs/OPEN_QUESTIONS.md D5); the "Current" ones are the
  // session counters and are deliberately not used.
  traffic: {
    upload: ["totalupload"],
    download: ["totaldownload"],
  },
  // sms/sms-list
  smsList: {
    container: ["messages"],
    item: ["message"],
  },
  sms: {
    index: ["index"],
    status: ["smstat"], // 0 = new/unread, 1 = read
    phone: ["phone"],
    content: ["content"],
    date: ["date"],
  },
  // sms/send-status
  sendStatus: {
    pending: ["phone"],
    succeeded: ["sucphone"],
    failed: ["failphone"],
    total: ["totalcount"],
    current: ["curindex"],
  },
} as const;

/** monitoring/status ConnectionStatus value meaning "connected". */
const CONNECTED = 901;
/** monitoring/status ServiceStatus value meaning "service available". */
const SERVICE_VALID = 2;
/** CurrentNetworkType codes, from community knowledge of Huawei firmwares. Unverified. */
const NETWORK_TYPES: Record<number, string> = {
  1: "GSM",
  2: "GPRS",
  3: "EDGE",
  4: "WCDMA",
  5: "HSDPA",
  6: "HSUPA",
  7: "HSPA",
  9: "HSPA+",
  19: "LTE",
  101: "LTE-A",
};

const norm = (k: string): string => k.toLowerCase().replace(/[_-]/g, "");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-empty trimmed string for a string or number, else undefined. */
function text(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** The raw value for the first candidate present and non-empty. */
function pick(obj: unknown, candidates: readonly string[]): unknown {
  if (!isObj(obj)) return undefined;
  const byName = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) byName.set(norm(k), v);
  for (const c of candidates) {
    const v = byName.get(c);
    if (isObj(v) || Array.isArray(v) || text(v) !== undefined) return v;
  }
  return undefined;
}

const pickText = (obj: unknown, c: readonly string[]): string | undefined => {
  const v = pick(obj, c);
  return isObj(v) || Array.isArray(v) ? undefined : text(v);
};

const compact = <T extends object>(o: T): T => {
  for (const k of Object.keys(o)) {
    if ((o as Obj)[k] === undefined) delete (o as Obj)[k];
  }
  return o;
};

/**
 * Parses a signal figure such as "-98dBm", "9dB", ">=20dB" or "<-20dB".
 * A comparison prefix is dropped and the bound itself returned. Empty,
 * missing or non-numeric input gives undefined.
 */
export function parseDbValue(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const t = text(raw);
  if (t === undefined) return undefined;
  const m = /^(?:[<>]=?|[≤≥])?\s*(-?\d+(?:\.\d+)?)\s*[A-Za-z%]*$/.exec(t);
  return m ? Number(m[1]) : undefined;
}

/** A whole number from a numeric string; undefined otherwise. */
function parseInteger(raw: unknown): number | undefined {
  const t = text(raw);
  if (t === undefined || !/^-?\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function parseSignal(obj: unknown): SignalSample {
  const f = FIELDS.signal;
  return compact({
    rssi: parseDbValue(pick(obj, f.rssi)),
    rsrp: parseDbValue(pick(obj, f.rsrp)),
    rsrq: parseDbValue(pick(obj, f.rsrq)),
    sinr: parseDbValue(pick(obj, f.sinr)),
    band: pickText(obj, f.band),
    cellId: pickText(obj, f.cellId),
    pci: pickText(obj, f.pci),
    networkType: pickText(obj, f.networkType),
  });
}

/** Empty when the router reports no registration (no names, no PLMN). */
export function parseOperator(obj: unknown): OperatorInfo {
  const f = FIELDS.operator;
  return compact({
    name: pickText(obj, f.fullName) ?? pickText(obj, f.shortName),
    plmn: pickText(obj, f.plmn),
  });
}

export function networkTypeFromCode(code: unknown): string | undefined {
  const n = parseInteger(code);
  return n === undefined ? undefined : NETWORK_TYPES[n];
}

/** ConnectionStatus plus the radio technology name, when the router gave one. */
export type ConnectionDetails = ConnectionStatus & { networkType?: string };

/**
 * `serviceAvailable` follows the first evidence found: ServiceStatus, then a
 * non-zero network type, then "connected or showing signal bars". With no
 * fields at all it is false.
 */
export function parseConnection(
  obj: unknown,
  info?: unknown,
): ConnectionDetails {
  const f = FIELDS.status;
  const code = parseInteger(pick(obj, f.connectionStatus));
  const connected = code === CONNECTED;
  const rawBars = parseInteger(pick(obj, f.bars));
  const bars =
    rawBars === undefined ? undefined : Math.min(5, Math.max(0, rawBars));
  const roamingRaw = parseInteger(pick(obj, f.roaming));
  const service = parseInteger(pick(obj, f.serviceStatus));
  const typeCode = parseInteger(pick(obj, f.networkTypeCode));
  let serviceAvailable: boolean;
  if (service !== undefined) serviceAvailable = service === SERVICE_VALID;
  else if (typeCode !== undefined) serviceAvailable = typeCode !== 0;
  else serviceAvailable = connected || (bars ?? 0) > 0;
  return compact({
    connected,
    serviceAvailable,
    roaming: roamingRaw === undefined ? undefined : roamingRaw === 1,
    bars,
    wanIp: pickText(info, FIELDS.info.wanIp),
    uptimeSeconds: parseInteger(pick(info, FIELDS.info.uptime)),
    networkType: networkTypeFromCode(pick(obj, f.networkTypeCode)),
  });
}

/** Undefined when either cumulative counter is missing or not a number. */
export function parseTraffic(
  obj: unknown,
  at: number,
): TrafficSample | undefined {
  const f = FIELDS.traffic;
  const up = parseInteger(pick(obj, f.upload));
  const down = parseInteger(pick(obj, f.download));
  if (up === undefined || down === undefined || up < 0 || down < 0) {
    return undefined;
  }
  return { uploadBytes: up, downloadBytes: down, at };
}

const ROUTER_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * The router reports dates as "YYYY-MM-DD HH:MM:SS" without a timezone. They
 * are read as the Signal K server's local time (decision, unverified) and
 * returned as an ISO UTC string.
 */
export function routerDateToIso(raw: unknown): string | undefined {
  const t = text(raw);
  const m = t === undefined ? null : ROUTER_DATE.exec(t);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  const date = new Date(
    y as number,
    (mo as number) - 1,
    d as number,
    h as number,
    mi as number,
    s as number,
  );
  // `new Date` rolls impossible values over (month 13, 30 February), so check
  // that every part survived.
  const same =
    date.getFullYear() === y &&
    date.getMonth() === (mo as number) - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi &&
    date.getSeconds() === s;
  return same ? date.toISOString() : undefined;
}

/**
 * The inverse of `routerDateToIso`: a moment as the router's wall-clock
 * string, in the same convention (the Signal K server's local time).
 */
export function formatRouterDate(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return isObj(v) ? [v] : [];
}

/**
 * Messages from an sms-list answer. A single `<Message>` and a list both work;
 * entries without a usable index are skipped (they cannot be acted on). The id
 * hashes the router's raw date string, so it is independent of timezone.
 * A message with no Smstat counts as read.
 */
export function parseSmsList(
  obj: unknown,
  ctx: { nowMs: number; direction?: "in" | "out" },
): SmsMessage[] {
  const f = FIELDS.smsList;
  const container = pick(obj, f.container);
  const items = asList(
    isObj(container) ? pick(container, f.item) : pick(obj, f.item),
  );
  const out: SmsMessage[] = [];
  for (const item of items) {
    const index = parseInteger(pick(item, FIELDS.sms.index));
    if (index === undefined || index < 0) continue;
    const peer = pickText(item, FIELDS.sms.phone) ?? "";
    const rawDate = pickText(item, FIELDS.sms.date) ?? "";
    const rawContent = isObj(item) ? pick(item, FIELDS.sms.content) : undefined;
    const content = typeof rawContent === "string" ? rawContent : "";
    const status = parseInteger(pick(item, FIELDS.sms.status));
    out.push({
      id: smsId(index, rawDate, peer),
      index,
      direction: ctx.direction ?? "in",
      peer,
      text: content,
      timestamp: routerDateToIso(rawDate) ?? new Date(ctx.nowMs).toISOString(),
      read: status !== 0,
    });
  }
  return out;
}

export interface SendStatus {
  /** The router has finished with the message (sent or failed). */
  done: boolean;
  /** Meaningful when `done`. */
  ok: boolean;
}

/**
 * sms/send-status. A failure number means failed; a success number with
 * nothing still pending means sent; anything else is still in progress.
 */
export function parseSendStatus(obj: unknown): SendStatus {
  const f = FIELDS.sendStatus;
  if (pickText(obj, f.failed) !== undefined) return { done: true, ok: false };
  const pending = pickText(obj, f.pending) !== undefined;
  const sucOk = pickText(obj, f.succeeded) !== undefined;
  const total = parseInteger(pick(obj, f.total));
  const current = parseInteger(pick(obj, f.current));
  const allDone =
    total !== undefined && current !== undefined && current >= total;
  if (sucOk && (!pending || allDone)) return { done: true, ok: true };
  return { done: false, ok: false };
}
