#!/bin/bash
# E2E Long-Running Sync Test Runner
#
# Usage: ./run.sh [test-id]
# Example: ./run.sh SYNC-002
#
# Requires:
# - DIRECT_PROJECT_ID and DIRECT_PROJECT_TOKEN env vars
# - Node.js with tsx installed globally or in PATH

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ID="${1:-SYNC-$(date +%Y%m%d-%H%M%S)}"
LOG_DIR="${SCRIPT_DIR}/../logs"
DATA_FILE="${LOG_DIR}/${TEST_ID}-data.ndjson"

mkdir -p "$LOG_DIR"

if [ -z "$DIRECT_PROJECT_ID" ] || [ -z "$DIRECT_PROJECT_TOKEN" ]; then
  echo "Error: DIRECT_PROJECT_ID and DIRECT_PROJECT_TOKEN must be set"
  exit 1
fi

export DATA_FILE

echo "=== E2E Sync Test: $TEST_ID ==="
echo "Started: $(date -Iseconds)"
echo "Data file: $DATA_FILE"
echo ""

npx tsx "${SCRIPT_DIR}/long-running-sync-stats.ts"
