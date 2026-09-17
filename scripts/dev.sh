#!/usr/bin/env bash
# One-command dev startup: builds and runs loop-server, then the web
# frontend, and tears both down together on Ctrl+C / exit.
#
# Usage:
#   ./scripts/dev.sh
#
# Configure via .env in the repo root (copy .env.example — see it for every
# available option and what it means). Missing .env is fine; loop-server
# just falls back to whatever's in ~/.loop/agent/settings.json.
#
# Run from anywhere; paths below are resolved relative to this script, not
# the caller's current directory.
set -euo pipefail
# Job control on, even though this runs non-interactively: it's what gives
# each `&` background job its own process group. Without it, `kill $pid` on
# the `npm run dev` job only kills that immediate subshell — npm's actual
# child (vite) is a grandchild in a different process and is left running,
# orphaned, still holding port 5173. Verified live: without `set -m`, Ctrl-C
# on this script stopped loop-server but left vite running in the
# background. With it, `kill -- -$pid` below (negative PID = whole group)
# takes the real process down too.
set -m

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
	echo "==> Using config from .env"
else
	echo "==> No .env found — using whatever's configured in ~/.loop/agent/settings.json."
	echo "    (copy .env.example to .env to point at a local model, a different port, etc.)"
fi

if ! command -v cargo >/dev/null 2>&1; then
	echo "error: cargo not found — install Rust (https://rustup.rs) first." >&2
	exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
	echo "error: npm not found — install Node.js first." >&2
	exit 1
fi

if [ ! -d web/node_modules ]; then
	echo "==> Installing web/ dependencies (first run only)..."
	(cd web && npm install)
fi

# The frontend origin the bridge will allow — must match wherever Vite
# actually ends up running. Checked *before* starting anything: if this
# port is already taken, Vite silently picks a different one (e.g. 5174),
# the bridge still only allows 5173, and every message then fails in the
# browser with a generic, hard-to-diagnose "Failed to fetch" — CORS
# blocking a cross-origin request, not a real crash anywhere. Catching it
# here, with a clear message, beats debugging that after the fact.
WEB_PORT="${LOOP_SERVER_CORS_ORIGIN##*:}"
WEB_PORT="${WEB_PORT:-5173}"
if lsof -i ":${WEB_PORT}" >/dev/null 2>&1; then
	echo "error: port ${WEB_PORT} is already in use by something else." >&2
	echo "       Vite would silently move to a different port, which breaks CORS" >&2
	echo "       against this bridge. Free port ${WEB_PORT} first (lsof -i :${WEB_PORT}" >&2
	echo "       to see what's using it), or set LOOP_SERVER_CORS_ORIGIN in .env to" >&2
	echo "       match whatever port you actually want to use." >&2
	exit 1
fi

echo "==> Building loop-server..."
cargo build -p loop-server

# Track both child PIDs so a single Ctrl+C tears down the whole stack —
# without this, killing the script leaves loop-server (and its held-open
# harness/session) running orphaned in the background.
PIDS=()
cleanup() {
	echo
	echo "==> Shutting down..."
	for pid in "${PIDS[@]}"; do
		# Negative PID = signal the whole process group, not just this one
		# process — see the `set -m` comment above for why that matters here.
		kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting loop-server on http://127.0.0.1:${LOOP_SERVER_PORT:-8787}..."
# RUST_LOG defaults to showing nothing at all — which looks identical to a
# hang or a crash from a blank terminal. Default to "info" here (unless the
# caller already set RUST_LOG) so the real boot sequence (booting
# AgentHarness / registered N tools / harness ready) is actually visible,
# not silent.
RUST_LOG="${RUST_LOG:-info}" ./target/debug/loop-server &
PIDS+=($!)

# Give loop-server a moment to bind before the frontend's first request —
# cosmetic only (the frontend just shows an error on first send and works
# fine on retry if this races), but avoids a confusing failed-request log
# line right at startup.
sleep 1

echo "==> Starting web frontend on http://localhost:5173..."
(cd web && npm run dev) &
PIDS+=($!)

wait
