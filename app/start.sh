#!/bin/sh
set -e

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
