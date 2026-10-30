#!/bin/sh
set -e

# ── SSM bootstrap ──────────────────────────────────────────────────────────────
# The CDK stack passes parameter paths as _PARAM env vars to avoid SSM Secure
# dynamic references (not supported by AWS::BedrockAgentCore::Runtime).
# Resolve them here before starting the process.

ssm_get() {
  aws ssm get-parameter \
    --name "$1" \
    --with-decryption \
    --query "Parameter.Value" \
    --output text \
    --region "${AWS_REGION:-ap-southeast-2}" 2>/dev/null
}

if [ -n "$DECIDER_KEY_PARAM" ] && [ -z "$DECIDER_KEY" ]; then
  DECIDER_KEY=$(ssm_get "$DECIDER_KEY_PARAM") && export DECIDER_KEY
  echo "[overseer] Resolved DECIDER_KEY from $DECIDER_KEY_PARAM"
fi

if [ -n "$TS_AUTHKEY_PARAM" ] && [ -z "$TS_AUTHKEY" ]; then
  TS_AUTHKEY=$(ssm_get "$TS_AUTHKEY_PARAM") && export TS_AUTHKEY
  echo "[overseer] Resolved TS_AUTHKEY from $TS_AUTHKEY_PARAM"
fi

if [ -n "$TS_STATE_PARAM" ] && [ -z "$TS_STATE" ]; then
  TS_STATE=$(ssm_get "$TS_STATE_PARAM") && export TS_STATE
  echo "[overseer] Resolved TS_STATE from $TS_STATE_PARAM"
fi

# ── Tailscale ──────────────────────────────────────────────────────────────────

ts_connect() {
  # Try to bring up tailscale and verify it's actually connected.
  # Returns 0 if connected, 1 otherwise.
  tailscale up "$@" \
    --hostname="core-overseer" \
    --accept-dns=true \
    --accept-routes=false \
    --timeout=20s \
    2>&1 || return 1
  # Verify the node is online
  tailscale status 2>&1 | grep -q "^core-overseer\|Logged in" && return 0 || return 1
}

ts_started=0

if [ -n "$TS_STATE" ]; then
  echo "[overseer] Trying tailscaled with pre-auth state..."
  echo "$TS_STATE" | base64 -d > /tmp/ts-state 2>/dev/null || true

  tailscaled \
    --state=/tmp/ts-state \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=localhost:1080 &
  sleep 3

  if ts_connect; then
    echo "[overseer] Tailscale ready (pre-auth state)"
    ts_started=1
  else
    echo "[overseer] State auth failed — falling back to auth key"
    # Kill the daemon and retry with auth key
    pkill tailscaled 2>/dev/null || true
    sleep 1
  fi
fi

if [ "$ts_started" = "0" ] && [ -n "$TS_AUTHKEY" ]; then
  echo "[overseer] Starting tailscaled with auth key..."
  tailscaled \
    --state=mem: \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=localhost:1080 &
  sleep 2

  if ts_connect --authkey="$TS_AUTHKEY"; then
    echo "[overseer] Tailscale ready (auth key)"
    ts_started=1

    # Capture state for next boot — write base64-encoded state back to SSM
    if [ -n "$TS_STATE_PARAM" ]; then
      NEW_STATE=$(tailscale debug state 2>/dev/null | base64 2>/dev/null) || true
      if [ -n "$NEW_STATE" ]; then
        aws ssm put-parameter \
          --name "$TS_STATE_PARAM" \
          --value "$NEW_STATE" \
          --type SecureString \
          --overwrite \
          --region "${AWS_REGION:-ap-southeast-2}" 2>/dev/null \
          && echo "[overseer] Saved fresh Tailscale state to SSM" \
          || echo "[overseer] Warning: could not save Tailscale state to SSM"
      fi
    fi
  else
    echo "[overseer] Auth key connect failed — running without Tailscale"
  fi
fi

if [ "$ts_started" = "1" ]; then
  export ALL_PROXY=http://localhost:1080
  export HTTP_PROXY=http://localhost:1080
else
  echo "[overseer] No Tailscale — Decider calls will fail unless DECIDER_URL is reachable directly"
fi

exec node main.js
