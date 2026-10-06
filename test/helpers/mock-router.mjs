import http from "node:http";
import { encodePassword } from "../../scripts/login.mjs";

export const TOKENS = {
  home: "TOKEN-HOME-ZZZ",
  afterLogin: "TOKEN-AFTER-LOGIN",
  reload: "TOKEN-RELOADED-QQQ",
};
export const COOKIE = "COOKIE-SESSION-VALUE";
export const SENSITIVE = {
  imei: "356938035643809",
  serial: "SN123456789012",
  mac: "AA:BB:CC:11:22:33",
  wanIp: "100.75.91.205",
  phone: "+491701234567",
  smsText: "Hello secret wörld",
};

const xml = (inner) =>
  `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;
const errorXml = (code) =>
  `<?xml version="1.0" encoding="UTF-8"?><error><code>${code}</code><message></message></error>`;

const DATA = {
  "device/information": xml(
    `<DeviceName>B311-221</DeviceName><SerialNumber>${SENSITIVE.serial}</SerialNumber><Imei>${SENSITIVE.imei}</Imei><Imsi>262011234567890</Imsi><HardwareVersion>WL1B310M</HardwareVersion><SoftwareVersion>21.318.03.00.01</SoftwareVersion><WebUIVersion>WEBUI 17.0.1.2</WebUIVersion><MacAddress1>${SENSITIVE.mac}</MacAddress1><WanIPAddress>${SENSITIVE.wanIp}</WanIPAddress>`,
  ),
  "device/basic_information": xml("<productfamily>LTE</productfamily>"),
  "device/boot_time": xml("<boot_time>86400</boot_time>"),
  "device/signal": xml(
    "<rsrp>-98dBm</rsrp><rsrq>-11dB</rsrq><sinr>9dB</sinr><rssi>-67dBm</rssi><cell_id>12345678</cell_id><pci>123</pci><band>3</band>",
  ),
  "net/cell-info": xml("<cell_id>12345678</cell_id>"),
  "net/current-plmn": xml("<FullName>Telia</FullName><Numeric>24001</Numeric>"),
  "net/net-mode": xml("<NetworkMode>03</NetworkMode>"),
  "monitoring/status": xml(
    `<ConnectionStatus>901</ConnectionStatus><SignalIcon>4</SignalIcon><WanIPAddress>${SENSITIVE.wanIp}</WanIPAddress>`,
  ),
  "monitoring/converged-status": xml("<SimState>257</SimState>"),
  "monitoring/traffic-statistics": xml(
    "<CurrentUpload>123456789012</CurrentUpload><TotalDownload>9876543210</TotalDownload>",
  ),
  "monitoring/month_statistics": xml(
    "<CurrentMonthDownload>5555555555</CurrentMonthDownload>",
  ),
  "monitoring/start_date": xml("<StartDay>1</StartDay>"),
  "sms/sms-count": xml(
    "<LocalInbox>1</LocalInbox><LocalUnread>1</LocalUnread>",
  ),
  "sms/sms-list": xml(
    `<Count>1</Count><Messages><Message><Smstat>0</Smstat><Index>40001</Index><Phone>${SENSITIVE.phone}</Phone><Content>${SENSITIVE.smsText}</Content><Date>2023-10-06 12:00:00</Date></Message></Messages>`,
  ),
  "sms/sms-feature-switch": xml("<sms_save_enable>1</sms_save_enable>"),
};
const OPEN = new Set([
  "user/state-login",
  "webserver/token",
  "webserver/SesTokInfo",
]);

/**
 * A tiny stand-in for the router's web API. Records every call so tests can
 * assert what a client did, and never needs real hardware.
 */
export async function startMockRouter(opts = {}) {
  const o = {
    username: "admin",
    password: "p4ssw0rd-XYZ",
    passwordType: 4,
    failLogin: false,
    unsupported: [],
    csrfFailOnce: [],
    destroy: [],
    redirect: [],
    extra: {},
    ...opts,
  };
  const calls = [];
  const csrfFailed = new Set();
  let loggedIn = false;
  let homeHits = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://x");
      calls.push({
        method: req.method,
        path: url.pathname,
        body,
        cookie: req.headers.cookie ?? "",
        token: req.headers.__requestverificationtoken ?? "",
      });
      const send = (status, text, headers = {}) => {
        res.writeHead(status, { "Content-Type": "text/xml", ...headers });
        res.end(text);
      };

      if (url.pathname === "/") {
        homeHits += 1;
        const token = homeHits === 1 ? TOKENS.home : TOKENS.reload;
        return send(
          200,
          `<html><head><meta name="csrf_token" content="${token}"/></head><body>page</body></html>`,
          {
            "Content-Type": "text/html",
            "Set-Cookie": `SessionID=${COOKIE}; path=/`,
          },
        );
      }
      const ep = url.pathname.replace(/^\/api\//, "");

      if (o.destroy.includes(ep)) return req.socket.destroy();
      if (o.redirect.includes(ep)) {
        return send(302, "", { Location: "http://evil.example/" });
      }
      if (ep === "user/state-login") {
        return send(
          200,
          xml(
            `<State>${loggedIn ? 0 : -1}</State><password_type>${o.passwordType}</password_type><rsapadingtype>1</rsapadingtype>`,
          ),
        );
      }
      if (ep === "webserver/token")
        return send(200, xml(`<token>${TOKENS.home}</token>`));
      if (ep === "user/login" && req.method === "POST") {
        const field = (n) =>
          new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1] ?? "";
        const expected = encodePassword(
          o.passwordType,
          o.username,
          o.password,
          req.headers.__requestverificationtoken ?? "",
        );
        const ok =
          !o.failLogin &&
          (req.headers.cookie ?? "").includes(COOKIE) &&
          field("Username") === o.username &&
          field("Password") === expected;
        if (!ok) return send(200, errorXml(108006));
        loggedIn = true;
        return send(200, xml("OK"), {
          __RequestVerificationToken: TOKENS.afterLogin,
        });
      }
      if (ep === "user/logout" && req.method === "POST") {
        loggedIn = false;
        return send(200, xml("OK"));
      }
      if (OPEN.has(ep)) return send(200, xml(""));
      if (!loggedIn) return send(200, errorXml(100003));
      if (o.unsupported.includes(ep)) return send(200, errorXml(100002));
      if (o.csrfFailOnce.includes(ep) && !csrfFailed.has(ep)) {
        csrfFailed.add(ep);
        return send(200, errorXml(125002));
      }
      if (o.extra[ep]) return send(200, o.extra[ep]);
      if (DATA[ep]) return send(200, DATA[ep]);
      return send(200, errorXml(100002));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    credentials: { username: o.username, password: o.password },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
