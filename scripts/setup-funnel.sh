#!/usr/bin/env bash
#
# Exposes Milo's webhook server on the internet via a Tailscale Funnel mapping:
#   https://<this-node>.<tailnet>.ts.net:8443/webhooks/{linear,github}  ->  127.0.0.1:3457
#
# Phase 6 accelerator. Polling remains the system of record, so the Funnel is best-effort —
# if it's down, work still arrives within one poll interval.
#
# Coexists with other tools on the box: Milo takes :8443 -> :3457. We touch ONLY the :8443 mapping,
# never `tailscale funnel reset` (which would wipe any other tool's Funnel mappings, e.g. one on :443).
#
# Run once, by hand:   bash scripts/setup-funnel.sh
# Remove later with:   bash scripts/setup-funnel.sh off
#
set -euo pipefail

TS="${TAILSCALE:-tailscale}"
command -v "$TS" >/dev/null 2>&1 || TS="$HOME/go/bin/tailscale"
command -v "$TS" >/dev/null 2>&1 || { echo "tailscale CLI not found (set \$TAILSCALE)"; exit 1; }

# Read the webhook port from the Milo config, default 3457.
CONFIG="${MILO_HOME:-$HOME/.milo}/config.json"
PORT=3457
if [ -f "$CONFIG" ]; then
  P=$(python3 -c "import json,sys; print(json.load(open('$CONFIG')).get('webhook',{}).get('port',3457))" 2>/dev/null || echo 3457)
  [ -n "$P" ] && PORT="$P"
fi

if [ "${1:-on}" = "off" ]; then
  echo "Removing the :8443 Funnel mapping (leaving any other mappings intact)…"
  "$TS" funnel --https=8443 off || "$TS" serve --https=8443 off || true
  "$TS" funnel status || true
  exit 0
fi

echo "Enabling Funnel :8443 -> http://127.0.0.1:$PORT (background)…"
"$TS" funnel --bg --https=8443 "http://127.0.0.1:$PORT"

echo
echo "Funnel status:"
"$TS" funnel status || true

DNS=$("$TS" status --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || true)
if [ -n "$DNS" ]; then
  echo
  echo "Point your Linear/GitHub webhooks at:"
  echo "  https://$DNS:8443/webhooks/linear"
  echo "  https://$DNS:8443/webhooks/github"
fi

echo
echo "Then in $CONFIG set:  webhook.enabled = true  and  trust.webhookSecrets.{linear,github}"
echo "and restart the daemon. Verify a signed request is accepted; tampered/non-allowlisted are rejected."
