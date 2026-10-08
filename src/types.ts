// Shared domain types. They follow docs/SPEC.md §4. Numeric signal values
// are in the router's own units (dBm / dB), see SPEC §6.4. Every field
// that the router may omit is optional: field names read from the router
// are unverified until real captures exist (SPEC §13.1).

export type LinkState = "connecting" | "ok" | "auth-failed" | "unreachable";

export interface SignalSample {
  rssi?: number; // dBm
  rsrp?: number; // dBm
  rsrq?: number; // dB
  sinr?: number; // dB
  band?: string;
  cellId?: string;
  pci?: string;
  networkType?: string; // e.g. "LTE", "LTE-A"
}

export interface OperatorInfo {
  name?: string;
  plmn?: string;
}

export interface ConnectionStatus {
  /** Router reports an active data connection. */
  connected: boolean;
  /** Registered on a network. False means "No service". */
  serviceAvailable: boolean;
  roaming?: boolean;
  bars?: number; // 0-5
  wanIp?: string;
  uptimeSeconds?: number;
}

/** Cumulative traffic counters since the router last reset them. */
export interface TrafficSample {
  uploadBytes: number;
  downloadBytes: number;
  /** Epoch milliseconds when the sample was taken. */
  at: number;
}

export interface PlanConfig {
  totalBytes: number;
  /** Day of month the plan period restarts, 1-31 (clamped to the month length). */
  resetDay: number;
  warnRatio: number; // default 0.8
  alarmRatio: number; // default 0.95
}

/** Plugin-tracked usage for the current plan period. Persisted. */
export interface UsageAccount {
  /** ISO timestamp of the start of the current plan period. */
  periodStart: string;
  uploadBytes: number;
  downloadBytes: number;
  /** Last router counter sample, used to compute deltas. */
  lastCounter?: { uploadBytes: number; downloadBytes: number };
}

export interface PlanSnapshot {
  totalBytes: number;
  usedBytes: number;
  remainingBytes: number;
  usedRatio: number;
  /** ISO timestamp of the next reset. */
  periodEnd: string;
}

/** The router's own inbox totals (sms/sms-count). */
export interface SmsCounts {
  inbox: number;
  unread: number;
}

/** One page of the inbox. */
export interface SmsPage {
  messages: SmsMessage[];
  /** Unread delivery reports left out of `messages`; the router counts them as unread. */
  unreadReports: number;
  /** The delivery reports on this page, newest first as the router lists them. */
  reports: SmsReport[];
}

/**
 * A delivery report the router filed in the inbox. It has no text: only the
 * recipient's number and when the report arrived.
 */
export interface SmsReport {
  /** Same derivation as SmsMessage.id, so a report is recognised on later polls. */
  id: string;
  peer: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** Progress of an outgoing message. */
export type SmsDelivery =
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "unknown";

export interface SmsMessage {
  /** Stable id: derived from router index, date and sender (see SmsStore). */
  id: string;
  /** The router's own message index. May be reused after deletion. */
  index: number;
  direction: "in" | "out";
  peer: string;
  text: string;
  /** ISO timestamp. */
  timestamp: string;
  read: boolean;
  /** Outgoing messages only. Kept by the plugin, the router has no outbox for us. */
  delivery?: SmsDelivery;
}

export interface PluginConfig {
  routerUrl: string;
  username: string;
  password: string;
  signalPollSeconds: number;
  trafficPollSeconds: number;
  smsPollSeconds: number;
  notifyNewSms: boolean;
  plan?: PlanConfig;
}

/** Response of GET /status. */
export interface StatusSnapshot {
  link: LinkState;
  /** ISO timestamp of the last successful poll, if any. */
  updatedAt?: string;
  signal?: SignalSample;
  operator?: OperatorInfo;
  connection?: ConnectionStatus;
  plan?: PlanSnapshot;
  sms: { unread: number; lastMessage?: string; lastMessageTime?: string };
}
