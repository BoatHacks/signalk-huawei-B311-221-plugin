// A standalone mock B311 for a local Signal K test server (see
// scripts/dev-server.sh). It reuses the mock the tests use, so it serves
// SYNTHETIC data only: it is not a recording of a real router.
//
//   node scripts/dev-mock-router.mjs [port] [rsrp-dBm]
//
// Try an RSRP of -110 (warn band) or -120 (alarm band) to watch the server
// raise its weak-signal notification.

import { startMockRouter } from "../test/helpers/mock-router.mjs";

const port = Number(process.argv[2] ?? 8099);
const rsrp = process.argv[3] ?? "-98";
const xml = (inner) =>
  `<?xml version="1.0" encoding="UTF-8"?><response>${inner}</response>`;

const router = await startMockRouter({
  port,
  extra: {
    "device/signal": xml(
      `<rsrp>${rsrp}dBm</rsrp><rsrq>-11dB</rsrq><sinr>9dB</sinr><rssi>-67dBm</rssi><cell_id>12345678</cell_id><pci>123</pci><band>3</band>`,
    ),
    "monitoring/traffic-statistics": xml(
      "<TotalUpload>100000000</TotalUpload><TotalDownload>400000000</TotalDownload>",
    ),
    "sms/sms-list": xml(
      "<Count>1</Count><Messages><Message><Smstat>0</Smstat><Index>40001</Index><Phone>+358401234567</Phone><Content>Hello from the boat</Content><Date>2026-10-06 12:00:00</Date></Message></Messages>",
    ),
  },
});
console.log(
  `mock router on ${router.url} (rsrp ${rsrp} dBm, user ${router.credentials.username}, password ${router.credentials.password})`,
);
setInterval(() => {}, 1 << 30);
