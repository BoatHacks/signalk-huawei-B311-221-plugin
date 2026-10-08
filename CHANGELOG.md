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
- The unread SMS count now follows the router's own total (the inbox can be
  larger than the page the plugin reads), and a burst of new messages larger
  than one page is read in full so none is missed.
- Delivery reports, which the router files in the inbox with no text, are no
  longer shown or announced as new messages, and the ones still unread on the
  newest messages are taken off the unread count.
