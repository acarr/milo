#!/usr/bin/env bash
#
# Installs Milo's daemon as a launchd agent (RunAtLoad + KeepAlive) so it starts at
# login and restarts on crash. Run once, by hand:  bash scripts/install-launchd.sh
# Coexists with other tools on the box (its own label, port, and home).
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.milo.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
START="$HOME/start-milo.sh"
LOG_DIR="${MILO_HOME:-$HOME/.milo}/logs"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# --- bootstrap script: clean env (subscription auth) + toolchain, then exec the daemon ---
cat > "$START" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Force subscription auth (no API billing) and a sane PATH under launchd's bare env.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE CLAUDE_AGENT_SDK_VERSION __CFBundleIdentifier || true
eval "\$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
export PATH="/usr/local/bin:\$HOME/.local/bin:\$PATH"
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd "$REPO"
exec node_modules/.bin/tsx packages/daemon/src/index.ts
EOF
chmod +x "$START"
echo "wrote $START"

# --- launchd plist ---
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$START</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF
echo "wrote $PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded $LABEL — Milo daemon is now running and will restart at login / on crash."
echo "logs: $LOG_DIR/daemon.log   stop: launchctl unload $PLIST"
