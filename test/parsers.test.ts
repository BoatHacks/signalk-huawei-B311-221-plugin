import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  networkTypeFromCode,
  parseConnection,
  parseDbValue,
  parseOperator,
  parseSendStatus,
  parseSignal,
  parseSmsCounts,
  parseSmsList,
  parseTraffic,
  routerDateToIso,
} from "../src/parsers.ts";
import { smsId } from "../src/sms-id.ts";
import { parseResponseXml } from "../src/xml.ts";

// All fixtures here are SYNTHETIC (test/fixtures/synthetic): field names are
// unverified guesses until a real capture exists.
const fixture = (name: string) =>
  parseResponseXml(
    readFileSync(
      new URL(`./fixtures/synthetic/${name}.xml`, import.meta.url),
      "utf8",
    ),
  ).data;

test("parseDbValue strips unit suffixes and handles signs and decimals", () => {
  assert.equal(parseDbValue("-98dBm"), -98);
  assert.equal(parseDbValue("9dB"), 9);
  assert.equal(parseDbValue("-12.5dB"), -12.5);
  assert.equal(parseDbValue(" -67 dBm "), -67);
  assert.equal(parseDbValue("5"), 5);
  assert.equal(parseDbValue(-3), -3);
});

test("parseDbValue keeps the bound of comparison prefixes", () => {
  assert.equal(parseDbValue(">=20dB"), 20);
  assert.equal(parseDbValue("<-20dB"), -20);
  assert.equal(parseDbValue(">20dB"), 20);
});

test("parseDbValue returns undefined for empty, missing or non-numeric input", () => {
  for (const v of ["", "  ", undefined, null, "NA", "--", {}, []]) {
    assert.equal(parseDbValue(v), undefined, String(v));
  }
});

test("parseSignal reads a plain signal response", () => {
  assert.deepEqual(parseSignal(fixture("signal")), {
    rssi: -67,
    rsrp: -98,
    rsrq: -11,
    sinr: 9,
    band: "3",
    cellId: "12345678",
    pci: "123",
  });
});

test("parseSignal tolerates prefixes, empty values and other spellings", () => {
  assert.deepEqual(parseSignal(fixture("signal-prefixed")), {
    rsrp: -98,
    rsrq: -20,
    sinr: 20,
    band: "B20",
  });
  assert.deepEqual(parseSignal(fixture("signal-uppercase")), {
    rssi: -70,
    rsrp: -101,
    rsrq: -12.5,
    sinr: 3,
    band: "1",
    cellId: "999",
    pci: "7",
  });
});

test("parseSignal copes with missing or malformed input", () => {
  assert.deepEqual(parseSignal(undefined), {});
  assert.deepEqual(parseSignal("OK"), {});
  assert.deepEqual(parseSignal({}), {});
});

test("parseOperator reads name and PLMN, preferring the full name", () => {
  assert.deepEqual(parseOperator(fixture("plmn")), {
    name: "Telia",
    plmn: "24001",
  });
  assert.deepEqual(parseOperator({ ShortName: "Tel", Numeric: "24001" }), {
    name: "Tel",
    plmn: "24001",
  });
});

test("parseOperator returns nothing when the router reports no registration", () => {
  assert.deepEqual(parseOperator(fixture("plmn-no-service")), {});
  assert.deepEqual(parseOperator(undefined), {});
});

test("parseConnection: connected with service", () => {
  assert.deepEqual(parseConnection(fixture("status-connected")), {
    connected: true,
    serviceAvailable: true,
    roaming: false,
    bars: 4,
    networkType: "LTE",
  });
});

test("parseConnection: no service", () => {
  const c = parseConnection(fixture("status-no-service"));
  assert.equal(c.connected, false);
  assert.equal(c.serviceAvailable, false);
  assert.equal(c.bars, 0);
  assert.equal(c.wanIp, undefined);
});

test("parseConnection: roaming, and service inferred when no explicit status field", () => {
  const c = parseConnection(fixture("status-roaming"));
  assert.equal(c.roaming, true);
  assert.equal(c.serviceAvailable, true);
  assert.equal(c.bars, 2);
});

test("parseConnection: nothing at all is not connected and has no service", () => {
  const c = parseConnection({});
  assert.equal(c.connected, false);
  assert.equal(c.serviceAvailable, false);
});

test("parseConnection clamps bars to 0-5", () => {
  assert.equal(parseConnection({ SignalIcon: "9" }).bars, 5);
  assert.equal(parseConnection({ SignalIcon: "-1" }).bars, 0);
});

test("networkTypeFromCode maps known codes and leaves unknown ones undefined", () => {
  assert.equal(networkTypeFromCode("19"), "LTE");
  assert.equal(networkTypeFromCode("0"), undefined);
  assert.equal(networkTypeFromCode("12345"), undefined);
  assert.equal(networkTypeFromCode(undefined), undefined);
});

test("parseTraffic uses the cumulative Total counters", () => {
  assert.deepEqual(parseTraffic(fixture("traffic"), 1700000000000), {
    uploadBytes: 123456789012,
    downloadBytes: 9876543210,
    at: 1700000000000,
  });
});

test("parseTraffic returns undefined when a total counter is missing", () => {
  assert.equal(parseTraffic({ TotalDownload: "5" }, 1), undefined);
  assert.equal(
    parseTraffic({ TotalUpload: "x", TotalDownload: "5" }, 1),
    undefined,
  );
  assert.equal(parseTraffic(undefined, 1), undefined);
});

test("routerDateToIso reads the router's local date string", () => {
  assert.equal(
    routerDateToIso("2023-10-06 12:00:00"),
    new Date(2023, 9, 6, 12, 0, 0).toISOString(),
  );
  assert.equal(routerDateToIso("garbage"), undefined);
  assert.equal(routerDateToIso(""), undefined);
});

test("parseSmsList handles a single <Message> element", () => {
  const [m, ...rest] = parseSmsList(fixture("sms-list-single"), {
    nowMs: 0,
  });
  assert.equal(rest.length, 0);
  assert.ok(m);
  assert.equal(m.index, 40001);
  assert.equal(m.direction, "in");
  assert.equal(m.peer, "+15550100");
  assert.equal(m.text, "Hello & welcome <b>");
  assert.equal(m.read, false);
  assert.equal(m.timestamp, new Date(2023, 9, 6, 12, 0, 0).toISOString());
  assert.equal(m.id, smsId(40001, "2023-10-06 12:00:00", "+15550100"));
});

test("parseSmsList handles a list, keeps text whitespace and the read flag", () => {
  const list = parseSmsList(fixture("sms-list-multi"), { nowMs: 0 });
  assert.deepEqual(
    list.map((m) => [m.index, m.read, m.text]),
    [
      [40002, true, "  padded text  "],
      [40001, false, "second"],
    ],
  );
});

test("parseSmsList handles an empty inbox and junk", () => {
  assert.deepEqual(parseSmsList(fixture("sms-list-empty"), { nowMs: 0 }), []);
  assert.deepEqual(parseSmsList(undefined, { nowMs: 0 }), []);
  assert.deepEqual(parseSmsList("OK", { nowMs: 0 }), []);
});

test("parseSmsList skips messages without a usable index and falls back to now for a bad date", () => {
  const list = parseSmsList(
    {
      Messages: {
        Message: [
          { Phone: "+1", Content: "no index" },
          { Index: "7", Phone: "+2", Content: "bad date", Date: "??" },
        ],
      },
    },
    { nowMs: Date.UTC(2024, 0, 2, 3, 4, 5) },
  );
  assert.equal(list.length, 1);
  assert.equal(list[0]?.timestamp, "2024-01-02T03:04:05.000Z");
});

test("smsId is stable, and depends on index, date and peer", () => {
  const a = smsId(1, "2023-10-06 12:00:00", "+15550100");
  assert.equal(a, smsId(1, "2023-10-06 12:00:00", "+15550100"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, smsId(2, "2023-10-06 12:00:00", "+15550100"));
  assert.notEqual(a, smsId(1, "2023-10-06 12:00:01", "+15550100"));
  assert.notEqual(a, smsId(1, "2023-10-06 12:00:00", "+15550101"));
});

test("parseSendStatus: in progress, success, failure, nothing yet", () => {
  assert.deepEqual(
    parseSendStatus({
      Phone: "+1",
      SucPhone: "",
      FailPhone: "",
      TotalCount: "1",
      CurIndex: "0",
    }),
    { done: false, ok: false },
  );
  assert.deepEqual(
    parseSendStatus({
      Phone: "",
      SucPhone: "+1",
      FailPhone: "",
      TotalCount: "1",
      CurIndex: "1",
    }),
    { done: true, ok: true },
  );
  assert.deepEqual(
    parseSendStatus({
      Phone: "",
      SucPhone: "",
      FailPhone: "+1",
      TotalCount: "1",
      CurIndex: "1",
    }),
    { done: true, ok: false },
  );
  assert.deepEqual(parseSendStatus({}), { done: false, ok: false });
  assert.deepEqual(parseSendStatus("OK"), { done: false, ok: false });
});

test("parseResponseXml extracts router error codes and OK bodies", () => {
  const e = parseResponseXml(
    '<?xml version="1.0"?><error><code>100003</code><message></message></error>',
  );
  assert.equal(e.errorCode, 100003);
  assert.equal(parseResponseXml("<response>OK</response>").data, "OK");
  assert.throws(() => parseResponseXml("<html><body>nope"), /XML|response/i);
  assert.throws(() => parseResponseXml(""), /empty|response/i);
});

test("parseSmsCounts needs both numbers", () => {
  assert.deepEqual(parseSmsCounts({ LocalInbox: "5", LocalUnread: "2" }), {
    inbox: 5,
    unread: 2,
  });
  assert.equal(parseSmsCounts({ LocalInbox: "5" }), undefined);
  assert.equal(
    parseSmsCounts({ LocalInbox: "x", LocalUnread: "2" }),
    undefined,
  );
  assert.equal(parseSmsCounts(undefined), undefined);
});

test("parseSmsList drops status reports and keeps unknown types", () => {
  const item = (index: number, type: string) => ({
    Index: String(index),
    Smstat: "0",
    Phone: "DIGI",
    Content: "x",
    Date: "2026-10-05 17:45:11",
    SmsType: type,
  });
  const list = parseSmsList(
    {
      Messages: {
        Message: [item(1, "1"), item(2, "7"), item(3, "2"), item(4, "99")],
      },
    },
    { nowMs: 0 },
  );
  assert.deepEqual(
    list.map((m) => m.index),
    [1, 3, 4],
  );
});
