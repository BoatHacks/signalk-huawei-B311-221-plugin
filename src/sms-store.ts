// Decides which received SMS messages are new (SPEC §3.3) and keeps a
// bounded cache of recent messages for the REST list. Identity is
// SmsMessage.id (router index + timestamp + peer, see sms-id.ts), never the
// index alone, because the router reuses indexes after deletion.
//
// The very first ingest (no persisted state) records existing messages as
// seen without reporting them as new, to avoid a notification storm on
// first start.

import type { StateStoreLike } from "./state-store.ts";
import type { SmsMessage } from "./types.ts";

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

export interface SmsStoreOptions {
  state: StateStoreLike;
  /** Document name. Default "sms". */
  name?: string;
  /** Max remembered ids. Default 500. */
  maxSeen?: number;
  /** Max cached messages. Default 100. */
  maxCache?: number;
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
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private cache: SmsMessage[] = [];
  private initialised = false;

  constructor(opts: SmsStoreOptions) {
    this.state = opts.state;
    this.name = opts.name ?? "sms";
    this.maxSeen = opts.maxSeen ?? 500;
    this.maxCache = opts.maxCache ?? 100;
  }

  /** Restore persisted state. Call once before ingest(). */
  async load(): Promise<void> {
    const p = await this.state.load<unknown>(this.name);
    if (!isPersisted(p)) return;
    this.seen = p.seen.filter((x): x is string => typeof x === "string");
    this.seenSet = new Set(this.seen);
    this.cache = p.messages.slice(0, this.maxCache);
    this.initialised = true;
  }

  ingest(messages: SmsMessage[]): IngestResult {
    const firstRun = !this.initialised;
    const newMessages: SmsMessage[] = [];
    for (const m of messages) {
      if (this.seenSet.has(m.id)) continue;
      this.markSeen(m.id);
      if (!firstRun && m.direction === "in") newMessages.push(m);
    }
    this.initialised = true;
    this.cache = [...messages].sort(byNewest).slice(0, this.maxCache);
    this.persist();
    return {
      newMessages: newMessages.sort(byNewest).reverse(),
      unread: this.unread(),
      latest: this.cache.find((m) => m.direction === "in"),
    };
  }

  /** Cached messages, newest first (copies). */
  list(): SmsMessage[] {
    return this.cache.map((m) => ({ ...m }));
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
    const before = this.cache.length;
    this.cache = this.cache.filter((x) => x.id !== id);
    if (this.cache.length === before) return false;
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
    const value: Persisted = { seen: this.seen, messages: this.cache };
    this.state.save(this.name, value);
  }
}
