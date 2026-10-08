// Decides which received SMS messages are new (SPEC §3.3) and keeps a
// bounded cache of recent messages for the REST list. Identity is
// SmsMessage.id (router index + timestamp + peer, see sms-id.ts), never the
// index alone, because the router reuses indexes after deletion.
//
// The very first ingest (no persisted state) records existing messages as
// seen without reporting them as new, to avoid a notification storm on
// first start.

import { randomUUID } from "node:crypto";
import type { StateStoreLike } from "./state-store.ts";
import type { SmsDelivery, SmsMessage, SmsReport } from "./types.ts";

export const SMS_NOTIFICATION_MAX_CHARS = 140;

// Control characters (incl. newlines, tabs) and bidi override/isolate marks.
const STRIP_RE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
const SPACE_RE = /[\r\n\t\p{Zl}\p{Zp}]+/gu;

/** Plain-text, single-line, length-bounded form of untrusted SMS text. */
export function sanitiseSmsText(
  text: string,
  maxChars: number = SMS_NOTIFICATION_MAX_CHARS,
): string {
  const flat = text
    .replace(SPACE_RE, " ")
    .replace(STRIP_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const chars = [...flat];
  if (chars.length <= maxChars) return flat;
  return `${chars
    .slice(0, Math.max(0, maxChars - 1))
    .join("")
    .trimEnd()}…`;
}

/** How long after sending a delivery report may still be matched to a message. */
const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Router and server clocks may disagree a little. */
const REPORT_CLOCK_SLACK_MS = 2 * 60 * 1000;

/**
 * True if two numbers look like the same phone. Reports arrive as +49170...
 * while a message may have been sent to 0170..., so compare the last digits.
 */
export function samePhone(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (da === "" || db === "") return false;
  const n = Math.min(9, da.length, db.length);
  return da.slice(-n) === db.slice(-n);
}

export interface SmsStoreOptions {
  state: StateStoreLike;
  /** Document name. Default "sms". */
  name?: string;
  /** Max remembered ids. Default 500. */
  maxSeen?: number;
  /** Max cached messages. Default 100. */
  maxCache?: number;
  /** Max remembered sent messages. Default 50. */
  maxSent?: number;
}

export interface IngestResult {
  newMessages: SmsMessage[];
  unread: number;
  /** Newest incoming message, if any. */
  latest?: SmsMessage;
}

interface Persisted {
  seen: string[];
  messages: SmsMessage[];
  /** Absent in files written before sent messages were kept. */
  sent?: SmsMessage[];
}

function isPersisted(v: unknown): v is Persisted {
  if (v === null || typeof v !== "object") return false;
  const p = v as Partial<Persisted>;
  return Array.isArray(p.seen) && Array.isArray(p.messages);
}

function byNewest(a: SmsMessage, b: SmsMessage): number {
  const ta = Date.parse(a.timestamp) || 0;
  const tb = Date.parse(b.timestamp) || 0;
  return tb - ta || b.index - a.index;
}

export class SmsStore {
  private readonly state: StateStoreLike;
  private readonly name: string;
  private readonly maxSeen: number;
  private readonly maxCache: number;
  private readonly maxSent: number;
  private sent: SmsMessage[] = [];
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private cache: SmsMessage[] = [];
  private initialised = false;

  constructor(opts: SmsStoreOptions) {
    this.state = opts.state;
    this.name = opts.name ?? "sms";
    this.maxSeen = opts.maxSeen ?? 500;
    this.maxCache = opts.maxCache ?? 100;
    this.maxSent = opts.maxSent ?? 50;
  }

  /** Restore persisted state. Call once before ingest(). */
  async load(): Promise<void> {
    const p = await this.state.load<unknown>(this.name);
    if (!isPersisted(p)) return;
    this.seen = p.seen.filter((x): x is string => typeof x === "string");
    this.seenSet = new Set(this.seen);
    this.cache = p.messages.slice(0, this.maxCache);
    this.sent = (Array.isArray(p.sent) ? p.sent : [])
      .filter((m) => m?.direction === "out")
      .slice(0, this.maxSent);
    this.initialised = true;
  }

  ingest(messages: SmsMessage[], reports: SmsReport[] = []): IngestResult {
    const firstRun = !this.initialised;
    const newMessages: SmsMessage[] = [];
    for (const m of messages) {
      if (this.seenSet.has(m.id)) continue;
      this.markSeen(m.id);
      if (!firstRun && m.direction === "in") newMessages.push(m);
    }
    this.initialised = true;
    this.applyReports(reports);
    this.cache = [...messages].sort(byNewest).slice(0, this.maxCache);
    this.persist();
    return {
      newMessages: newMessages.sort(byNewest).reverse(),
      unread: this.unread(),
      latest: this.cache.find((m) => m.direction === "in"),
    };
  }

  /**
   * Each report ticks the oldest message still waiting for one that was sent
   * to the same number (reports arrive in sending order). A report is used
   * once: its id goes into the seen list, as reports stay in the inbox.
   */
  private applyReports(reports: SmsReport[]): void {
    for (const r of reports) {
      if (this.seenSet.has(r.id)) continue;
      this.markSeen(r.id);
      const at = Date.parse(r.timestamp);
      if (Number.isNaN(at)) continue;
      const waiting = this.sent
        .filter((m) => {
          const sentAt = Date.parse(m.timestamp);
          return (
            (m.delivery === "sending" ||
              m.delivery === "sent" ||
              m.delivery === "unknown") &&
            samePhone(m.peer, r.peer) &&
            sentAt <= at + REPORT_CLOCK_SLACK_MS &&
            at - sentAt <= REPORT_MAX_AGE_MS
          );
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      if (waiting[0]) waiting[0].delivery = "delivered";
    }
  }

  /**
   * Record a message about to be sent. Returns its id for finishSend() or
   * discardSend(). Recorded before the router is asked, so a report that
   * arrives while the send is still being confirmed finds it.
   */
  startSend(peer: string, text: string, nowMs: number): string {
    const id = `out-${randomUUID()}`;
    this.sent.unshift({
      id,
      index: -1,
      direction: "out",
      peer,
      text,
      timestamp: new Date(nowMs).toISOString(),
      read: true,
      delivery: "sending",
    });
    this.sent.length = Math.min(this.sent.length, this.maxSent);
    this.persist();
    return id;
  }

  /** Settle a message from startSend(), unless a report already said delivered. */
  finishSend(id: string, delivery: SmsDelivery): void {
    const m = this.sent.find((x) => x.id === id);
    if (!m) return;
    if (m.delivery !== "delivered") m.delivery = delivery;
    this.persist();
  }

  /** Forget a message the router never took (the request itself failed). */
  discardSend(id: string): void {
    this.remove(id);
  }

  /** Received and sent messages, newest first (copies). */
  list(): SmsMessage[] {
    return [...this.cache, ...this.sent].sort(byNewest).map((m) => ({ ...m }));
  }

  unread(): number {
    return this.cache.filter((m) => m.direction === "in" && !m.read).length;
  }

  markRead(id: string): boolean {
    const m = this.cache.find((x) => x.id === id);
    if (!m) return false;
    m.read = true;
    this.persist();
    return true;
  }

  /** Drop from the cache. The id stays seen so it is never re-announced. */
  remove(id: string): boolean {
    const before = this.cache.length + this.sent.length;
    this.cache = this.cache.filter((x) => x.id !== id);
    this.sent = this.sent.filter((x) => x.id !== id);
    if (this.cache.length + this.sent.length === before) return false;
    this.persist();
    return true;
  }

  private markSeen(id: string): void {
    this.seen.push(id);
    this.seenSet.add(id);
    while (this.seen.length > this.maxSeen) {
      const old = this.seen.shift();
      if (old !== undefined) this.seenSet.delete(old);
    }
  }

  private persist(): void {
    const value: Persisted = {
      seen: this.seen,
      messages: this.cache,
      sent: this.sent,
    };
    this.state.save(this.name, value);
  }
}
