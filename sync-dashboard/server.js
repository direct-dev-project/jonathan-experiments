"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const DATA_PATH = "/tmp/e2e-sync-data.ndjson";
const MISMATCH_PATH = "/tmp/e2e-sync-data-mismatches.ndjson";
const RECOVERY_PATH = "/tmp/e2e-sync-data-recoveries.ndjson";

const app = express();

app.disable("x-powered-by");

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  etag: true
}));

function parseNdjson(raw) {
  const lines = raw.split(/\r?\n/);
  const data = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      data.push(parsed);
    } catch (err) {
      const error = new Error(`Invalid JSON on line ${i + 1}: ${err.message}`);
      error.code = "PARSE_ERROR";
      throw error;
    }
  }
  return data;
}

function safeReadNdjson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return parseNdjson(raw);
  } catch (err) {
    return [];
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function computeStats(points) {
  if (!points.length) {
    return {
      drift: {
        mean: null,
        stddev: null,
        min: null,
        max: null,
        p50: null,
        p90: null,
        p99: null
      },
      latency: {
        directAvgMs: null,
        referenceAvgMs: null
      },
      speedupRatio: null,
      passCount: 0,
      failCount: 0
    };
  }

  const driftValues = [];
  const directLatencies = [];
  const referenceLatencies = [];
  let passCount = 0;
  let failCount = 0;

  for (const point of points) {
    if (Number.isFinite(point.drift)) driftValues.push(point.drift);
    if (Number.isFinite(point.directLatencyMs)) directLatencies.push(point.directLatencyMs);
    if (Number.isFinite(point.referenceLatencyMs)) referenceLatencies.push(point.referenceLatencyMs);
    if (point.readsMatched === true) passCount += 1;
    if (point.readsMatched === false) failCount += 1;
  }

  const driftSorted = driftValues.slice().sort((a, b) => a - b);
  const driftSum = driftValues.reduce((sum, v) => sum + v, 0);
  const driftMean = driftValues.length ? driftSum / driftValues.length : null;
  const driftVar = driftValues.length
    ? driftValues.reduce((sum, v) => sum + Math.pow(v - driftMean, 2), 0) / driftValues.length
    : null;

  const directAvg = directLatencies.length
    ? directLatencies.reduce((sum, v) => sum + v, 0) / directLatencies.length
    : null;
  const referenceAvg = referenceLatencies.length
    ? referenceLatencies.reduce((sum, v) => sum + v, 0) / referenceLatencies.length
    : null;

  let speedupRatio = null;
  if (directAvg && referenceAvg) {
    speedupRatio = referenceAvg / directAvg;
  }

  return {
    drift: {
      mean: driftMean,
      stddev: driftVar === null ? null : Math.sqrt(driftVar),
      min: driftSorted.length ? driftSorted[0] : null,
      max: driftSorted.length ? driftSorted[driftSorted.length - 1] : null,
      p50: percentile(driftSorted, 0.5),
      p90: percentile(driftSorted, 0.9),
      p99: percentile(driftSorted, 0.99)
    },
    latency: {
      directAvgMs: directAvg,
      referenceAvgMs: referenceAvg
    },
    speedupRatio,
    passCount,
    failCount
  };
}

function computeMismatchStats(mismatches, recoveries) {
  const totalMismatches = mismatches.length;
  
  // Build a map of recoveries by mismatchId
  const recoveryMap = new Map();
  for (const r of recoveries) {
    recoveryMap.set(r.mismatchId, r);
  }
  
  let recoveredCount = 0;
  let persistentCount = 0;
  let pendingCount = 0;
  
  for (const m of mismatches) {
    const recovery = recoveryMap.get(m.mismatchId);
    if (!recovery) {
      pendingCount++;
    } else if (recovery.recovered) {
      recoveredCount++;
    } else {
      persistentCount++;
    }
  }
  
  return {
    total: totalMismatches,
    recovered: recoveredCount,      // Reference hiccups
    persistent: persistentCount,    // Potential Direct bugs
    pending: pendingCount,          // Awaiting retry result
    mismatches: mismatches.slice(-20), // Last 20 mismatches
    recoveries: recoveries.slice(-20)  // Last 20 recoveries
  };
}

app.get("/api/stats", (req, res) => {
  fs.readFile(DATA_PATH, "utf8", (err, raw) => {
    if (err) {
      res.status(500).json({
        error: "Failed to read data file",
        details: err.message
      });
      return;
    }

    let points;
    try {
      points = parseNdjson(raw);
    } catch (parseErr) {
      res.status(500).json({
        error: "Failed to parse data file",
        details: parseErr.message
      });
      return;
    }

    points.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const stats = computeStats(points);
    
    // Load mismatch and recovery data
    const mismatches = safeReadNdjson(MISMATCH_PATH);
    const recoveries = safeReadNdjson(RECOVERY_PATH);
    const mismatchStats = computeMismatchStats(mismatches, recoveries);

    res.json({
      points,
      stats,
      mismatchStats
    });
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: "Server error", details: err.message });
});

app.listen(PORT, () => {
  console.log(`Sync dashboard running on http://localhost:${PORT}`);
});
