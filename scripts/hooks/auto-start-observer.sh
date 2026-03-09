#!/usr/bin/env bash
# Auto-start the continuous learning v2 observer on SessionStart.
#
# Checks if the observer is already running for the current project.
# If not, starts it in the background (detached from this hook process).
# Passes stdin through unchanged so other hooks can consume it.

set -euo pipefail

# Pass stdin through unchanged (SessionStart hooks chain via stdout)
INPUT="$(cat)"

# Resolve plugin root
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  printf '%s' "$INPUT"
  exit 0
fi

STARTER="${PLUGIN_ROOT}/skills/continuous-learning-v2/agents/start-observer.sh"

if [ ! -f "$STARTER" ]; then
  printf '%s' "$INPUT"
  exit 0
fi

# Check config — only start if observer.enabled is true
CONFIG_FILE="${PLUGIN_ROOT}/skills/continuous-learning-v2/config.json"
if [ -f "$CONFIG_FILE" ]; then
  ENABLED=$(python3 -c "
import json, sys
try:
    with open('${CONFIG_FILE}') as f:
        cfg = json.load(f)
    print(str(cfg.get('observer', {}).get('enabled', False)).lower())
except Exception:
    print('false')
" 2>/dev/null || echo "false")

  if [ "$ENABLED" != "true" ]; then
    printf '%s' "$INPUT"
    exit 0
  fi
fi

# Start observer silently in background (suppress all output)
bash "$STARTER" start >/dev/null 2>&1 &

# Pass stdin through for downstream hooks
printf '%s' "$INPUT"
exit 0
