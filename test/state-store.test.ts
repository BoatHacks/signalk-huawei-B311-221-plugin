import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { StateStore } from "../src/state-store.ts";

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  let timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { id: nextId++, at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      timers = timers.filter((t) => t !== h);
    },
    pending: () => timers.length,
    /** Advance time and fire due timers, awaiting a macrotask afterwards. */
    async advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

async function adv(
  store: StateStore,
  clock: ReturnType<typeof fakeClock>,
  ms: number,
) {
  await clock.advance(ms);
  await store.settled();
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "state-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function make(clock = fakeClock(), extra: object = {}) {
  const errors: unknown[] = [];
  const store = new StateStore({
    dir,
    minIntervalMs: 5000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (e: unknown) => errors.push(e),
    ...extra,
  });
  return { store, clock, errors };
}

test("load returns undefined when nothing was saved", async () => {
  const { store } = make();
  assert.equal(await store.load("usage"), undefined);
});

test("save then flush writes a versioned envelope", async () => {
  const { store } = make();
  store.save("usage", { a: 1 });
  await store.flush();
  const raw = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
  assert.deepEqual(raw, { version: 1, data: { a: 1 } });
  assert.deepEqual(await make().store.load("usage"), { a: 1 });
});

test("atomic write leaves no temp files behind", async () => {
  const { store } = make();
  store.save("usage", { a: 1 });
  await store.flush();
  assert.deepEqual(await readdir(dir), ["usage.json"]);
});

test("saves are coalesced: only the latest value is written", async () => {
  const { store, clock } = make();
  store.save("usage", { n: 1 });
  store.save("usage", { n: 2 });
  store.save("usage", { n: 3 });
  assert.equal(clock.pending(), 1);
  await adv(store, clock, 0);
  assert.deepEqual(await make().store.load("usage"), { n: 3 });
});

test("saves are rate limited per document", async () => {
  const { store, clock } = make();
  store.save("usage", { n: 1 });
  await adv(store, clock, 0);
  store.save("usage", { n: 2 });
  await adv(store, clock, 1000);
  assert.deepEqual(await make().store.load("usage"), { n: 1 });
  await adv(store, clock, 4000);
  assert.deepEqual(await make().store.load("usage"), { n: 2 });
});

test("flush forces pending writes and cancels timers", async () => {
  const { store, clock } = make();
  store.save("usage", { n: 1 });
  store.save("sms", { m: 1 });
  await store.flush();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(await make().store.load("usage"), { n: 1 });
  assert.deepEqual(await make().store.load("sms"), { m: 1 });
});

test("corrupt file is moved aside and load returns undefined", async () => {
  await writeFile(join(dir, "usage.json"), "{not json");
  const { store } = make();
  assert.equal(await store.load("usage"), undefined);
  const files = await readdir(dir);
  assert.ok(!files.includes("usage.json"));
  assert.ok(files.some((f) => f.startsWith("usage.json.corrupt-")));
});

test("wrong envelope shape or version is treated as corrupt", async () => {
  await writeFile(join(dir, "a.json"), JSON.stringify({ data: 1 }));
  await writeFile(
    join(dir, "b.json"),
    JSON.stringify({ version: 99, data: 1 }),
  );
  const { store } = make();
  assert.equal(await store.load("a"), undefined);
  assert.equal(await store.load("b"), undefined);
  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.includes(".corrupt-")).length, 2);
});

test("unreadable path does not throw", async () => {
  const { store, errors } = make(fakeClock(), {
    dir: join(dir, "does", "not", "exist"),
  });
  assert.equal(await store.load("usage"), undefined);
  assert.equal(errors.length, 0);
});

test("write failure is reported, not thrown", async () => {
  const { store, errors } = make(fakeClock(), { dir: join(dir, "usage.json") });
  await writeFile(join(dir, "usage.json"), "x"); // dir is a file: writes fail
  store.save("usage", { n: 1 });
  await store.flush();
  assert.equal(errors.length, 1);
});

test("rejects unsafe document names", async () => {
  const { store } = make();
  assert.throws(() => store.save("../evil", 1));
  await assert.rejects(store.load("a/b"));
});

test("creates the directory when missing", async () => {
  const sub = join(dir, "nested");
  const { store } = make(fakeClock(), { dir: sub });
  store.save("usage", { n: 1 });
  await store.flush();
  assert.deepEqual(await readdir(sub), ["usage.json"]);
});
