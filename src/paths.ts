// The single table mapping domain fields to Signal K paths and their meta
// (SPEC §6.1, §6.4). A path rename is a change in this file only.
// Meta uses only fields the specification defines: units, displayName
// (without units), description, displayScale, zones.

import {
  RSRP_ALARM_DBM,
  RSRP_WARN_DBM,
  SINR_ALARM_DB,
  SINR_WARN_DB,
} from "./radio-quality.ts";

export const PATHS = {
  rssi: "networking.lte.rssi",
  rsrp: "networking.lte.rsrp",
  rsrq: "networking.lte.rsrq",
  sinr: "networking.lte.sinr",
  bars: "networking.lte.bars",
  radioQuality: "networking.lte.radioQuality",
  connectionType: "networking.lte.connectionType",
  registerNetworkDisplay: "networking.lte.registerNetworkDisplay",
  connectionText: "networking.lte.connectionText",
  curBand: "networking.lte.curBand",
  cellId: "networking.lte.cellId",
  pci: "networking.lte.pci",
  roaming: "networking.lte.roaming",
  wanIp: "networking.wan.ip",
  modemUptime: "networking.modem.uptime",
  usageRx: "networking.lte.usage.rx",
  usageTx: "networking.lte.usage.tx",
  planTotalBytes: "networking.lte.plan.totalBytes",
  planUsedBytes: "networking.lte.plan.usedBytes",
  planRemainingBytes: "networking.lte.plan.remainingBytes",
  planUsedRatio: "networking.lte.plan.usedRatio",
  planPeriodEnd: "networking.lte.plan.periodEnd",
  lastMessage: "networking.lte.lastMessage",
  lastMessageTime: "networking.lte.lastMessageTime",
  smsUnread: "networking.lte.sms.unread",
  routerLink: "networking.lte.routerLink",
} as const;

export type PathKey = keyof typeof PATHS;
export type SkPath = (typeof PATHS)[PathKey];

/** Notification paths, all under `notifications.networking.lte.`. */
export const NOTIFICATION_PREFIX = "notifications.networking.lte";

export interface Zone {
  lower?: number;
  upper?: number;
  state: "normal" | "alert" | "warn" | "alarm" | "emergency";
  message: string;
}

export interface Meta {
  displayName: string;
  description: string;
  units?: string;
  displayScale?: { lower: number; upper: number; type: "linear" };
  zones?: Zone[];
}

export const RSRP_ZONES: Zone[] = [
  { upper: RSRP_ALARM_DBM, state: "alarm", message: "LTE signal very weak" },
  {
    lower: RSRP_ALARM_DBM,
    upper: RSRP_WARN_DBM,
    state: "warn",
    message: "LTE signal weak",
  },
  { lower: RSRP_WARN_DBM, state: "normal", message: "LTE signal good" },
];

export const SINR_ZONES: Zone[] = [
  { upper: SINR_ALARM_DB, state: "alarm", message: "LTE signal noisy" },
  {
    lower: SINR_ALARM_DB,
    upper: SINR_WARN_DB,
    state: "warn",
    message: "LTE signal quality low",
  },
  { lower: SINR_WARN_DB, state: "normal", message: "LTE signal quality good" },
];

const linear = (lower: number, upper: number) =>
  ({ lower, upper, type: "linear" }) as const;

export const META: Record<SkPath, Meta> = {
  [PATHS.rssi]: {
    displayName: "RSSI",
    description: "Received signal strength indicator of the LTE link, in dBm",
    units: "dBm",
    displayScale: linear(-110, -50),
  },
  [PATHS.rsrp]: {
    displayName: "RSRP",
    description: "LTE reference signal received power, in dBm",
    units: "dBm",
    displayScale: linear(-140, -40),
    zones: RSRP_ZONES,
  },
  [PATHS.rsrq]: {
    displayName: "RSRQ",
    description: "LTE reference signal received quality, in dB",
    units: "dB",
    displayScale: linear(-20, 0),
  },
  [PATHS.sinr]: {
    displayName: "SINR",
    description: "LTE signal to interference plus noise ratio, in dB",
    units: "dB",
    displayScale: linear(-10, 30),
    zones: SINR_ZONES,
  },
  [PATHS.bars]: {
    displayName: "Signal bars",
    description: "Signal strength as bars shown by the router, 0 to 5",
    displayScale: linear(0, 5),
  },
  [PATHS.radioQuality]: {
    displayName: "Radio quality",
    description:
      "Overall radio quality from 0 (poor) to 1 (good), derived from RSRP and SINR",
    units: "ratio",
    displayScale: linear(0, 1),
  },
  [PATHS.connectionType]: {
    displayName: "Network type",
    description: "Mobile network technology in use, such as LTE or LTE-A",
  },
  [PATHS.registerNetworkDisplay]: {
    displayName: "Operator",
    description:
      "Name of the mobile network operator the router is registered to",
  },
  [PATHS.connectionText]: {
    displayName: "Connection",
    description:
      "Operator name when registered on a network, or the text No service",
  },
  [PATHS.curBand]: {
    displayName: "Band",
    description: "LTE frequency band in use",
  },
  [PATHS.cellId]: {
    displayName: "Cell ID",
    description: "Identifier of the serving cell",
  },
  [PATHS.pci]: {
    displayName: "PCI",
    description: "Physical cell identifier of the serving cell",
  },
  [PATHS.roaming]: {
    displayName: "Roaming",
    description: "True when the router is roaming on a foreign network",
  },
  [PATHS.wanIp]: {
    displayName: "WAN IP",
    description: "IP address of the router on the mobile network",
  },
  [PATHS.modemUptime]: {
    displayName: "Router uptime",
    description: "Time since the router last connected, in seconds",
    units: "s",
  },
  [PATHS.usageRx]: {
    displayName: "Data received",
    description: "Data received as counted by the router, in bytes",
    units: "B",
  },
  [PATHS.usageTx]: {
    displayName: "Data sent",
    description: "Data sent as counted by the router, in bytes",
    units: "B",
  },
  [PATHS.planTotalBytes]: {
    displayName: "Plan size",
    description: "Data allowance of the current plan period, in bytes",
    units: "B",
  },
  [PATHS.planUsedBytes]: {
    displayName: "Plan used",
    description: "Data used in the current plan period, in bytes",
    units: "B",
  },
  [PATHS.planRemainingBytes]: {
    displayName: "Plan remaining",
    description: "Data left in the current plan period, in bytes",
    units: "B",
  },
  [PATHS.planUsedRatio]: {
    displayName: "Plan used share",
    description: "Share of the data plan used, from 0 to 1 (may exceed 1)",
    units: "ratio",
    displayScale: linear(0, 1),
  },
  [PATHS.planPeriodEnd]: {
    displayName: "Plan period end",
    description: "ISO 8601 time at which the current plan period ends",
  },
  [PATHS.lastMessage]: {
    displayName: "Last SMS",
    description: "Text of the latest received SMS, shortened",
  },
  [PATHS.lastMessageTime]: {
    displayName: "Last SMS time",
    description: "ISO 8601 time the latest received SMS arrived",
  },
  [PATHS.smsUnread]: {
    displayName: "Unread SMS",
    description: "Number of unread SMS messages on the router",
  },
  [PATHS.routerLink]: {
    displayName: "Router link",
    description:
      "State of the plugin's connection to the router: connecting, ok, auth-failed or unreachable",
  },
};
