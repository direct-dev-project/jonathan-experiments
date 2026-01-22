"use strict";

const REFRESH_INTERVAL_MS = 5000;
let driftChart;
let latencyChart;

const statusBadge = document.getElementById("statusBadge");
const successRateEl = document.getElementById("successRate");
const passFailEl = document.getElementById("passFail");
const driftSummaryEl = document.getElementById("driftSummary");
const driftRangeEl = document.getElementById("driftRange");
const speedupRatioEl = document.getElementById("speedupRatio");
const latencySummaryEl = document.getElementById("latencySummary");
const dataTableEl = document.getElementById("dataTable");
const lastUpdatedEl = document.getElementById("lastUpdated");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return Number(value).toFixed(digits);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function buildCharts() {
  const driftCtx = document.getElementById("driftChart");
  const latencyCtx = document.getElementById("latencyChart");

  driftChart = new Chart(driftCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Drift",
          data: [],
          borderColor: "#4fd1c5",
          backgroundColor: "rgba(79, 209, 197, 0.2)",
          fill: true,
          tension: 0.3,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: "#9aa4bf" },
          grid: { color: "rgba(255,255,255,0.04)" }
        },
        y: {
          ticks: { color: "#9aa4bf" },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      },
      plugins: {
        legend: { labels: { color: "#e6ecff" } }
      }
    }
  });

  latencyChart = new Chart(latencyCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Direct",
          data: [],
          borderColor: "#4fd1c5",
          backgroundColor: "rgba(79, 209, 197, 0.12)",
          tension: 0.3,
          pointRadius: 2
        },
        {
          label: "Reference",
          data: [],
          borderColor: "#ffb86b",
          backgroundColor: "rgba(255, 184, 107, 0.12)",
          tension: 0.3,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: "#9aa4bf" },
          grid: { color: "rgba(255,255,255,0.04)" }
        },
        y: {
          ticks: { color: "#9aa4bf" },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      },
      plugins: {
        legend: { labels: { color: "#e6ecff" } }
      }
    }
  });
}

function updateMetrics(stats) {
  const total = stats.passCount + stats.failCount;
  const successRate = total ? stats.passCount / total : null;

  successRateEl.textContent = formatPercent(successRate);
  passFailEl.textContent = `Pass: ${stats.passCount} / Fail: ${stats.failCount}`;

  driftSummaryEl.textContent = `${formatNumber(stats.drift.mean)} / ${formatNumber(stats.drift.p90)}`;
  driftRangeEl.textContent = `min ${formatNumber(stats.drift.min)}, max ${formatNumber(stats.drift.max)}`;

  speedupRatioEl.textContent = stats.speedupRatio ? `${formatNumber(stats.speedupRatio, 2)}x` : "--";
  latencySummaryEl.textContent = `Direct ${formatNumber(stats.latency.directAvgMs)} ms, Ref ${formatNumber(stats.latency.referenceAvgMs)} ms`;
}

function updateCharts(points) {
  const labels = points.map((p) => p.isoTime || new Date(p.timestamp).toISOString());
  driftChart.data.labels = labels;
  driftChart.data.datasets[0].data = points.map((p) => p.drift ?? null);
  driftChart.update();

  latencyChart.data.labels = labels;
  latencyChart.data.datasets[0].data = points.map((p) => p.directLatencyMs ?? null);
  latencyChart.data.datasets[1].data = points.map((p) => p.referenceLatencyMs ?? null);
  latencyChart.update();
}

function updateTable(points) {
  dataTableEl.innerHTML = "";
  const recent = points.slice(-15).reverse();
  for (const point of recent) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${point.isoTime || "--"}</td>
      <td>${formatNumber(point.drift)}</td>
      <td>${formatNumber(point.directLatencyMs)}</td>
      <td>${formatNumber(point.referenceLatencyMs)}</td>
      <td class="${point.readsMatched ? "ok" : "fail"}">${point.readsMatched ? "Yes" : "No"}</td>
      <td>${point.readCount ?? "--"}</td>
    `;
    dataTableEl.appendChild(row);
  }
}

function setStatus(ok, message) {
  if (ok) {
    statusBadge.textContent = "Live";
    statusBadge.style.borderColor = "rgba(79, 209, 197, 0.4)";
    statusBadge.style.color = "#e6ecff";
  } else {
    statusBadge.textContent = "Error";
    statusBadge.style.borderColor = "rgba(255, 107, 107, 0.6)";
    statusBadge.style.color = "#ffb3b3";
  }
  if (message) {
    lastUpdatedEl.textContent = message;
  }
}

async function fetchStats() {
  try {
    const res = await fetch("/api/stats", { cache: "no-store" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const payload = await res.json();
    updateMetrics(payload.stats);
    updateCharts(payload.points);
    updateTable(payload.points);
    lastUpdatedEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    setStatus(true);
  } catch (err) {
    setStatus(false, `Last error: ${err.message}`);
  }
}

function init() {
  buildCharts();
  fetchStats();
  setInterval(fetchStats, REFRESH_INTERVAL_MS);
}

window.addEventListener("load", init);
