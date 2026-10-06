import assert from "node:assert/strict";
import { test } from "node:test";
import { redactCsrfMeta, redactXml, scanLeaks } from "../scripts/redact.mjs";

const wrap = (inner) =>
  `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;
const skeleton = (xml) => xml.replace(/>[^<]*</g, "><");

test("phone numbers keep their shape but lose their digits", () => {
  const { text, counts } = redactXml(
    wrap(
      "<Phones><Phone>+49 170 1234567</Phone></Phones><Sca>+491760000443</Sca>",
    ),
  );
  assert.ok(text.includes("<Phone>+00 000 0000000</Phone>"));
  assert.ok(text.includes("<Sca>+000000000000</Sca>"));
  assert.equal(counts.phone, 2);
  assert.ok(!/[1-9]/.test(text.replace(/<\?xml[^>]*\?>/, "")));
});

test("SMS content keeps length and character classes, drops the text", () => {
  const { text, counts, notes } = redactXml(
    wrap("<Content>Hello 123 wörld 😀</Content>"),
  );
  assert.ok(text.includes("<Content>xxxxx 000 xöxxx 😀</Content>"));
  assert.equal(counts.smsContent, 1);
  assert.equal(notes.smsNonAscii, 1);
  assert.equal(notes.smsAstral, 1);
});

test("SMS content with only ASCII reports no non-ASCII characters", () => {
  const { notes } = redactXml(wrap("<Content>Plain text.</Content>"));
  assert.equal(notes.smsNonAscii, 0);
  assert.equal(notes.smsAstral, 0);
});

test("IMEI, IMSI and ICCID digits are zeroed at the same length", () => {
  const { text } = redactXml(
    wrap(
      "<Imei>356938035643809</Imei><Imsi>262011234567890</Imsi><Iccid>89490200001234567890</Iccid>",
    ),
  );
  assert.ok(text.includes("<Imei>000000000000000</Imei>"));
  assert.ok(text.includes("<Imsi>000000000000000</Imsi>"));
  assert.ok(text.includes("<Iccid>00000000000000000000</Iccid>"));
});

test("serial number becomes X of the same length", () => {
  const { text } = redactXml(wrap("<SerialNumber>ABCD1234EFGH</SerialNumber>"));
  assert.ok(text.includes("<SerialNumber>XXXXXXXXXXXX</SerialNumber>"));
});

test("MAC addresses keep their separator style", () => {
  const { text, counts } = redactXml(
    wrap(
      "<MacAddress1>AA:BB:CC:11:22:33</MacAddress1><MacAddress2>aa-bb-cc-11-22-33</MacAddress2>",
    ),
  );
  assert.ok(text.includes("<MacAddress1>00:00:00:00:00:00</MacAddress1>"));
  assert.ok(text.includes("<MacAddress2>00-00-00-00-00-00</MacAddress2>"));
  assert.equal(counts.mac, 2);
});

test("SSID and hostname are replaced with labelled placeholders", () => {
  const { text } = redactXml(
    wrap("<WifiSsid>MyBoatWifi</WifiSsid><HostName>skipper-phone</HostName>"),
  );
  assert.ok(text.includes("<WifiSsid>REDACTED-SSID</WifiSsid>"));
  assert.ok(text.includes("<HostName>REDACTED-HOST</HostName>"));
});

test("secrets are replaced but password_type is kept", () => {
  const { text } = redactXml(
    wrap(
      "<password_type>4</password_type><Password>hunter2</Password><TokInfo>abc123</TokInfo><SesInfo>SessionID=xyz</SesInfo><encpubkeyn>AABBCC</encpubkeyn>",
    ),
  );
  assert.ok(text.includes("<password_type>4</password_type>"));
  assert.ok(text.includes("<Password>REDACTED</Password>"));
  assert.ok(text.includes("<TokInfo>REDACTED</TokInfo>"));
  assert.ok(text.includes("<SesInfo>REDACTED</SesInfo>"));
  assert.ok(text.includes("<encpubkeyn>REDACTED</encpubkeyn>"));
});

test("public IPv4 addresses are replaced consistently, private ones kept", () => {
  const { text, counts } = redactXml(
    wrap(
      "<WanIPAddress>100.75.91.205</WanIPAddress><Dns>8.8.8.8</Dns><Again>100.75.91.205</Again><Lan>192.168.8.1</Lan><Lan2>10.0.0.5</Lan2><Lan3>172.20.1.1</Lan3>",
    ),
  );
  assert.ok(text.includes("<WanIPAddress>203.0.113.1</WanIPAddress>"));
  assert.ok(text.includes("<Dns>203.0.113.2</Dns>"));
  assert.ok(text.includes("<Again>203.0.113.1</Again>"));
  assert.ok(text.includes("<Lan>192.168.8.1</Lan>"));
  assert.ok(text.includes("<Lan2>10.0.0.5</Lan2>"));
  assert.ok(text.includes("<Lan3>172.20.1.1</Lan3>"));
  assert.equal(counts.ip, 3);
});

test("version strings and device names are not mistaken for IP addresses", () => {
  const xml = wrap(
    "<SoftwareVersion>21.318.03.00.01</SoftwareVersion><WebUIVersion>WEBUI 17.0.1.2</WebUIVersion><DeviceName>B311-221</DeviceName>",
  );
  assert.equal(redactXml(xml).text, xml);
});

test("counters, timestamps and signal values are untouched", () => {
  const xml = wrap(
    "<TotalUpload>123456789012</TotalUpload><CurrentConnectTime>3600</CurrentConnectTime><Date>2023-10-06 12:00:00</Date><rsrp>-98dBm</rsrp><sinr>&gt;=20dB</sinr>",
  );
  assert.equal(redactXml(xml).text, xml);
});

test("phone numbers hiding in unnamed elements are still caught", () => {
  const { text } = redactXml(wrap("<Note>call +4917012345678 now</Note>"));
  assert.ok(text.includes("<Note>call +0000000000000 now</Note>"));
});

test("redaction preserves the element structure", () => {
  const xml = wrap(
    "<Messages><Message><Index>40001</Index><Phone>+491701234567</Phone><Content>hi</Content></Message></Messages>",
  );
  assert.equal(skeleton(redactXml(xml).text), skeleton(xml));
});

test("redaction is idempotent", () => {
  const xml = wrap(
    "<Phone>+491701234567</Phone><Imei>356938035643809</Imei><WanIPAddress>100.75.91.205</WanIPAddress><Content>héllo 😀</Content>",
  );
  const once = redactXml(xml).text;
  assert.equal(redactXml(once).text, once);
});

test("CSRF meta extraction keeps only the meta tags, with tokens redacted", () => {
  const html =
    '<html><head><meta name="csrf_token" content="tokenAAA"/><meta name="csrf_token" content="tokenBBB"/></head><body>lots of page</body></html>';
  const { text, counts } = redactCsrfMeta(html);
  assert.ok(!text.includes("tokenAAA"));
  assert.ok(!text.includes("tokenBBB"));
  assert.ok(!text.includes("lots of page"));
  assert.equal((text.match(/csrf_token/g) ?? []).length, 2);
  assert.equal(counts.secret, 2);
});

test("leak scan passes redacted output", () => {
  const raw = wrap(
    "<Phone>+491701234567</Phone><Imei>356938035643809</Imei><MacAddress1>AA:BB:CC:11:22:33</MacAddress1><WanIPAddress>100.75.91.205</WanIPAddress><Content>secret text</Content><SerialNumber>ABCD1234</SerialNumber>",
  );
  assert.deepEqual(scanLeaks(redactXml(raw).text), []);
});

test("leak scan flags raw sensitive data by kind without echoing it", () => {
  const raw = wrap(
    "<Imei>356938035643809</Imei><Foo>AA:BB:CC:11:22:33</Foo><Bar>100.75.91.205</Bar><Baz>+491701234567</Baz><Blob>0123456789abcdef0123456789abcdef01234567</Blob>",
  );
  const findings = scanLeaks(raw);
  for (const kind of ["imei", "mac", "ip", "phone", "hex"]) {
    assert.ok(
      findings.some((f) => f.includes(kind)),
      `missing ${kind}: ${findings}`,
    );
  }
  const joined = findings.join("\n");
  for (const secret of [
    "356938035643809",
    "AA:BB:CC",
    "100.75.91.205",
    "491701234567",
    "0123456789abcdef",
  ]) {
    assert.ok(!joined.includes(secret), `finding echoed ${secret}`);
  }
});
