#!/usr/bin/env bash
# A local Signal K server for testing this plugin, kept OUTSIDE the repo so
# it never becomes a dependency. It runs against a mock router with synthetic
# data, never a real one.
#
#   scripts/dev-server.sh setup      install the server and this plugin (first time)
#   scripts/dev-server.sh start      start the mock router and the server
#   scripts/dev-server.sh stop       stop both
#   scripts/dev-server.sh reinstall  rebuild and reinstall the plugin (then: start)
#   scripts/dev-server.sh secure     turn on Signal K security (restarts the server)
#   scripts/dev-server.sh status     show whether the plugin is up
#
# Environment: SK_DEV_DIR (default ~/signalk-dev), SK_PORT (3000),
# MOCK_PORT (8099), MOCK_RSRP (-98).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${SK_DEV_DIR:-$HOME/signalk-dev}"
SK_PORT="${SK_PORT:-3000}"
MOCK_PORT="${MOCK_PORT:-8099}"
MOCK_RSRP="${MOCK_RSRP:--98}"
CONF="$DEV/config"
PLUGIN_ID="signalk-huawei-b311-221"
# Matches the default password of test/helpers/mock-router.mjs.
MOCK_PASSWORD="p4ssw0rd-XYZ"
# Throwaway credentials for `secure`, for this local test server only.
ADMIN_USER="admin"; ADMIN_PASS="adminpw-123"
CREW_USER="crew";   CREW_PASS="crewpw-123"

say() { printf '%s\n' "$*"; }
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

wait_for_server() {
  for _ in $(seq 1 40); do
    if curl -fsS -m 3 -o /dev/null "http://localhost:$SK_PORT/signalk" 2>/dev/null; then return 0; fi
    sleep 1
  done
  say "The server did not come up; see $DEV/server.log" >&2
  return 1
}

login() {
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
    "http://localhost:$SK_PORT/signalk/v1/auth/login" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}

write_config() {
  mkdir -p "$CONF/plugin-config-data"
  [ -f "$CONF/package.json" ] ||
    printf '{ "name": "signalk-dev-config", "version": "1.0.0", "private": true }\n' >"$CONF/package.json"
  [ -f "$CONF/settings.json" ] ||
    cat >"$CONF/settings.json" <<JSON
{
  "vessel": { "name": "Test Boat", "uuid": "urn:mrn:signalk:uuid:b7590868-1d62-47d9-989c-32321b349fb9" },
  "interfaces": {},
  "ssl": false,
  "port": $SK_PORT,
  "pipedProviders": []
}
JSON
  cat >"$CONF/plugin-config-data/$PLUGIN_ID.json" <<JSON
{
  "enabled": true,
  "configuration": {
    "routerUrl": "http://127.0.0.1:$MOCK_PORT",
    "username": "admin",
    "password": "$MOCK_PASSWORD",
    "signalPollSeconds": 10,
    "trafficPollSeconds": 30,
    "smsPollSeconds": 30,
    "notifyNewSms": true,
    "plan": { "sizeGB": 1, "resetDay": 1, "warnPercent": 80, "alarmPercent": 95 }
  }
}
JSON
}

reinstall() {
  say "Building and packing the plugin..."
  mkdir -p "$DEV/pack"
  rm -f "$DEV"/pack/*.tgz
  (cd "$ROOT" && npm run build --silent && npm pack --silent --pack-destination "$DEV/pack" >/dev/null)
  say "Installing it into the server's config directory..."
  (cd "$CONF" && npm install --silent --no-audit --no-fund "$DEV"/pack/*.tgz)
}

do_setup() {
  mkdir -p "$DEV"
  if [ ! -x "$DEV/node_modules/.bin/signalk-server" ]; then
    say "Installing signalk-server into $DEV (about half a minute)..."
    (cd "$DEV" && { [ -f package.json ] || npm init -y --silent >/dev/null; } &&
      npm install --silent --no-audit --no-fund signalk-server)
  fi
  write_config
  reinstall
  say "Done. Next: scripts/dev-server.sh start"
}

do_stop() {
  for f in "$DEV/server.pid" "$DEV/mock.pid"; do
    if alive "$f"; then kill "$(cat "$f")" 2>/dev/null || true; fi
    rm -f "$f"
  done
}

do_start() {
  [ -x "$DEV/node_modules/.bin/signalk-server" ] || { say "Run 'setup' first." >&2; exit 1; }
  do_stop
  sleep 1
  write_config
  # Detached, with every stream redirected, so this script can exit and the
  # processes keep running. `exec` makes the recorded pid the server's own.
  nohup node "$ROOT/scripts/dev-mock-router.mjs" "$MOCK_PORT" "$MOCK_RSRP" \
    >"$DEV/mock.log" 2>&1 </dev/null &
  echo $! >"$DEV/mock.pid"
  nohup bash -c 'cd "$1" && exec node_modules/.bin/signalk-server -c "$2"' _ "$DEV" "$CONF" \
    >"$DEV/server.log" 2>&1 </dev/null &
  echo $! >"$DEV/server.pid"
  disown -a 2>/dev/null || true
  wait_for_server
  say "Signal K:      http://localhost:$SK_PORT   (admin UI at /admin)"
  say "Plugin webapp: http://localhost:$SK_PORT/@boathacks/$PLUGIN_ID/"
  say "Mock router:   http://127.0.0.1:$MOCK_PORT   (RSRP $MOCK_RSRP dBm)"
  say "Logs:          $DEV/server.log, $DEV/mock.log"
}

do_secure() {
  alive "$DEV/server.pid" || { say "Start the server first." >&2; exit 1; }
  if [ -f "$CONF/security.json" ]; then say "Security is already enabled."; return; fi
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\",\"type\":\"admin\"}" \
    "http://localhost:$SK_PORT/skServer/enableSecurity" >/dev/null
  do_start
  local token
  token="$(login "$ADMIN_USER" "$ADMIN_PASS")"
  curl -fsS -m 10 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$CREW_USER\",\"password\":\"$CREW_PASS\",\"type\":\"readwrite\"}" \
    "http://localhost:$SK_PORT/skServer/security/users/$CREW_USER" >/dev/null
  say "Security on. Admin: $ADMIN_USER / $ADMIN_PASS   Non-admin: $CREW_USER / $CREW_PASS"
}

do_status() {
  alive "$DEV/server.pid" && say "server: running (pid $(cat "$DEV/server.pid"))" || say "server: stopped"
  alive "$DEV/mock.pid" && say "mock router: running (pid $(cat "$DEV/mock.pid"))" || say "mock router: stopped"
  if curl -fsS -m 3 -o /dev/null "http://localhost:$SK_PORT/signalk" 2>/dev/null; then
    local auth=() token=""
    if [ -f "$CONF/security.json" ]; then token="$(login "$ADMIN_USER" "$ADMIN_PASS")"; auth=(-H "Authorization: Bearer $token"); fi
    curl -fsS -m 10 "${auth[@]}" "http://localhost:$SK_PORT/skServer/plugins" |
      python3 -c 'import sys,json
for p in json.load(sys.stdin):
    if "huawei" in p["id"]: print("plugin:", p["id"], "|", p.get("statusMessage"))'
  fi
}

case "${1:-help}" in
  setup) do_setup ;;
  start) do_start ;;
  stop) do_stop ;;
  reinstall) reinstall ;;
  secure) do_secure ;;
  status) do_status ;;
  *) sed -n '2,15p' "${BASH_SOURCE[0]}" ;;
esac
