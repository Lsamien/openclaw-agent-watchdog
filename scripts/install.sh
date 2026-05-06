#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
REPO_URL="${1:-https://github.com/Lsamien/openclaw-agent-watchdog.git}"

echo "[agent-watchdog] Installing from: ${REPO_URL}"
"${OPENCLAW_BIN}" plugins install "${REPO_URL}" --force

echo "[agent-watchdog] Enabling plugin..."
"${OPENCLAW_BIN}" plugins enable agent-watchdog || true

echo "[agent-watchdog] Restarting gateway..."
"${OPENCLAW_BIN}" gateway restart

echo "[agent-watchdog] Done."
echo "Try:"
echo "  ${OPENCLAW_BIN} watchdog status --json"
echo "  ${OPENCLAW_BIN} watchdog ui"
