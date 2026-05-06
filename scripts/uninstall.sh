#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

echo "[agent-watchdog] Disabling plugin..."
"${OPENCLAW_BIN}" plugins disable agent-watchdog || true

echo "[agent-watchdog] Uninstalling plugin..."
"${OPENCLAW_BIN}" plugins uninstall agent-watchdog || true

echo "[agent-watchdog] Restarting gateway..."
"${OPENCLAW_BIN}" gateway restart

echo "[agent-watchdog] Done."
