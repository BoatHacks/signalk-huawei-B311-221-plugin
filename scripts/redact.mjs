// Redaction for router responses. Keeps element names, nesting and the
// *format* of values (units, separators, lengths), which is what parsers
// depend on, and replaces the values themselves.

const LEAF = () => /<([A-Za-z_][\w.-]*)>([^<]*)<\/\1>/g;
const MAC = /\b[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}\b/gi;
const PHONE = /\+\d[\d ]{6,}\d/g;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
const HEX_BLOB = /\b[0-9a-f]{32,}\b/i;
const VERSIONISH = /version|build|^ver$/i;
const MASK_OCTETS = new Set([0, 128, 192, 224, 240, 248, 252, 254, 255]);

const SECRET =
  /^(password|pwd|passwd|token|tokinfo|sesinfo|nonce|csrf_token|encpubkeyn|encpubkeye|pin|puk)$|psk|wepkey/i;
const SMS_CONTENT = /^content$/i;
const PHONE_NAME = /^(phone|number|msisdn|sca|telephone|phonenumber)$/i;
const DIGIT_ID = /^(imei|imeisv|imsi|iccid)$/i;
const SERIAL = /^(serialnumber|sn)$/i;
const MAC_NAME = /macaddress|^mac/i;
const SSID = /ssid/i;
const HOST = /^(hostname|actualname)$/i;
const IPV6_NAME = /ipv6|ip6/i;

const zeroDigits = (s) => s.replace(/\d/g, "0");

function redactSmsContent(value, notes) {
  let out = "";
  for (const m of value.matchAll(
    /&(?:#(\d+)|#x([0-9a-f]+));|&[a-z]+;|[\s\S]/giu,
  )) {
    const [token, dec, hex] = m;
    let code;
    if (dec !== undefined) code = Number.parseInt(dec, 10);
    else if (hex !== undefined) code = Number.parseInt(hex, 16);
    else if (token.startsWith("&")) {
      out += "x";
      continue;
    } else code = token.codePointAt(0);
    if (code > 0xffff) {
      notes.smsAstral += 1;
      out += "\u{1F600}";
    } else if (code > 127) {
      notes.smsNonAscii += 1;
      out += "ö";
    } else if (/[A-Za-z]/.test(String.fromCharCode(code))) out += "x";
    else if (code >= 48 && code <= 57) out += "0";
    else out += String.fromCharCode(code);
  }
  return out;
}

function isKeptIp(octets) {
  const [a, b, c] = octets;
  if (octets.every((o) => MASK_OCTETS.has(o))) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return a === 203 && b === 0 && c === 113;
}

function parseIp(s) {
  const octets = s.split(".").map(Number);
  const valid =
    octets.length === 4 &&
    octets.every((o, i) => o >= 0 && o <= 255 && String(o) === s.split(".")[i]);
  return valid ? octets : null;
}

function redactIps(value, ctx) {
  return value.replace(IPV4, (ip) => {
    const octets = parseIp(ip);
    if (!octets || isKeptIp(octets)) return ip;
    if (!ctx.ipMap.has(ip))
      ctx.ipMap.set(ip, `203.0.113.${(ctx.ipMap.size % 254) + 1}`);
    ctx.bump("ip");
    return ctx.ipMap.get(ip);
  });
}

function redactMacs(value, ctx) {
  return value.replace(MAC, (m) => {
    const r = m.replace(/[0-9a-f]/gi, "0");
    if (r !== m) ctx.bump("mac");
    return r;
  });
}

function redactPhones(value, ctx) {
  return value.replace(PHONE, (m) => {
    const r = zeroDigits(m);
    if (r !== m) ctx.bump("phone");
    return r;
  });
}

function byName(name, value, ctx) {
  const set = (kind, replacement) => {
    if (replacement !== value) ctx.bump(kind);
    return replacement;
  };
  if (SECRET.test(name)) return set("secret", "REDACTED");
  if (SMS_CONTENT.test(name))
    return set("smsContent", redactSmsContent(value, ctx.notes));
  if (PHONE_NAME.test(name)) return set("phone", zeroDigits(value));
  if (DIGIT_ID.test(name)) return set(name.toLowerCase(), zeroDigits(value));
  if (SERIAL.test(name)) return set("serial", "X".repeat(value.length));
  if (MAC_NAME.test(name) && new RegExp(`^${MAC.source}$`, "i").test(value)) {
    return set("mac", value.replace(/[0-9a-f]/gi, "0"));
  }
  if (SSID.test(name)) return set("ssid", "REDACTED-SSID");
  if (HOST.test(name)) return set("host", "REDACTED-HOST");
  if (IPV6_NAME.test(name) && value.includes(":"))
    return set("ip", "2001:db8::1");
  return null;
}

export function redactXml(input) {
  const counts = {};
  const notes = { smsNonAscii: 0, smsAstral: 0 };
  const ctx = {
    notes,
    ipMap: new Map(),
    bump: (kind) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
    },
  };
  const text = input.replace(LEAF(), (whole, name, value) => {
    if (value === "") return whole;
    let r = byName(name, value, ctx);
    if (r === null) {
      r = redactMacs(value, ctx);
      r = redactPhones(r, ctx);
      if (!VERSIONISH.test(name)) r = redactIps(r, ctx);
    }
    return `<${name}>${r}</${name}>`;
  });
  return { text, counts, notes };
}

export function redactCsrfMeta(html) {
  const tags = [...html.matchAll(/<meta[^>]*name="csrf_token"[^>]*>/gi)];
  const lines = tags.map((m) =>
    m[0].replace(/content="[^"]*"/i, 'content="REDACTED"'),
  );
  return {
    text: `${lines.join("\n")}\n`,
    counts: lines.length ? { secret: lines.length } : {},
  };
}

/**
 * Looks for values that should have been redacted. Findings name the kind
 * and element, never the value, so the report itself is safe to share.
 */
export function scanLeaks(text) {
  const findings = [];
  const dummy = {
    notes: { smsNonAscii: 0, smsAstral: 0 },
    ipMap: new Map(),
    bump() {},
  };
  const seen = new Set();
  const add = (kind, message) => {
    const line = `${kind}: ${message}`;
    if (!seen.has(line)) {
      seen.add(line);
      findings.push(line);
    }
  };

  for (const [, name, value] of text.matchAll(LEAF())) {
    if (value === "") continue;
    const replaced = byName(name, value, dummy);
    if (replaced !== null && replaced !== value) {
      const kind = DIGIT_ID.test(name) ? name.toLowerCase() : "sensitive";
      add(kind, `element <${name}> holds an unredacted value`);
    }
    if (VERSIONISH.test(name)) continue;
    for (const ip of value.match(IPV4) ?? []) {
      const octets = parseIp(ip);
      if (octets && !isKeptIp(octets))
        add("ip", `element <${name}> holds a public IPv4 address`);
    }
    if (HEX_BLOB.test(value) && !/^(.)\1+$/.test(value)) {
      add(
        "hex",
        `element <${name}> holds a long hex string (possible token or key)`,
      );
    }
  }
  for (const m of text.match(MAC) ?? []) {
    if (m.replace(/[0-9a-f]/gi, "0") !== m)
      add("mac", "a value looks like a MAC address");
  }
  for (const m of text.match(PHONE) ?? []) {
    if (zeroDigits(m) !== m)
      add("phone", "a value looks like an international phone number");
  }
  return findings;
}
