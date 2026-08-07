#!/usr/bin/env bash
#
# Funnel watchdog — heals the public Tailscale Funnel when it silently stops serving.
#
# Why this exists: Linear kills an unacked agent delegation in ~10s ("Agent didn't start. The request
# may not have reached the agent."), so a dead Funnel silently drops delegated tickets. Polling still
# backstops the work; this just keeps the accelerator alive. TWO distinct failure modes are seen here:
#
#   1. WEDGED front-end — the mapping is still in the serve config and `tailscale status` reports
#      Health: none, but the public endpoint no longer completes TLS. Only restarting tailscaled
#      rebuilds the front-end; re-asserting the mapping does nothing.
#   2. DELETED mapping — the :8443 entry is gone from the serve config entirely (another tool on the
#      box running `tailscale funnel/serve reset` is the usual suspect; it wipes every mapping, not
#      just its own). Here a kickstart is USELESS — it faithfully rebuilds the front-end from a config
#      that no longer mentions us. Only re-asserting the mapping fixes it.
#
#   On 2026-08-06 mode 2 went undiagnosed for ~7h: the watchdog kickstarted tailscaled ~40 times
#   against a config that had no :8443 entry to serve. Hence the two-tier heal below.
#
# What it does: every $INTERVAL, probe the PUBLIC Funnel path the way Linear reaches it (external DNS
# -> ingress IP -> TLS -> our webhook handler). It uses a GET (any HTTP response = the Funnel completed
# TLS and reached the server = healthy; a dead Funnel fails the TLS handshake instead). GET is
# deliberate: the handler 405s it without recording anything, so the probe never pollutes the
# inbound_events audit table. After $FAIL_THRESHOLD consecutive failures it heals in two tiers,
# cheapest first, both in the same cycle if needed:
#
#   Tier 1  re-assert `funnel --bg --https=$PORT $UPSTREAM` (idempotent, non-disruptive, no cooldown)
#   Tier 2  `launchctl kickstart` tailscaled (disruptive; rate-limited by $COOLDOWN)
#
# Each heal logs whether the mapping was present or missing, plus a serve-config snapshot, so the next
# occurrence is attributable to a mode without re-deriving it.
#
# Runs as root via /Library/LaunchDaemons/com.milo.funnel-watchdog.plist (needs root to kickstart the
# system tailscaled). Install with: sudo bash scripts/install-funnel-watchdog.sh
#
set -uo pipefail

# --- config (override via the environment / plist EnvironmentVariables) ---------------------------
HOST="${FUNNEL_HOST:-enzo.quillback-monster.ts.net}"   # this node's Funnel hostname
PORT="${FUNNEL_PORT:-8443}"                             # Milo's Funnel port
UPSTREAM="${FUNNEL_UPSTREAM:-http://127.0.0.1:3457}"    # Milo's local webhook server (config webhook.port)
PROBE_PATH="${FUNNEL_PROBE_PATH:-/webhooks/linear}"     # GET here -> 405 (no DB write) when healthy
DNS_RESOLVER="${FUNNEL_DNS:-8.8.8.8}"                   # external resolver (proves PUBLIC DNS + path)
INTERVAL="${FUNNEL_INTERVAL:-120}"                      # seconds between probes
FAIL_THRESHOLD="${FUNNEL_FAIL_THRESHOLD:-2}"            # consecutive fails before healing (debounce)
COOLDOWN="${FUNNEL_COOLDOWN:-600}"                      # min seconds between kickstarts (tier 2 only)
TS_LABEL="${FUNNEL_TS_LABEL:-system/com.tailscale.tailscaled}"
LOG="${FUNNEL_LOG:-/var/log/milo-funnel-watchdog.log}"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOG" 2>/dev/null; }

# Resolve the tailscale CLI by absolute path: a LaunchDaemon runs with a bare root PATH
# (/usr/bin:/bin:/usr/sbin:/sbin), so a Homebrew/app-bundle install is NOT on it and a plain
# `tailscale` would silently fail. Empty TS = tier 1 unavailable; we log it and fall back to tier 2.
TS="${TAILSCALE:-}"
if [ -z "$TS" ] || ! [ -x "$TS" ]; then
  TS=""
  for cand in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale \
              /Applications/Tailscale.app/Contents/MacOS/Tailscale "$(command -v tailscale 2>/dev/null)"; do
    [ -n "$cand" ] && [ -x "$cand" ] && { TS="$cand"; break; }
  done
fi

# Is our :$PORT mapping still in the serve config at all? Distinguishes a wedged front-end (present)
# from a wiped config (missing) — the two need opposite remedies.
mapping_present() {
  [ -n "$TS" ] || return 1
  "$TS" serve status --json 2>/dev/null | grep -q "\"$HOST:$PORT\""
}

# One-line snapshot of the serve config, so a future outage is attributable without re-deriving it.
snapshot() {
  [ -n "$TS" ] || return 0
  log "  serve config: $("$TS" serve status --json 2>/dev/null | tr -d ' \n' | cut -c1-500)"
}

# Tier 1 heal — re-assert the mapping. Idempotent, non-disruptive, and the ONLY fix for a wiped
# config. Touches only our :$PORT mapping, never `funnel reset` (that would wipe other tools').
reassert() {
  if [ -z "$TS" ]; then
    log "  tier 1 SKIPPED: tailscale CLI not found (set \$TAILSCALE in the plist)"
    return 1
  fi
  if mapping_present; then
    log "  mapping PRESENT in serve config -> front-end wedged; re-assert may not help, tier 2 likely needed"
  else
    log "  mapping MISSING from serve config -> THIS is why it's down (a kickstart cannot fix this)"
  fi
  log "  tier 1: $TS funnel --bg --https=$PORT $UPSTREAM"
  "$TS" funnel --bg --https="$PORT" "$UPSTREAM" >> "$LOG" 2>&1
}

# probe: 0 = healthy (an ingress completed TLS and the server answered), 1 = down (TLS/connect fails
#        on every ingress), 2 = inconclusive (no external DNS answer — don't act on a DNS blip)
probe() {
  local ips ip code
  ips=$(dig +short "@$DNS_RESOLVER" "$HOST" A 2>/dev/null | grep -E '^[0-9.]+$')
  [ -z "$ips" ] && return 2
  for ip in $ips; do
    # GET (no body): any real HTTP status (e.g. 405) means the Funnel served TLS and reached us.
    # A wedged Funnel fails the handshake -> curl writes "000". This GET is not recorded by the handler.
    code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOST:$PORT:$ip" \
      -m 10 "https://$HOST:$PORT$PROBE_PATH" 2>/dev/null)
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
  done
  return 1
}

fails=0
last_heal=0
log "watchdog started (host=$HOST:$PORT interval=${INTERVAL}s threshold=$FAIL_THRESHOLD cooldown=${COOLDOWN}s)"

while true; do
  if probe; then
    [ "$fails" -gt 0 ] && log "funnel healthy again (recovered after $fails failed probe(s))"
    fails=0
  else
    case $? in
      2) log "probe inconclusive (no DNS from $DNS_RESOLVER) — skipping this cycle" ;;
      *)
        fails=$((fails + 1))
        log "funnel probe FAILED ($fails/$FAIL_THRESHOLD) — public TLS not serving on any ingress"
        if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
          now=$(date +%s)
          snapshot

          # --- Tier 1: re-assert the mapping. Cheap and non-disruptive, so it runs every cycle we're
          # over threshold — no cooldown. Fixes a wiped config, which tier 2 provably cannot.
          healed=0
          if reassert; then
            sleep 5
            if probe; then
              log "HEAL OK (tier 1): funnel serving again after re-asserting the mapping"
              healed=1
              fails=0
            else
              log "  tier 1 did not restore service — escalating"
            fi
          fi

          # --- Tier 2: kickstart tailscaled. Disruptive (drops every mapping's front-end briefly),
          # so it stays rate-limited by $COOLDOWN. Only reached when tier 1 didn't fix it.
          if [ "$healed" -eq 0 ]; then
            if [ $((now - last_heal)) -ge "$COOLDOWN" ]; then
              log "HEALING (tier 2): launchctl kickstart -k $TS_LABEL"
              launchctl kickstart -k "$TS_LABEL" >> "$LOG" 2>&1
              last_heal=$now
              fails=0
              sleep 20
              # Re-assert after the restart too: if the mapping was missing, a rebuilt front-end
              # still has nothing to serve for us until the entry is put back.
              reassert >/dev/null 2>&1
              sleep 5
              if probe; then log "HEAL OK (tier 2): funnel serving again"; else log "HEAL incomplete after 25s — will re-check next cycle"; fi
            else
              log "in cooldown ($((COOLDOWN - (now - last_heal)))s left) — deferring kickstart"
            fi
          fi
        fi
        ;;
    esac
  fi
  sleep "$INTERVAL"
done
