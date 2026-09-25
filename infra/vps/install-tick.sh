#!/usr/bin/env bash
#
# Installs a systemd timer that drains the notification outbox every minute by
# calling the app's /api/internal/tick endpoint.
#
# The app stays exactly where it is. This machine only makes an outbound HTTPS
# request once a minute — it binds no port, serves no traffic, and touches no
# web-server configuration, so whatever else is already running here is not
# affected. Removing it is `systemctl disable --now queuecare-tick.timer`.
#
# Why this exists: Vercel's Hobby plan runs cron once per day and fires it
# anywhere inside the scheduled hour. Slot reminders are due fifteen minutes
# before an appointment and queue links are scheduled for immediately, so
# neither is deliverable on that cadence.
#
#   sudo ./install-tick.sh https://your-app.vercel.app
#
# Idempotent: re-running updates the unit files and restarts the timer.

set -euo pipefail

readonly ENV_DIR=/etc/queuecare
readonly ENV_FILE="${ENV_DIR}/tick.env"
readonly SCRIPT=/usr/local/bin/queuecare-tick.sh
readonly UNIT=/etc/systemd/system/queuecare-tick.service
readonly TIMER=/etc/systemd/system/queuecare-tick.timer

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo — this writes to /etc and /usr/local/bin"
command -v systemctl >/dev/null || die "systemd not found; use the crontab fallback in README.md"
command -v curl >/dev/null || die "curl not installed (apt install curl)"

APP_URL="${1:-}"
[[ -n "$APP_URL" ]] || die "usage: sudo ./install-tick.sh https://your-app.vercel.app"
[[ "$APP_URL" == https://* ]] || die "app URL must start with https://"

# Trailing slash would produce a double slash in the path.
APP_URL="${APP_URL%/}"
TICK_URL="${APP_URL}/api/internal/tick"

# Read interactively rather than as an argument: a command-line secret is
# visible in `ps` output and lands in shell history.
if [[ -n "${INTERNAL_TICK_SECRET:-}" ]]; then
  SECRET="$INTERNAL_TICK_SECRET"
  echo "Using INTERNAL_TICK_SECRET from the environment."
else
  read -rsp "INTERNAL_TICK_SECRET (input hidden): " SECRET
  echo
fi
[[ -n "$SECRET" ]] || die "secret cannot be empty"

echo
echo "Checking ${TICK_URL} before installing anything..."

# Verify first. Automating a call that already fails only makes it fail on a
# schedule, and the failure modes here are each distinct and worth naming.
#
# curl's exit status is captured separately rather than with `|| echo 000`:
# on a DNS failure curl still writes "000" via %{http_code}, so the fallback
# would concatenate onto it and produce "000000", which matches no case below.
TMPBODY=$(mktemp)
trap 'rm -f "$TMPBODY"' EXIT

set +e
HTTP_CODE=$(curl -sS -o "$TMPBODY" -w '%{http_code}' \
  --max-time 60 -X POST "$TICK_URL" \
  -H "Authorization: Bearer ${SECRET}" -H 'Content-Length: 0')
CURL_RC=$?
set -e

if [[ $CURL_RC -ne 0 ]]; then
  HTTP_CODE="000"
fi
BODY=$(cat "$TMPBODY" 2>/dev/null || true)

case "$HTTP_CODE" in
  200) echo "  ok — ${BODY}" ;;
  401) die "401 unauthorized — the secret here does not match the one on the server" ;;
  503) die "503 — INTERNAL_TICK_SECRET is not set on the server, or it was set without redeploying" ;;
  000) die "could not reach ${TICK_URL} — check the URL and this machine's outbound network" ;;
  *)   die "unexpected HTTP ${HTTP_CODE} — ${BODY}" ;;
esac

echo
echo "Installing..."

install -d -m 755 -o root -g root "$ENV_DIR"

# 600 and root-owned: the secret grants the ability to drain the outbox.
umask 077
cat > "$ENV_FILE" <<EOF
TICK_URL=${TICK_URL}
INTERNAL_TICK_SECRET=${SECRET}
EOF
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
umask 022
echo "  ${ENV_FILE} (0600)"

cat > "$SCRIPT" <<'EOF'
#!/usr/bin/env bash
# Drains the QueueCare notification outbox once. Installed by install-tick.sh.
set -euo pipefail
: "${TICK_URL:?TICK_URL not set}"
: "${INTERNAL_TICK_SECRET:?INTERNAL_TICK_SECRET not set}"

# --fail makes curl exit non-zero on 4xx/5xx, so systemd records a failure
# instead of reporting success on a 401.
curl -sS --fail --max-time 60 \
  -X POST "$TICK_URL" \
  -H "Authorization: Bearer $INTERNAL_TICK_SECRET" \
  -H 'Content-Length: 0'
echo
EOF
chmod 755 "$SCRIPT"
echo "  ${SCRIPT}"

cat > "$UNIT" <<EOF
[Unit]
Description=QueueCare notification outbox tick
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=${ENV_FILE}
ExecStart=${SCRIPT}
# Only makes an outbound HTTPS call and needs no filesystem access, so it has
# no reason to run as root.
User=nobody
Group=nogroup
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
EOF
echo "  ${UNIT}"

cat > "$TIMER" <<EOF
[Unit]
Description=Run the QueueCare outbox tick every minute

[Timer]
OnBootSec=1min
# Counts from when the last run finished, so a slow tick cannot stack up
# behind itself. systemd also refuses to start a oneshot that is still
# running, which is overlap protection crontab does not give you.
OnUnitActiveSec=1min
# systemd defaults to 1-minute accuracy, which makes a 1-minute timer fire
# erratically.
AccuracySec=5s
Persistent=true
Unit=queuecare-tick.service

[Install]
WantedBy=timers.target
EOF
echo "  ${TIMER}"

# nobody:nogroup must be able to read the env file systemd hands it. systemd
# reads EnvironmentFile as root before dropping privileges, so 600 is fine —
# this only checks the group exists on distros that name it differently.
if ! getent group nogroup >/dev/null; then
  sed -i 's/^Group=nogroup$/Group=nobody/' "$UNIT"
  echo "  (no 'nogroup' group here — using 'nobody')"
fi

systemctl daemon-reload
systemctl enable --now queuecare-tick.timer >/dev/null
systemctl start queuecare-tick.service

echo
echo "Installed. One run just completed:"
journalctl -u queuecare-tick.service -n 3 --no-pager -o cat || true

echo
systemctl list-timers queuecare-tick.timer --no-pager | head -3

cat <<'EOF'

Watch it:      sudo journalctl -u queuecare-tick.service -f
Check timing:  systemctl list-timers queuecare-tick.timer
Pause:         sudo systemctl disable --now queuecare-tick.timer
Rotate secret: sudo nano /etc/queuecare/tick.env && sudo systemctl restart queuecare-tick.timer

Confirm from the app side with:  npm run whatsapp:diagnose
EOF
