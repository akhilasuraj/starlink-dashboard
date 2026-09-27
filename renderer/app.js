const API_URL = "http://127.0.0.1:8000";

let speedChart = null;
let currentTab = "network";
let autoScrollLogs = true;

function initChart() {
  const canvas = document.getElementById("speedChart");
  if (!canvas || typeof Chart === "undefined") return;
  speedChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Download traffic (Mbps)", data: [], borderColor: "#ffffff", spanGaps: false, pointRadius: 0 },
        { label: "Upload traffic (Mbps)", data: [], borderColor: "#999999", spanGaps: false, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { y: { beginAtZero: true } },
    },
  });
}

function byId(id) {
  return document.getElementById(id);
}

function hasSourceAndTime(reading) {
  return reading && typeof reading.source === "string" && reading.source.trim().length > 0 &&
    typeof reading.observed_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reading.observed_at) &&
    Number.isFinite(Date.parse(reading.observed_at));
}

function isReadingAvailable(reading) {
  return reading && (reading.availability === "available" || reading.availability === "stale") &&
    hasSourceAndTime(reading) &&
    typeof reading.value === "number" && Number.isFinite(reading.value);
}

function readingMeta(reading) {
  if (!isReadingAvailable(reading)) return "Unavailable — not reported by the dish";
  const when = new Date(reading.observed_at).toLocaleString();
  const source = reading.source;
  return `${reading.availability === "stale" ? "Stale · " : ""}${source} · ${when}`;
}

function setMetric(id, reading, format = (value) => value.toFixed(1)) {
  const element = byId(id);
  if (!element) return;
  element.textContent = isReadingAvailable(reading) ? format(reading.value) : "Unavailable";
  element.title = readingMeta(reading);
  const meta = byId(`${id}-meta`);
  if (meta) meta.textContent = readingMeta(reading);
}

function setDevice(id, reading) {
  const element = byId(id);
  if (!element) return;
  const available = reading && (reading.availability === "available" || reading.availability === "stale") &&
    hasSourceAndTime(reading) &&
    typeof reading.value === "string" && reading.value.trim().length > 0;
  element.textContent = available ? reading.value : "Unavailable";
  element.title = available
    ? `${reading.availability === "stale" ? "Stale · " : ""}${reading.source} · ${new Date(reading.observed_at).toLocaleString()}`
    : "Not reported by the dish";
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderStatus(status) {
  const collection = status && status.collection_state || "collector_error";
  const statusProvenance = hasSourceAndTime(status);
  const service = statusProvenance && status.service_state || "unknown";
  const label = {
    collecting: "COLLECTING",
    reachable: service === "online" ? "SERVICE ONLINE" : service === "offline" ? "SERVICE OFFLINE" : "SERVICE UNKNOWN",
    dish_unreachable: "DISH UNREACHABLE",
    collector_error: "COLLECTOR ERROR",
    stale: "DATA STALE",
  }[collection] || "SERVICE UNKNOWN";
  const headline = byId("status");
  headline.textContent = label;
  headline.style.color = collection !== "reachable" ? "#FFD600" :
    service === "online" ? "#00C853" : service === "offline" ? "#D50000" : "#FFD600";

  byId("collection-state").textContent =
    `Collection: ${collection.replaceAll("_", " ")} · Service: ${service}` +
    (statusProvenance && status.dish_state ? ` · Dish state: ${status.dish_state}` : "");
  byId("observed-at").textContent = statusProvenance
    ? `Last reading: ${new Date(status.observed_at).toLocaleString()} · Source: ${status.source}${status.stale ? " · stale" : ""}`
    : "No dish reading yet";
  const guidance = byId("guidance");
  guidance.textContent = status && status.guidance ||
    (collection === "collector_error" ? "The desktop collector could not read the dish. Check the backend logs." : "");
  guidance.hidden = !guidance.textContent;

  const metrics = status && status.metrics || {};
  const device = status && status.device || {};
  setMetric("download", metrics.download_mbps);
  setMetric("upload", metrics.upload_mbps);
  setMetric("latency", metrics.latency_ms, (value) => value.toFixed(0));
  setMetric("latency-stat", metrics.latency_ms, (value) => value.toFixed(0));
  setMetric("drop-rate", metrics.drop_rate, (value) => (value * 100).toFixed(1));
  setMetric("dish-uptime", metrics.dish_uptime_s, formatUptime);
  setMetric("gps-sats", metrics.gps_sats, (value) => value.toFixed(0));
  setMetric("azimuth", metrics.azimuth_deg, (value) => `${value.toFixed(1)}°`);
  setMetric("elevation", metrics.elevation_deg, (value) => `${value.toFixed(1)}°`);
  byId("tilt").textContent = "Unavailable";
  byId("tilt").title = "Not provided by this status API";
  setDevice("dish-id", device.id);
  setDevice("hardware", device.hardware);
  setDevice("software", device.software);

  const obstruction = metrics.obstructed_pct;
  byId("obstruction-text").textContent = isReadingAvailable(obstruction)
    ? `Obstructed: ${obstruction.value.toFixed(2)}%` : "Obstruction: Unavailable";
  byId("obstruction-meta").textContent = readingMeta(obstruction);
  byId("obstruction-bar").style.width = isReadingAvailable(obstruction)
    ? `${Math.max(0, Math.min(obstruction.value, 100))}%` : "0%";
}

function renderHistory(history) {
  if (!speedChart) return;
  const samples = Array.isArray(history && history.samples) ? history.samples : [];
  speedChart.data.labels = samples.map((sample) => sample && sample.observed_at || "");
  speedChart.data.datasets[0].data = samples.map((sample) =>
    hasSourceAndTime(sample) && typeof sample.download_mbps === "number" && Number.isFinite(sample.download_mbps)
      ? sample.download_mbps : null);
  speedChart.data.datasets[1].data = samples.map((sample) =>
    hasSourceAndTime(sample) && typeof sample.upload_mbps === "number" && Number.isFinite(sample.upload_mbps)
      ? sample.upload_mbps : null);
  speedChart.update("none");
}

async function updateData() {
  try {
    const response = await fetch(`${API_URL}/api/status`);
    if (!response.ok) throw new Error(`Status API: HTTP ${response.status}`);
    renderStatus(await response.json());
  } catch (error) {
    renderStatus({ collection_state: "collector_error", service_state: "unknown", metrics: {}, device: {} });
    byId("guidance").textContent = "The desktop collector is unavailable. Check that the backend started.";
    byId("guidance").hidden = false;
    console.error("Status fetch failed:", error);
  }
  try {
    const response = await fetch(`${API_URL}/api/history`);
    if (response.ok) renderHistory(await response.json());
  } catch (error) {
    console.error("History fetch failed:", error);
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}

async function updateLogs() {
  if (currentTab !== "logs") return;
  try {
    const response = await fetch(`${API_URL}/api/logs`);
    if (!response.ok) throw new Error(`Logs API: HTTP ${response.status}`);
    const data = await response.json();
    const content = byId("logs-content");
    const wasAtBottom = content.scrollHeight - content.clientHeight <= content.scrollTop + 50;
    content.innerHTML = (Array.isArray(data.logs) ? data.logs : []).map((log) =>
      `<div class="log-entry"><span class="log-time">${escapeHtml(log.timestamp || "")}</span>` +
      `<span class="log-level">${escapeHtml(log.level || "")}</span>` +
      `<span class="log-message">${escapeHtml(log.message || "")}</span></div>`
    ).join("") || "No logs available";
    if (wasAtBottom && autoScrollLogs) content.scrollTop = content.scrollHeight;
  } catch (error) {
    console.error("Logs fetch failed:", error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  document.querySelectorAll(".tab-btn").forEach((button) => button.addEventListener("click", () => {
    currentTab = button.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    byId(currentTab).classList.add("active");
    if (currentTab === "logs") updateLogs();
  }));
  byId("clear-logs").addEventListener("click", async () => {
    await fetch(`${API_URL}/api/logs/clear`, { method: "POST" });
    byId("logs-content").textContent = "Logs cleared";
  });
  byId("logs-content").addEventListener("scroll", (event) => {
    const el = event.target;
    autoScrollLogs = el.scrollHeight - el.clientHeight <= el.scrollTop + 50;
  });
  updateData();
  setInterval(updateData, 2000);
  setInterval(updateLogs, 1000);
});
