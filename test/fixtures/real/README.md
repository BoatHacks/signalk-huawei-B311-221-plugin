# Real fixtures

Recorded from a Huawei B311-221 (software 11.0.2.2, WebUI 11.0.2.1,
`password_type` 4) on 2026-10-07 with `scripts/capture-fixtures.mjs`, then
redacted by that script's rules. Cell identifiers (`cell_id`, `enodeb_id`,
`tac`, `lac`, `cellinfo`) were replaced by hand with made-up values of the
same format, because together they locate the cell tower. Everything else is
as the router sent it. The SMS texts are masked (letters to `x`, digits to
`0`) but keep their length and layout.

`sms-send-status-pending.xml` and `sms-send-status-done.xml` come from
sending one ASCII message on 2026-10-08. The router answered `send-sms` with
`OK`, then `send-status` twice with the number still in `Phone`, then with
it in `SucPhone`. The recipient number was replaced.
