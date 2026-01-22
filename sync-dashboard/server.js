"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const DATA_PATH = "/tmp/e2e-sync-data.ndjson";
const MISMATCH_PATH = "/tmp/e2e-sync-data-mismatches.ndjson";
const RECOVERY_PATH = "/tmp/e2e-sync-data-recoveries.ndjson";
const ERROR_PATH = "/tmp/e2e-sync-data-errors.ndjson";

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

function parseNdjson(raw) {
  return raw.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
}

function safeReadNdjson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return parseNdjson(fs.readFileSync(filePath, "utf8"));
  } catch { return []; }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function computeStats(points) {
  if (!points.length) return {
    drift: { mean: null, stddev: null, min: null, max: null, p50: null, p90: null, p99: null },
    latency: { directAvgMs: null, referenceAvgMs: null },
    speedupRatio: null,
    passCount: 0, failCount: 0,
    totalDirectErrors: 0, totalRefErrors: 0,
    batch: { avgLatencyMs: null, orderedRate: null, matchRate: null, avgSpeedup: null },
    memory: { currentHeapMB: null, maxHeapMB: null, trend: null }
  };

  const driftValues = [], directLatencies = [], referenceLatencies = [];
  const batchLatencies = [], batchSpeedups = [];
  const heapValues = [];
  let passCount = 0, failCount = 0, totalDirectErrors = 0, totalRefErrors = 0;
  let batchOrderedCount = 0, batchMatchCount = 0, batchTotal = 0;

  for (const p of points) {
    if (Number.isFinite(p.drift)) driftValues.push(p.drift);
    if (Number.isFinite(p.directLatencyMs)) directLatencies.push(p.directLatencyMs);
    if (Number.isFinite(p.referenceLatencyMs)) referenceLatencies.push(p.referenceLatencyMs);
    if (p.readsMatched === true) passCount++;
    if (p.readsMatched === false) failCount++;
    if (Number.isFinite(p.directErrors)) totalDirectErrors += p.directErrors;
    if (Number.isFinite(p.refErrors)) totalRefErrors += p.refErrors;
    
    // Batch stats
    if (Number.isFinite(p.directBatchLatencyMs)) {
      batchLatencies.push(p.directBatchLatencyMs);
      batchTotal++;
      if (p.directBatchOrdered) batchOrderedCount++;
      if (p.batchMatched) batchMatchCount++;
      if (Number.isFinite(p.batchSpeedup)) batchSpeedups.push(p.batchSpeedup);
    }
    
    // Memory stats
    if (Number.isFinite(p.heapUsedMB)) heapValues.push(p.heapUsedMB);
  }

  const driftSorted = driftValues.slice().sort((a, b) => a - b);
  const driftSum = driftValues.reduce((s, v) => s + v, 0);
  const driftMean = driftValues.length ? driftSum / driftValues.length : null;
  const driftVar = driftValues.length ? driftValues.reduce((s, v) => s + Math.pow(v - driftMean, 2), 0) / driftValues.length : null;

  const directAvg = directLatencies.length ? directLatencies.reduce((s, v) => s + v, 0) / directLatencies.length : null;
  const refAvg = referenceLatencies.length ? referenceLatencies.reduce((s, v) => s + v, 0) / referenceLatencies.length : null;
  const speedupRatio = directAvg && refAvg ? refAvg / directAvg : null;

  // Batch aggregates
  const batchAvgLatency = batchLatencies.length ? batchLatencies.reduce((s, v) => s + v, 0) / batchLatencies.length : null;
  const batchAvgSpeedup = batchSpeedups.length ? batchSpeedups.reduce((s, v) => s + v, 0) / batchSpeedups.length : null;

  // Memory trend (compare first 10% to last 10%)
  let memoryTrend = null;
  if (heapValues.length >= 20) {
    const tenPct = Math.floor(heapValues.length * 0.1);
    const firstAvg = heapValues.slice(0, tenPct).reduce((s, v) => s + v, 0) / tenPct;
    const lastAvg = heapValues.slice(-tenPct).reduce((s, v) => s + v, 0) / tenPct;
    memoryTrend = Math.round((lastAvg - firstAvg) * 100) / 100; // MB change
  }

  return {
    drift: {
      mean: driftMean,
      stddev: driftVar === null ? null : Math.sqrt(driftVar),
      min: driftSorted[0] ?? null,
      max: driftSorted[driftSorted.length - 1] ?? null,
      p50: percentile(driftSorted, 0.5),
      p90: percentile(driftSorted, 0.9),
      p99: percentile(driftSorted, 0.99)
    },
    latency: { directAvgMs: directAvg, referenceAvgMs: refAvg },
    speedupRatio,
    passCount, failCount,
    totalDirectErrors, totalRefErrors,
    batch: {
      avgLatencyMs: batchAvgLatency,
      orderedRate: batchTotal ? batchOrderedCount / batchTotal : null,
      matchRate: batchTotal ? batchMatchCount / batchTotal : null,
      avgSpeedup: batchAvgSpeedup
    },
    memory: {
      currentHeapMB: heapValues[heapValues.length - 1] ?? null,
      maxHeapMB: heapValues.length ? Math.max(...heapValues) : null,
      trend: memoryTrend
    }
  };
}

function computeMismatchStats(mismatches, recoveries) {
  const recoveryMap = new Map(recoveries.map(r => [r.mismatchId, r]));
  let recovered = 0, persistent = 0, pending = 0;
  
  for (const m of mismatches) {
    const r = recoveryMap.get(m.mismatchId);
    if (!r) pending++;
    else if (r.recovered) recovered++;
    else persistent++;
  }
  
  return {
    total: mismatches.length, recovered, persistent, pending,
    mismatches: mismatches.slice(-20),
    recoveries: recoveries.slice(-20)
  };
}

const MAX_POINTS_TO_CLIENT = 500; // Limit data sent to client

app.get("/api/stats", (req, res) => {
  fs.readFile(DATA_PATH, "utf8", (err, raw) => {
    if (err) return res.status(500).json({ error: "Failed to read data" });
    
    try {
      const allPoints = parseNdjson(raw).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const stats = computeStats(allPoints); // Stats from ALL data
      const points = allPoints.slice(-MAX_POINTS_TO_CLIENT); // But only send last N to client
      const mismatches = safeReadNdjson(MISMATCH_PATH);
      const recoveries = safeReadNdjson(RECOVERY_PATH);
      const mismatchStats = computeMismatchStats(mismatches, recoveries);
      const errors = safeReadNdjson(ERROR_PATH);
      
      res.json({ points, stats, mismatchStats, errorStats: { directErrors: stats.totalDirectErrors, refErrors: stats.totalRefErrors, recentErrors: errors.slice(-20) } });
    } catch (e) {
      res.status(500).json({ error: "Parse error", details: e.message });
    }
  });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log(`Dashboard on http://localhost:${PORT}`));
