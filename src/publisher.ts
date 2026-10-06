// Maps domain objects to Signal K deltas, meta and notifications
// (SPEC §6.1, §6.4, ARCHITECTURE §2.5). Depends only on a minimal sink, so
// it never touches the router client. Values are in the router's units.
//
// Paths are never zeroed or nulled when the router goes away: the stale
// timestamp is the signal (SPEC §5). The one exception is the operator
// name, which is nulled on loss of registration because a stale name would
// state something false rather than merely old.

import { META, NOTIFICATION_PREFIX, PATHS, type SkPath } from "./paths.ts";
import { radioQuality } from "./radio-quality.ts";
import type {
  ConnectionStatus,
  LinkState,
  OperatorInfo,
  PlanSnapshot,
  SignalSample,
  SmsMessage,
  TrafficSample,
} from "./types.ts";

/** Compatible with ServerAPI.handleMessage. */
export interface DeltaSink {
  handleMessage(pluginId: string, delta: object): void;
}

export type NotificationState = "normal" | "alert" | "warn" | "alarm";
export type PlanLevel = "normal" | "warn" | "alarm";

export const NO_SERVICE_TEXT = "No service";
const LAST_MESSAGE_MAX = 160;
const NOTIFY_TEXT_MAX = 80;
const PEER_MAX = 32;

type Value = string | number | boolean | null;
type Entry = [path: string, value: Value | undefined];

/** Strip control characters (newlines and tabs become spaces) and shorten. */
export function sanitizeText(text: string, max: number): string {
  const clean = text
    .replace(/\s+/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the filter
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

const METHODS: Record<NotificationState, string[]> = {
  normal: [],
  alert: ["visual"],
  warn: ["visual"],
  alarm: ["visual", "sound"],
};

export interface Publisher {
  sendMeta(): void;
  publishSignal(sample: SignalSample): void;
  publishOperator(info: {
    operator?: OperatorInfo;
    serviceAvailable: boolean;
    networkType?: string;
  }): void;
  publishConnection(c: ConnectionStatus): void;
  publishTraffic(t: TrafficSample): void;
  publishPlan(p: PlanSnapshot): void;
  publishSms(s: {
    unread: number;
    lastMessage?: string;
    lastMessageTime?: string;
  }): void;
  publishRouterLink(state: LinkState): void;
  notifyPlan(level: PlanLevel, snapshot?: PlanSnapshot): void;
  notifyLink(state: LinkState): void;
  notifyService(c: ConnectionStatus): void;
  notifySms(msg: SmsMessage): void;
  clearSmsNotification(id: string): void;
}

export function createPublisher(
  sink: DeltaSink,
  pluginId: string,
  options: { now?: () => Date } = {},
): Publisher {
  const now = options.now ?? (() => new Date());
  const context = "vessels.self";

  function emit(entries: Entry[]): void {
    const values = entries.flatMap(([path, value]) =>
      value === undefined ? [] : [{ path, value }],
    );
    if (values.length === 0) return;
    sink.handleMessage(pluginId, { context, updates: [{ values }] });
  }

  function notify(
    name: string,
    state: NotificationState,
    message: string,
  ): void {
    emit([
      [
        `${NOTIFICATION_PREFIX}.${name}`,
        // value objects are sent as-is; typed loosely on purpose
        {
          state,
          method: METHODS[state],
          message,
          timestamp: now().toISOString(),
        } as unknown as Value,
      ],
    ]);
  }

  return {
    sendMeta() {
      const meta = (Object.keys(META) as SkPath[]).map((path) => ({
        path,
        value: META[path],
      }));
      sink.handleMessage(pluginId, { context, updates: [{ meta }] });
    },

    publishSignal(s) {
      emit([
        [PATHS.rssi, s.rssi],
        [PATHS.rsrp, s.rsrp],
        [PATHS.rsrq, s.rsrq],
        [PATHS.sinr, s.sinr],
        [PATHS.radioQuality, radioQuality(s)],
        [PATHS.curBand, s.band],
        [PATHS.cellId, s.cellId],
        [PATHS.pci, s.pci],
        [PATHS.connectionType, s.networkType],
      ]);
    },

    publishOperator({ operator, serviceAvailable, networkType }) {
      const name = serviceAvailable ? operator?.name : undefined;
      emit([
        [PATHS.registerNetworkDisplay, name ?? null],
        [PATHS.connectionText, name ?? NO_SERVICE_TEXT],
        [PATHS.connectionType, serviceAvailable ? networkType : undefined],
      ]);
    },

    publishConnection(c) {
      emit([
        [PATHS.bars, c.bars],
        [PATHS.wanIp, c.wanIp],
        [PATHS.modemUptime, c.uptimeSeconds],
        [PATHS.roaming, c.roaming],
      ]);
    },

    publishTraffic(t) {
      emit([
        [PATHS.usageRx, t.downloadBytes],
        [PATHS.usageTx, t.uploadBytes],
      ]);
    },

    publishPlan(p) {
      emit([
        [PATHS.planTotalBytes, p.totalBytes],
        [PATHS.planUsedBytes, p.usedBytes],
        [PATHS.planRemainingBytes, p.remainingBytes],
        [PATHS.planUsedRatio, p.usedRatio],
        [PATHS.planPeriodEnd, p.periodEnd],
      ]);
    },

    publishSms(s) {
      emit([
        [PATHS.smsUnread, s.unread],
        [
          PATHS.lastMessage,
          s.lastMessage === undefined
            ? undefined
            : sanitizeText(s.lastMessage, LAST_MESSAGE_MAX),
        ],
        [PATHS.lastMessageTime, s.lastMessageTime],
      ]);
    },

    publishRouterLink(state) {
      emit([[PATHS.routerLink, state]]);
    },

    notifyPlan(level, snapshot) {
      const pct = snapshot ? Math.round(snapshot.usedRatio * 100) : undefined;
      const message =
        level === "normal"
          ? "Data plan usage back within limits"
          : `Data plan ${pct === undefined ? "limit" : `${pct}%`} used${
              level === "alarm" ? ", nearly exhausted" : ""
            }`;
      notify("plan", level, message);
    },

    notifyLink(state) {
      switch (state) {
        case "unreachable":
          notify("link", "warn", "Router unreachable");
          break;
        case "auth-failed":
          notify("link", "alarm", "Router login rejected, check credentials");
          break;
        default:
          notify("link", "normal", "Router link ok");
      }
    },

    notifyService(c) {
      if (!c.serviceAvailable) {
        notify("service", "alarm", NO_SERVICE_TEXT);
      } else if (c.roaming) {
        notify("service", "warn", "Roaming on a foreign network");
      } else {
        notify("service", "normal", "Registered on home network");
      }
    },

    notifySms(msg) {
      const peer = sanitizeText(msg.peer, PEER_MAX);
      const text = sanitizeText(msg.text, NOTIFY_TEXT_MAX);
      notify(
        `sms.${safeSegment(msg.id)}`,
        "alert",
        `SMS from ${peer}: ${text}`,
      );
    },

    clearSmsNotification(id) {
      notify(`sms.${safeSegment(id)}`, "normal", "SMS notification cleared");
    },
  };
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
