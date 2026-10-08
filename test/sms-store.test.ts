import assert from "node:assert/strict";
import { test } from "node:test";
import { SmsStore, sanitiseSmsText } from "../src/sms-store.ts";
import type { SmsMessage, SmsReport } from "../src/types.ts";

class FakeState {
  docs = new Map<string, unknown>();
  saves = 0;
  async load<T>(name: string): Promise<T | undefined> {
    return this.docs.get(name) as T | undefined;
  }
  save(name: string, value: unknown): void {
    this.saves++;
    this.docs.set(name, structuredClone(value));
  }
  async flush(): Promise<void> {}
}

function msg(index: number, over: Partial<SmsMessage> = {}): SmsMessage {
  const timestamp = over.timestamp ?? `2026-10-0${index}T10:00:00Z`;
  const peer = over.peer ?? "+4712345678";
  return {
    id: `${index}|${timestamp}|${peer}`,
    index,
    direction: "in",
    peer,
    text: `hello ${index}`,
    timestamp,
    read: false,
    ...over,
  };
}

async function make(state = new FakeState(), extra: object = {}) {
  const store = new SmsStore({ state, ...extra });
  await store.load();
  return { store, state };
}

test("first ever ingest marks existing as seen, none new", async () => {
  const { store } = await make();
  const r = store.ingest([msg(1), msg(2)]);
  assert.deepEqual(r.newMessages, []);
  assert.equal(r.unread, 2);
  assert.equal(r.latest?.index, 2);
});

test("later ingest reports only unseen incoming messages", async () => {
  const { store } = await make();
  store.ingest([msg(1)]);
  const r = store.ingest([msg(1), msg(2)]);
  assert.deepEqual(
    r.newMessages.map((m) => m.index),
    [2],
  );
  assert.deepEqual(store.ingest([msg(1), msg(2)]).newMessages, []);
});

test("first ingest of an empty inbox still ends the first-run state", async () => {
  const { store } = await make();
  store.ingest([]);
  assert.equal(store.ingest([msg(1)]).newMessages.length, 1);
});

test("reused index with different timestamp is a new message", async () => {
  const { store } = await make();
  store.ingest([msg(1)]);
  const reused = msg(1, { timestamp: "2026-10-05T09:00:00Z" });
  assert.equal(store.ingest([reused]).newMessages.length, 1);
});

test("same index and time from a different peer is new", async () => {
  const { store } = await make();
  store.ingest([msg(1)]);
  const other = msg(1, { peer: "+4799999999" });
  assert.equal(store.ingest([other]).newMessages.length, 1);
});

test("outgoing messages are never new", async () => {
  const { store } = await make();
  store.ingest([]);
  const r = store.ingest([msg(1, { direction: "out", read: true })]);
  assert.deepEqual(r.newMessages, []);
});

test("seen ids survive a restart (no re-notification)", async () => {
  const state = new FakeState();
  const a = await make(state);
  a.store.ingest([msg(1)]);
  a.store.ingest([msg(1), msg(2)]);
  const b = await make(state);
  const r = b.store.ingest([msg(1), msg(2), msg(3)]);
  assert.deepEqual(
    r.newMessages.map((m) => m.index),
    [3],
  );
});

test("seen set is bounded and drops the oldest", async () => {
  const { store } = await make(new FakeState(), { maxSeen: 3 });
  store.ingest([]);
  for (let i = 1; i <= 5; i++) store.ingest([msg(i)]);
  // 1 and 2 were dropped from seen, so they appear new again; 4 and 5 do not.
  const r = store.ingest([msg(1), msg(4), msg(5)]);
  assert.deepEqual(
    r.newMessages.map((m) => m.index),
    [1],
  );
});

test("recent cache is newest first and bounded", async () => {
  const { store } = await make(new FakeState(), { maxCache: 2 });
  store.ingest([msg(1), msg(2), msg(3)]);
  assert.deepEqual(
    store.list().map((m) => m.index),
    [3, 2],
  );
});

test("unread counts incoming messages without the read flag", async () => {
  const { store } = await make();
  const r = store.ingest([
    msg(1, { read: true }),
    msg(2),
    msg(3, { direction: "out", read: false }),
  ]);
  assert.equal(r.unread, 1);
});

test("markRead and remove update the cache", async () => {
  const { store } = await make();
  const [a, b] = [msg(1), msg(2)];
  store.ingest([a, b]);
  assert.equal(store.markRead(a.id), true);
  assert.equal(store.unread(), 1);
  assert.equal(store.markRead("nope"), false);
  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove(b.id), false);
  assert.deepEqual(
    store.list().map((m) => m.id),
    [a.id],
  );
  assert.equal(store.unread(), 0);
});

test("removed message that stays seen is not reported new", async () => {
  const { store } = await make();
  store.ingest([msg(1)]);
  store.remove(msg(1).id);
  assert.deepEqual(store.ingest([msg(1)]).newMessages, []);
});

test("cache is persisted and restored", async () => {
  const state = new FakeState();
  const a = await make(state);
  a.store.ingest([msg(1)]);
  const b = await make(state);
  assert.equal(b.store.list().length, 1);
  assert.equal(b.store.unread(), 1);
});

test("garbage persisted state is ignored like first run", async () => {
  const state = new FakeState();
  state.docs.set("sms", { seen: "x" });
  const { store } = await make(state);
  assert.deepEqual(store.ingest([msg(1)]).newMessages, []);
});

test("list returns copies", async () => {
  const { store } = await make();
  store.ingest([msg(1)]);
  const l = store.list();
  assert.ok(l[0]);
  l[0].read = true;
  assert.equal(store.unread(), 1);
});

test("sanitiseSmsText strips control characters and flattens whitespace", () => {
  assert.equal(sanitiseSmsText("a\u0000b\u0007c\r\nd\te"), "abc d e");
  assert.equal(sanitiseSmsText("  spaced   out  "), "spaced out");
});

test("sanitiseSmsText strips bidi overrides", () => {
  assert.equal(sanitiseSmsText("ab‮cd⁦ef"), "abcdef");
});

test("sanitiseSmsText truncates to 140 with an ellipsis", () => {
  const out = sanitiseSmsText("x".repeat(500));
  assert.equal([...out].length, 140);
  assert.ok(out.endsWith("…"));
  assert.equal(sanitiseSmsText("x".repeat(140)), "x".repeat(140));
});

test("sanitiseSmsText does not split surrogate pairs", () => {
  const out = sanitiseSmsText("😀".repeat(200), 10);
  assert.equal([...out].length, 10);
  assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("sanitiseSmsText leaves markup as plain text", () => {
  assert.equal(sanitiseSmsText("<b>hi</b>"), "<b>hi</b>");
});

const SENT_AT = Date.parse("2026-10-08T12:00:00Z");
const report = (index: number, peer: string, timestamp: string): SmsReport => ({
  id: `r${index}|${timestamp}|${peer}`,
  peer,
  timestamp,
});

test("a sent message is listed among received ones, ordered by time", async () => {
  const { store } = await make();
  store.ingest([msg(1, { timestamp: "2026-10-08T11:00:00Z" })]);
  const id = store.startSend("+4712345678", "hi", SENT_AT);
  store.finishSend(id, "sent");
  store.ingest([
    msg(1, { timestamp: "2026-10-08T11:00:00Z" }),
    msg(2, { timestamp: "2026-10-08T13:00:00Z" }),
  ]);
  assert.deepEqual(
    store.list().map((m) => m.direction),
    ["in", "out", "in"],
  );
  assert.equal(store.unread(), 2);
});

test("a delivery report ticks the oldest waiting message to that number", async () => {
  const { store } = await make();
  store.ingest([]);
  const a = store.startSend("0171 2345678", "first", SENT_AT);
  const b = store.startSend("0171 2345678", "second", SENT_AT + 60_000);
  const other = store.startSend("+4999999999", "other", SENT_AT);
  for (const id of [a, b, other]) store.finishSend(id, "sent");
  const state = () =>
    Object.fromEntries(store.list().map((m) => [m.text, m.delivery]));
  store.ingest([], [report(1, "+49 171 2345678", "2026-10-08T12:02:00Z")]);
  assert.deepEqual(state(), {
    first: "delivered",
    second: "sent",
    other: "sent",
  });
  // The same report on the next poll changes nothing.
  store.ingest([], [report(1, "+49 171 2345678", "2026-10-08T12:02:00Z")]);
  assert.equal(state().second, "sent");
  store.ingest([], [report(2, "+49 171 2345678", "2026-10-08T12:03:00Z")]);
  assert.equal(state().second, "delivered");
});

test("a report older than the message, or a day later, matches nothing", async () => {
  const { store } = await make();
  store.ingest([]);
  const id = store.startSend("+4712345678", "x", SENT_AT);
  store.finishSend(id, "sent");
  store.ingest([], [report(1, "+4712345678", "2026-10-08T11:00:00Z")]);
  store.ingest([], [report(2, "+4712345678", "2026-10-09T13:00:00Z")]);
  assert.equal(store.list()[0]?.delivery, "sent");
});

test("a failed send is never ticked, and a discarded one disappears", async () => {
  const { store } = await make();
  store.ingest([]);
  const failed = store.startSend("+4712345678", "x", SENT_AT);
  store.finishSend(failed, "failed");
  const gone = store.startSend("+4712345678", "y", SENT_AT);
  store.discardSend(gone);
  store.ingest([], [report(1, "+4712345678", "2026-10-08T12:00:30Z")]);
  assert.deepEqual(
    store.list().map((m) => [m.text, m.delivery]),
    [["x", "failed"]],
  );
});

test("sent messages survive a restart, keep only the newest 50, and can be removed", async () => {
  const state = new FakeState();
  const { store } = await make(state);
  store.ingest([]);
  let last = "";
  for (let i = 0; i < 55; i++) {
    last = store.startSend("+4712345678", `m${i}`, SENT_AT + i * 1000);
    store.finishSend(last, "sent");
  }
  const { store: again } = await make(state);
  assert.equal(again.list().length, 50);
  assert.equal(again.list()[0]?.text, "m54");
  assert.ok(again.remove(last));
  assert.equal(again.list().length, 49);
});

test("state saved before sent messages existed still loads", async () => {
  const state = new FakeState();
  state.docs.set("sms", { seen: [], messages: [msg(1)] });
  const { store } = await make(state);
  assert.equal(store.list().length, 1);
});
