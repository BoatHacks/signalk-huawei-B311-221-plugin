// Small persistent JSON store for the plugin's data directory.
// Named documents are written as `{version, data}` envelopes, atomically
// (temp file + rename), coalesced and rate limited per document. Loading
// is tolerant: a corrupt file is moved aside and reads as "no state".
// Only files named `<name>.json` (plus temp and `.corrupt-` siblings) are
// ever touched, inside the directory the caller passes.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STATE_VERSION = 1;

/** The part of StateStore that consumers depend on (fakeable in tests). */
export interface StateStoreLike {
  load<T = unknown>(name: string): Promise<T | undefined>;
  save(name: string, value: unknown): void;
  flush(): Promise<void>;
}

export interface StateStoreOptions {
  /** Directory for the documents (the plugin data dir). Created if missing. */
  dir: string;
  /** Envelope version written and accepted. Default 1. */
  version?: number;
  /** Minimum time between two writes of the same document. Default 5000. */
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (err: unknown) => void;
}

interface Pending {
  value: unknown;
  timer?: unknown;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid state document name: ${JSON.stringify(name)}`);
  }
}

export class StateStore implements StateStoreLike {
  private readonly dir: string;
  private readonly version: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (err: unknown) => void;
  private readonly pending = new Map<string, Pending>();
  private readonly lastWrite = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: StateStoreOptions) {
    this.dir = opts.dir;
    this.version = opts.version ?? STATE_VERSION;
    this.minIntervalMs = opts.minIntervalMs ?? 5000;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.onError = opts.onError ?? (() => {});
  }

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  /** Returns the stored value, or undefined when missing or unusable. */
  async load<T = unknown>(name: string): Promise<T | undefined> {
    checkName(name);
    const path = this.file(name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.onError(err);
      return undefined;
    }
    try {
      const env = JSON.parse(raw) as { version?: unknown; data?: unknown };
      if (
        env === null ||
        typeof env !== "object" ||
        env.version !== this.version ||
        !("data" in env)
      ) {
        throw new Error("unexpected state envelope");
      }
      return env.data as T;
    } catch {
      try {
        await rename(path, `${path}.corrupt-${this.now()}`);
      } catch (err) {
        this.onError(err);
      }
      return undefined;
    }
  }

  /** Queue a write. Coalesced and rate limited; use flush() to force. */
  save(name: string, value: unknown): void {
    checkName(name);
    const existing = this.pending.get(name);
    if (existing) {
      existing.value = value;
      return;
    }
    const last = this.lastWrite.get(name);
    const delay =
      last === undefined
        ? 0
        : Math.max(0, last + this.minIntervalMs - this.now());
    const entry: Pending = { value };
    entry.timer = this.setTimer(() => {
      entry.timer = undefined;
      this.enqueue(name);
    }, delay);
    this.pending.set(name, entry);
  }

  /** Write all pending documents now and wait for every write to finish. */
  async flush(): Promise<void> {
    for (const [name, entry] of [...this.pending]) {
      if (entry.timer !== undefined) this.clearTimer(entry.timer);
      this.enqueue(name);
    }
    await this.settled();
  }

  /** Resolves when all writes started so far have finished. */
  async settled(): Promise<void> {
    await this.chain;
  }

  private enqueue(name: string): void {
    const entry = this.pending.get(name);
    if (!entry) return;
    this.pending.delete(name);
    const value = entry.value;
    this.chain = this.chain.then(() => this.write(name, value));
  }

  private async write(name: string, value: unknown): Promise<void> {
    const path = this.file(name);
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      await mkdir(this.dir, { recursive: true });
      const body = JSON.stringify({ version: this.version, data: value });
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
      this.lastWrite.set(name, this.now());
    } catch (err) {
      this.onError(err);
      await unlink(tmp).catch(() => {});
    }
  }
}
