# Changelog

## Unreleased

## 0.1.3 - 2026-10-08

- Messages sent from the web page now appear in the message list, ordered by
  time with the received ones.
- A delivery report from the router now marks the matching sent message as
  delivered (a check mark). Failed sends show a cross.

## 0.1.2 - 2026-10-08

- Web page: on phone widths (below 900 px) it now has Status and SMS tabs,
  with the unread count on the SMS tab. Wide screens still show everything.
- Web page: the SMS list height follows the screen and no longer cuts off the
  last message.

## 0.1.1 - 2026-10-08

- No code changes from 0.1.0. Published through the GitHub release workflow
  (npm trusted publishing) to test that path.

## 0.1.0 - 2026-10-08

- Published as `@boathacks/signalk-huawei-b311-221`: npm refused the unscoped
  name as spam. The plugin id and REST paths are unchanged.

- First release: router client, signal / connection / traffic publishing under
  `networking.lte.*`, plugin-tracked data plan with notifications, SMS receive
  and send, REST API, offline web page, Status Tiles example set, and a fixture
  capture script.
- Checked against a real B311-221 (software 11.0.2.2): login, signal,
  connection, traffic, and receiving and sending SMS (7-bit and UCS2). Field
  names pinned, real fixtures added. Router uptime and WAN IP now come from
  `device/information`; `monitoring/status` does not carry them.
- The unread SMS count now follows the router's own total (the inbox can be
  larger than the page the plugin reads), and a burst of new messages larger
  than one page is read in full so none is missed.
- Delivery reports, which the router files in the inbox with no text, are no
  longer shown or announced as new messages, and the ones still unread on the
  newest messages are taken off the unread count.
