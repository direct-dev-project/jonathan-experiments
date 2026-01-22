"use strict";

const REFRESH_MS = 5000;
let driftChart, latencyChart, memoryChart, batchChart;

const fmt = (v, d = 2) => v == null || isNaN(v) ? "--" : Number(v).toFixed(d);
const pct = v => v == null || isNaN(v) ? "--" : `${(v * 100).toFixed(1)}%`;

function buildCharts() {
  const chartOpts = (label, color) => ({
    type: "line",
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "33", fill: true, tension: 0.3, pointRadius: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#9aa4bf" }, grid: { color: "#ffffff11" } }, y: { ticks: { color: "#9aa4bf" }, grid: { color: "#ffffff11" } } }, plugins: { legend: { labels: { color: "#e6ecff" } } } }
  });

  driftChart = new Chart(document.getElementById("driftChart"), chartOpts("Drift", "#4fd1c5"));
  
  latencyChart = new Chart(document.getElementById("latencyChart"), {
    type: "line",
    data: { labels: [], datasets: [
      { label: "Direct", data: [], borderColor: "#4fd1c5", tension: 0.3, pointRadius: 1 },
      { label: "Reference", data: [], borderColor: "#ffb86b", tension: 0.3, pointRadius: 1 }
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#9aa4bf" }, grid: { color: "#ffffff11" } }, y: { ticks: { color: "#9aa4bf" }, grid: { color: "#ffffff11" } } }, plugins: { legend: { labels: { color: "#e6ecff" } } } }
  });

  memoryChart = new Chart(document.getElementById("memoryChart"), chartOpts("Heap (MB)", "#a78bfa"));
  batchChart = new Chart(document.getElementById("batchChart"), chartOpts("Batch (ms)", "#f472b6"));
}

const MAX_CHART_POINTS = 200; // Sliding window for charts

function updateCharts(points) {
  // Use only last N points for charts to prevent memory bloat
  const chartPoints = points.slice(-MAX_CHART_POINTS);
  const labels = chartPoints.map(p => p.isoTime?.slice(11, 19) || "");
  
  driftChart.data.labels = labels;
  driftChart.data.datasets[0].data = chartPoints.map(p => p.drift ?? null);
  driftChart.update();

  latencyChart.data.labels = labels;
  latencyChart.data.datasets[0].data = chartPoints.map(p => p.directLatencyMs ?? null);
  latencyChart.data.datasets[1].data = chartPoints.map(p => p.referenceLatencyMs ?? null);
  latencyChart.update();

  memoryChart.data.labels = labels;
  memoryChart.data.datasets[0].data = chartPoints.map(p => p.heapUsedMB ?? null);
  memoryChart.update();

  batchChart.data.labels = labels;
  batchChart.data.datasets[0].data = chartPoints.map(p => p.directBatchLatencyMs ?? null);
  batchChart.update();
}

function updateMetrics(stats, pointCount) {
  const total = stats.passCount + stats.failCount;
  document.getElementById("successRate").textContent = pct(total ? stats.passCount / total : null);
  document.getElementById("passFail").textContent = `${stats.passCount} / ${stats.failCount}`;
  
  document.getElementById("driftSummary").textContent = `${fmt(stats.drift.mean)} / ${fmt(stats.drift.p90)}`;
  document.getElementById("driftRange").textContent = `min ${fmt(stats.drift.min)}, max ${fmt(stats.drift.max)}`;
  
  document.getElementById("speedupRatio").textContent = stats.speedupRatio ? `${fmt(stats.speedupRatio)}x` : "--";
  document.getElementById("latencySummary").textContent = `D:${fmt(stats.latency.directAvgMs)}ms R:${fmt(stats.latency.referenceAvgMs)}ms`;

  // Batch metrics
  document.getElementById("batchOrdered").textContent = pct(stats.batch.orderedRate);
  document.getElementById("batchMatch").textContent = pct(stats.batch.matchRate);
  document.getElementById("batchSpeedup").textContent = stats.batch.avgSpeedup ? `${fmt(stats.batch.avgSpeedup)}x` : "--";
  document.getElementById("batchLatency").textContent = `avg ${fmt(stats.batch.avgLatencyMs)}ms`;

  // Memory metrics
  document.getElementById("heapMemory").textContent = stats.memory.currentHeapMB ? `${fmt(stats.memory.currentHeapMB)} MB` : "--";
  const trend = stats.memory.trend;
  const trendEl = document.getElementById("memoryTrend");
  if (trend !== null) {
    const sign = trend >= 0 ? "+" : "";
    trendEl.textContent = `Trend: ${sign}${fmt(trend)} MB`;
    trendEl.style.color = trend > 5 ? "#ff6b6b" : trend < -1 ? "#4fd1c5" : "#9aa4bf";
  } else {
    trendEl.textContent = "Collecting...";
  }

  // Errors
  document.getElementById("directErrors").textContent = stats.totalDirectErrors;
  document.getElementById("refErrors").textContent = stats.totalRefErrors;
  document.getElementById("directErrors").style.color = stats.totalDirectErrors > 0 ? "#ff6b6b" : "#4fd1c5";
  document.getElementById("refErrors").style.color = stats.totalRefErrors > 0 ? "#ffb86b" : "#4fd1c5";

  document.getElementById("totalSamples").textContent = pointCount;
}

function updateMismatches(ms) {
  if (!ms) return;
  document.getElementById("totalMismatches").textContent = ms.total;
  document.getElementById("recoveredMismatches").textContent = ms.recovered;
  document.getElementById("persistentMismatches").textContent = ms.persistent;
  document.getElementById("persistentMismatches").style.color = ms.persistent > 0 ? "#ff6b6b" : "#4fd1c5";
}

function updateTable(points) {
  const tbody = document.getElementById("dataTable");
  tbody.innerHTML = "";
  const recent = points.slice(-12).reverse();
  for (const p of recent) {
    const batchOk = p.directBatchOrdered && p.batchMatched;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${p.isoTime?.slice(11, 19) || "--"}</td>
      <td>${fmt(p.drift)}</td>
      <td>${fmt(p.directLatencyMs)}</td>
      <td>${fmt(p.referenceLatencyMs)}</td>
      <td class="${batchOk ? "ok" : "fail"}">${batchOk ? "✓" : "✗"}</td>
      <td>${fmt(p.heapUsedMB)}</td>
    `;
    tbody.appendChild(row);
  }
}

async function fetchStats() {
  try {
    const res = await fetch("/api/stats", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    updateMetrics(data.stats, data.points.length);
    updateMismatches(data.mismatchStats);
    updateCharts(data.points);
    updateTable(data.points);
    
    document.getElementById("statusBadge").textContent = "Live";
    document.getElementById("statusBadge").style.color = "#e6ecff";
    document.getElementById("lastUpdated").textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById("statusBadge").textContent = "Error";
    document.getElementById("statusBadge").style.color = "#ff6b6b";
  }
}

window.addEventListener("load", () => {
  buildCharts();
  fetchStats();
  setInterval(fetchStats, REFRESH_MS);
});
