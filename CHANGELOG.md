# Changelog

## Unreleased

- First implementation: router client, signal / connection / traffic
  publishing under `networking.lte.*`, plugin-tracked data plan with
  notifications, SMS receive and send, REST API, offline web page, Status
  Tiles example set, and a fixture capture script. Not yet verified against
  a real router.
- Checked against a real B311-221 (software 11.0.2.2): field names pinned,
  real fixtures added. Router uptime and WAN IP now come from
  `device/information`; `monitoring/status` does not carry them.
