#!/bin/sh
set -e

# ── SSM bootstrap ──────────────────────────────────────────────────────────────
# The CDK stack passes parameter paths as _PARAM env vars to avoid SSM Secure
# dynamic references (not supported by AWS::BedrockAgentCore::Runtime).
# Resolve them here before starting the process.

ssm_get() {
  local param_name="$1"
  aws ssm get-parameter \
    --name "$param_name" \
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

if [ -n "$TS_STATE" ]; then
  echo "[overseer] Starting tailscaled with pre-auth state..."
  echo "$TS_STATE" | base64 -d > /tmp/ts-state

  # Enable HTTP CONNECT proxy on :1080 for userspace-networking outbound
  tailscaled \
    --state=/tmp/ts-state \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=localhost:1080 &
  sleep 2

  tailscale up \
    --hostname="core-overseer" \
    --accept-dns=true \
    --accept-routes=false \
    --timeout=15s \
    2>&1 || echo "[overseer] Tailscale up warning (continuing)"

  export ALL_PROXY=http://localhost:1080
  export HTTP_PROXY=http://localhost:1080

  echo "[overseer] Tailscale ready (pre-auth state loaded, HTTP proxy at :1080)"
elif [ -n "$TS_AUTHKEY" ]; then
  echo "[overseer] Starting tailscaled with auth key (slow path)..."
  tailscaled \
    --state=mem: \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=localhost:1080 &
  sleep 2
  tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="core-overseer" \
    --accept-dns=true \
    --accept-routes=false \
    --timeout=60s \
    2>&1 &
  export ALL_PROXY=http://localhost:1080
  export HTTP_PROXY=http://localhost:1080
  echo "[overseer] Tailscale connecting in background..."
else
  echo "[overseer] No TS_STATE or TS_AUTHKEY — dev mode"
fi

exec node main.js
