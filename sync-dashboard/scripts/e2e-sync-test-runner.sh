#!/bin/bash
# E2E Long-Running Sync Test Runner (Statistical Version)
# Test ID: SYNC-001
# Started: 2026-01-22

TEST_ID="SYNC-001"
LOG_DIR="/root/projects/direct-dev/agent-jonathan/logs/e2e-sync"
DATA_FILE="$LOG_DIR/${TEST_ID}-data.ndjson"

mkdir -p "$LOG_DIR"

export DIRECT_PROJECT_ID="ff7f98a1-ef90-46be-b0df-dc927eaaf62b"
export DIRECT_PROJECT_TOKEN="Vmk38kjD"
export DATA_FILE

cd /root/projects/direct-dev/direct-dev-monorepo/apps/e2e.playground

echo "=== E2E Sync Test $TEST_ID (Statistical) ===" 
echo "Started: $(date -Iseconds)"
echo "Data file: $DATA_FILE"
echo ""

# Run the stats test
pnpm scenario src/scenarios/02-state-sync/long-running-sync-stats.ts 2>&1
