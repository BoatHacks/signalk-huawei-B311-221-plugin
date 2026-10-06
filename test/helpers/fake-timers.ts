// Deterministic timers for tests: nothing sleeps, time moves only when a
// test calls advance().

interface Pending {
  id: number;
  at: number;
  fn: () => void;
}

export interface FakeTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  advance(ms: number): Promise<void>;
  flush(): Promise<void>;
  now(): number;
  pendingCount(): number;
}

export function createFakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  let pending: Pending[] = [];

  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  };

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.push({ id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      pending = pending.filter((p) => p.id !== id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = pending
          .filter((p) => p.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        pending = pending.filter((p) => p.id !== due.id);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
    now: () => now,
    pendingCount: () => pending.length,
  };
}
