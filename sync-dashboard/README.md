# Sync Dashboard

Real-time monitoring dashboard for E2E sync tests. Visualizes drift, latency, and speedup metrics comparing Direct vs reference RPC nodes.

## Components

### Dashboard (Web UI)
- **Run**: `npm install && npm start`
- **Access**: http://localhost:3000
- **Data source**: Reads from NDJSON log files

### Test Script
Located in `scripts/long-running-sync-stats.ts`

Compares Direct vs a reference RPC node:
- Block sync (drift between nodes)
- Read latency (Direct vs reference)
- Data consistency (balance reads match)

**Mismatch logging**: When reads don't match, details are dumped to a separate `-mismatches.ndjson` file including:
- Block number
- Contract address
- Values from both nodes
- Any errors encountered

### Runner Script
```bash
# Set credentials
export DIRECT_PROJECT_ID="your-project-id"
export DIRECT_PROJECT_TOKEN="your-token"

# Run test
./scripts/run.sh [test-id]
```

## Data Format

### Main data file (`*-data.ndjson`)
```json
{
  "timestamp": 1769072163985,
  "isoTime": "2026-01-22T08:56:03.985Z",
  "directBlock": 24289270,
  "referenceBlock": 24289270,
  "drift": 0,
  "directLatencyMs": 0.628,
  "referenceLatencyMs": 448.09,
  "readsMatched": true,
  "readCount": 3,
  "directBlockDeltaMs": 11957,
  "refBlockDeltaMs": 11955,
  "directBlockJump": 1,
  "refBlockJump": 1
}
```

### Mismatch file (`*-mismatches.ndjson`)
```json
{
  "timestamp": 1769082687035,
  "isoTime": "2026-01-22T11:51:27.035Z",
  "block": 24290139,
  "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "directValue": "12345678901234567890",
  "referenceValue": null,
  "referenceError": "timeout exceeded"
}
```

## Metrics

- **Success Rate**: Percentage of reads that matched between Direct and reference
- **Drift**: Block number difference (Direct - Reference). Positive = Direct ahead
- **Latency Speedup**: Reference latency / Direct latency
