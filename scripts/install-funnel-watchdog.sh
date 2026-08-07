#!/usr/bin/env bash
#
# Installs (or removes) the Funnel watchdog as a root LaunchDaemon.
#   Install:  sudo bash scripts/install-funnel-watchdog.sh
#   Remove:   sudo bash scripts/install-funnel-watchdog.sh off
#
# It copies funnel-watchdog.sh to /usr/local/bin and the plist to /Library/LaunchDaemons, then
# bootstraps it into the system domain. Root is required so the watchdog can kickstart the system
# tailscaled. See funnel-watchdog.sh for what it does and why.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo:  sudo bash scripts/install-funnel-watchdog.sh"; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.milo.funnel-watchdog"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
BIN="/usr/local/bin/milo-funnel-watchdog.sh"

if [ "${1:-}" = "off" ]; then
  echo "Removing the Funnel watchdog…"
  launchctl bootout system "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$BIN"
  echo "Removed. (logs left at /var/log/milo-funnel-watchdog*.log)"
  exit 0
fi

echo "Installing watchdog script -> $BIN"
install -m 0755 -o root -g wheel "$HERE/funnel-watchdog.sh" "$BIN"

echo "Installing LaunchDaemon -> $PLIST"
install -m 0644 -o root -g wheel "$HERE/com.milo.funnel-watchdog.plist" "$PLIST"

# Reload cleanly (bootout then bootstrap) so re-runs pick up edits.
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
# Non-fatal: bootstrap already loads+starts it, and `enable` exits non-zero when it's already
# enabled — which under `set -e` would abort the script (and break any `&&` the caller chained on).
launchctl enable "system/${LABEL}" || true

echo
echo "Installed and running. Follow it with:"
echo "  tail -f /var/log/milo-funnel-watchdog.log"
echo "Remove with:  sudo bash scripts/install-funnel-watchdog.sh off"
