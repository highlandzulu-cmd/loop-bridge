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

if [ ! -f .env ]; then
	cp .env.example .env
	echo "==> Created .env from .env.example (first run)."
fi

# A missing/unconfigured model provider used to be the single most confusing
# failure mode here: the bridge would build fine, boot fine, log "harness
# ready", and then every real message would just silently fail — no error,
# no hint why. Catching it here, before anything starts, and actually
# asking for what's missing beats that every time.
#
# Heuristic, not exhaustive: if LOOP_SERVER_PROVIDER is already set in .env,
# assume a custom provider was deliberately configured (with its own key)
# and don't second-guess it. Otherwise, this is about to fall back to the
# harness's built-in "soket" default, which needs one of three possible
# key env vars — check for any of those before assuming nothing's set up.
if ! grep -qE '^LOOP_SERVER_PROVIDER=' .env 2>/dev/null; then
	if [ -z "${SOKET_API_KEY:-}${TENSORSTUDIO_API_KEY:-}${LOOP_API_KEY:-}" ] \
		&& ! grep -qE '^(SOKET_API_KEY|TENSORSTUDIO_API_KEY|LOOP_API_KEY)=' .env 2>/dev/null; then
		echo
		echo "==> No model provider configured yet."
		echo "    This bridge needs a real API key — there's no default that works"
		echo "    with zero setup. Pick one:"
		echo
		echo "    1) I have a Soket-shaped key (SOKET_API_KEY / TENSORSTUDIO_API_KEY / LOOP_API_KEY)"
		echo "    2) I've already set up a custom provider — skip this (I'll edit .env myself)"
		echo
		read -r -p "    Choice [1/2]: " provider_choice
		if [ "$provider_choice" = "1" ]; then
			read -r -s -p "    Paste your API key: " api_key
			echo
			if [ -n "$api_key" ]; then
				echo "SOKET_API_KEY=${api_key}" >>.env
				echo "==> Saved to .env."
			else
				echo "error: no key entered — nothing saved. Add one to .env manually and re-run." >&2
				exit 1
			fi
		else
			echo "==> Skipping — make sure .env has LOOP_SERVER_PROVIDER/LOOP_SERVER_MODEL"
			echo "    and that provider's key set, per bridge/README.md, or this will still"
			echo "    boot fine and then fail silently on the first real message."
		fi
		echo
	fi
fi

echo "==> Using config from .env"

if ! command -v cargo >/dev/null 2>&1; then
	echo
	echo "==> Rust isn't installed (no 'cargo' on PATH) — this bridge needs it to build."
	read -r -p "    Install it now via rustup.rs? [y/N]: " install_rust
	if [ "$install_rust" = "y" ] || [ "$install_rust" = "Y" ]; then
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
		# shellcheck disable=SC1091
		. "$HOME/.cargo/env"
		if ! command -v cargo >/dev/null 2>&1; then
			echo "error: rustup install finished but 'cargo' still isn't on PATH." >&2
			echo "       Open a new terminal (or run: source \$HOME/.cargo/env) and re-run this script." >&2
			exit 1
		fi
		echo "==> Rust installed."
		echo
	else
		echo "error: cargo not found — install Rust (https://rustup.rs) first, then re-run." >&2
		exit 1
	fi
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
WEB_PORT="${LOOP_SERVER_CORS_ORIGIN:-}"
WEB_PORT="${WEB_PORT##*:}"
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
