const API_URL = "http://127.0.0.1:8000";

let speedChart = null;
let latencyChart = null;
let lossChart = null;
let currentTab = "network";
let autoScrollLogs = true;
let historyRange = "15m";
let lastHistoryFetchRange = null;
let lastHistoryFetchMs = 0;
let lastSnrRenderKey = null;
const HISTORY_REFRESH_MS = { "15m": 2000, "24h": 60000, "7d": 300000 };
const HISTORY_RANGE_LABELS = { "15m": "15-minute", "24h": "24-hour", "7d": "7-day" };

function createHistoryChart(canvasId, datasets, unit) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return;
  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets: datasets.map((dataset) => ({
      ...dataset, data: [], spanGaps: false, pointRadius: 1, borderWidth: 2,
    })) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: { type: "linear", ticks: { callback: (value) => new Date(value).toLocaleTimeString() } },
        y: { beginAtZero: true, title: { display: true, text: unit } },
      },
      plugins: { tooltip: { callbacks: {
        title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleString() : "",
        afterBody: (items) => items.length && items[0].raw.meta ? items[0].raw.meta : "",
      } } },
    },
  });
}

function initChart() {
  speedChart = createHistoryChart("speedChart", [
    { label: "Current download traffic (Mbps)", borderColor: "#ffffff" },
    { label: "Current upload traffic (Mbps)", borderColor: "#999999" },
  ], "Mbps");
  latencyChart = createHistoryChart("latencyChart", [
    { label: "Latency (ms)", borderColor: "#00c853" },
  ], "ms");
  lossChart = createHistoryChart("lossChart", [
    { label: "Ping drop rate (%)", borderColor: "#ffd600" },
  ], "%");
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

function setDevice(id, reading, unavailableLabel = "Not reported by device") {
  const element = byId(id);
  if (!element) return;
  const available = reading && (reading.availability === "available" || reading.availability === "stale") &&
    hasSourceAndTime(reading) &&
    typeof reading.value === "string" && reading.value.trim().length > 0;
  element.textContent = available ? reading.value : "Unavailable";
  element.title = available
    ? `${reading.availability === "stale" ? "Stale · " : ""}${reading.source} · ${new Date(reading.observed_at).toLocaleString()}`
    : unavailableLabel;
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
  const router = status && status.router || {};
  setDevice("router-id", router.id, "Starlink router unavailable");
  setDevice("router-hardware", router.hardware, "Starlink router unavailable");
  setDevice("router-software", router.software, "Starlink router unavailable");
  const capabilities = status && status.capabilities || {};
  const capabilityStates = status && status.capability_states || {};
  const capabilityLabel = (name) => ["available", "stale", "unavailable"].includes(capabilityStates[name])
    ? capabilityStates[name] : capabilities[name] === true ? "available" : "unavailable";
  byId("device-capabilities").textContent = [
    `Dish diagnostics: ${capabilityLabel("dish_diagnostics")}`,
    `Router diagnostics: ${capabilityLabel("router_diagnostics")}`,
    `Dish alerts: ${capabilityLabel("dish_alerts")}`,
  ].join(" · ");
  const alerts = status && status.alerts;
  const validAlerts = alerts && (alerts.availability === "available" || alerts.availability === "stale") &&
    hasSourceAndTime(alerts) && Array.isArray(alerts.items) && alerts.items.length > 0 &&
    alerts.items.every((item) => item && typeof item.code === "string" && typeof item.active === "boolean");
  const activeAlerts = validAlerts ? alerts.items.filter((item) => item.active) : [];
  byId("dish-alerts").textContent = !validAlerts ? "Dish alerts unavailable" : activeAlerts.length
    ? activeAlerts.map((item) => item.code.replaceAll("_", " ")).join(" · ")
    : "No active dish alerts reported";
  byId("dish-alerts-meta").textContent = validAlerts
    ? `${alerts.availability === "stale" ? "Stale · " : ""}${alerts.source} · ${new Date(alerts.observed_at).toLocaleString()}`
    : "Not reported by this dish or firmware";

  const obstruction = metrics.obstructed_pct;
  byId("obstruction-text").textContent = isReadingAvailable(obstruction)
    ? `Obstructed area reported: ${obstruction.value.toFixed(2)}%` : "Obstruction: Unavailable";
  byId("obstruction-meta").textContent = readingMeta(obstruction);
  byId("obstruction-progress").hidden = !isReadingAvailable(obstruction);
  byId("obstruction-bar").style.width = isReadingAvailable(obstruction)
    ? `${Math.max(0, Math.min(obstruction.value, 100))}%` : "0%";
  const obstructionDetails = status && status.obstruction || {};
  const current = obstructionDetails.currently_obstructed;
  const currentAvailable = current && ["available", "stale"].includes(current.availability) &&
    hasSourceAndTime(current) && typeof current.value === "boolean";
  byId("obstruction-current").textContent = currentAvailable
    ? `Currently obstructed: ${current.value ? "Yes" : "No"}`
    : "Currently obstructed: Unavailable";
  byId("obstruction-current-meta").textContent = currentAvailable
    ? `${current.availability === "stale" ? "Stale · " : ""}${current.source} · ${new Date(current.observed_at).toLocaleString()}`
    : "Not reported by this dish or firmware";
  const snr = obstructionDetails.signal_map;
  const snrRenderKey = snr ? `${snr.source}|${snr.observed_at}|${snr.availability}|${snr.reason}|${snr.stale}` : "unavailable";
  if (snrRenderKey === lastSnrRenderKey) return;
  lastSnrRenderKey = snrRenderKey;
  const rows = snr && snr.cells;
  const columns = Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0]) ? rows[0].length : 0;
  const validMap = snr && ["available", "stale"].includes(snr.availability) &&
    hasSourceAndTime(snr) && Array.isArray(rows) && rows.length <= 128 &&
    columns > 0 && columns <= 128 && rows.every((row) => Array.isArray(row) && row.length === columns &&
      row.every((cell) => cell === null || (typeof cell === "number" && Number.isFinite(cell) && cell >= 0 && cell <= 1))) &&
    rows.some((row) => row.some((cell) => cell !== null));
  const grid = byId("obstruction-snr-grid");
  grid.innerHTML = validMap ? rows.flat().map((cell) => cell === null
    ? '<span class="snr-cell invalid" title="No valid SNR sample"></span>'
    : `<span class="snr-cell" style="background-color:hsl(${Math.round(cell * 120)} 75% 40%)" title="SNR ${cell.toFixed(2)}"></span>`).join("") : "";
  grid.style.gridTemplateColumns = validMap ? `repeat(${columns}, minmax(0, 1fr))` : "";
  const validCount = validMap ? rows.flat().filter((cell) => cell !== null).length : 0;
  byId("obstruction-snr-meta").textContent = validMap
    ? `${snr.availability === "stale" ? "Stale · " : ""}${snr.source} · ${new Date(snr.observed_at).toLocaleString()} · ${validCount} of ${rows.length * columns} valid SNR samples`
    : snr && snr.reason === "no_valid_samples" && hasSourceAndTime(snr)
      ? `${snr.stale ? "Stale · " : ""}Dish reported directional SNR samples, but no valid SNR samples · ${snr.source} · ${new Date(snr.observed_at).toLocaleString()}`
      : "Directional SNR samples not reported by this dish or firmware";
}

function renderHistory(history) {
  const samples = Array.isArray(history && history.samples) ? history.samples : [];
  const coverage = history && history.coverage_start && history.coverage_end
    ? `Observed ${new Date(history.coverage_start).toLocaleString()}–${new Date(history.coverage_end).toLocaleString()}`
    : "No observed samples";
  const duration = HISTORY_RANGE_LABELS[history && history.range] || "History";
  const windowText = `${duration} window · ${coverage}`;
  byId("history-window").textContent = windowText;
  byId("quality-window").textContent = windowText;
  byId("outage-window").textContent = windowText;
  byId("history-time-note").textContent = history && history.time_note ||
    "Sample times and sources unavailable";

  function series(metricName, multiplier = 1) {
    return samples.map((sample) => {
      const x = Date.parse(sample && sample.at);
      if (!Number.isFinite(x)) return null;
      const reading = sample && sample.metrics && sample.metrics[metricName];
      const valid = isReadingAvailable(reading);
      const source = valid ? reading.source : "Uncollected or unavailable";
      const captured = valid ? new Date(reading.observed_at).toLocaleString() : "";
      const timeBasis = reading && reading.time_basis || sample.time_basis;
      const basis = timeBasis === "estimated_from_poll" ? "Estimated sample time" :
        timeBasis === "observed_poll" ? "Observed poll time" :
          timeBasis === "rollup" ? "Observed-sample average" : "Uncollected";
      const coverageNote = valid && timeBasis === "rollup"
        ? ` · ${reading.sample_count} observed samples in ${history.bucket_seconds / 60}-minute bucket` +
          ` · Observed ${new Date(sample.observed_start).toLocaleString()}–${new Date(sample.observed_end).toLocaleString()}`
        : "";
      return { x, y: valid ? reading.value * multiplier : null,
        meta: `${source}${captured ? ` · Captured ${captured}` : ""} · ${basis}${coverageNote}` };
    }).filter(Boolean);
  }

  const start = Date.parse(history && history.window_start);
  const end = Date.parse(history && history.window_end);
  for (const chart of [speedChart, latencyChart, lossChart]) {
    if (!chart) continue;
    if (Number.isFinite(start)) chart.options.scales.x.min = start;
    if (Number.isFinite(end)) chart.options.scales.x.max = end;
    for (const dataset of chart.data.datasets) {
      dataset.showLine = history && history.range === "15m";
      dataset.pointRadius = history && history.range === "15m" ? 1 : 3;
    }
  }
  if (speedChart) {
    speedChart.data.datasets[0].data = series("download_mbps");
    speedChart.data.datasets[1].data = series("upload_mbps");
    speedChart.update("none");
  }
  if (latencyChart) {
    latencyChart.data.datasets[0].data = series("latency_ms");
    latencyChart.update("none");
  }
  if (lossChart) {
    lossChart.data.datasets[0].data = series("drop_rate", 100);
    lossChart.update("none");
  }
  renderOutages(history, start, end);
}

function renderOutages(history, start, end) {
  const events = Array.isArray(history && history.outages) ? history.outages : [];
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const validEvents = events.filter((event) =>
    event && typeof event.reason === "string" && typeof event.source === "string" &&
    Number.isFinite(Date.parse(event.first_observed_at)) &&
    Number.isFinite(Date.parse(event.last_confirmed_at)));
  const confirmedInWindow = validWindow ? validEvents.filter((event) =>
    Date.parse(event.last_confirmed_at) >= start && Date.parse(event.first_observed_at) <= end) : [];
  byId("outage-track").innerHTML = confirmedInWindow.map((event) => {
    const first = Date.parse(event.first_observed_at);
    const last = Date.parse(event.last_confirmed_at);
    const left = Math.max(0, Math.min(100, (first - start) / (end - start) * 100));
    const right = Math.max(left, Math.min(100, (last - start) / (end - start) * 100));
    return `<span class="outage-segment" style="left:${left}%;width:${right - left}%" ` +
      `title="${escapeHtml(event.reason)}"></span>`;
  }).join("");
  byId("outage-list").innerHTML = validEvents.map((event) => {
    const first = new Date(event.first_observed_at).toLocaleString();
    const last = new Date(event.last_confirmed_at).toLocaleString();
    const closure = event.end_state === "recovered" && Number.isFinite(Date.parse(event.recovery_observed_at))
      ? `Recovery observed ${new Date(event.recovery_observed_at).toLocaleString()}`
      : event.end_state === "open" ? "Still reported offline at last reading; end unknown"
        : "Collection stopped or changed; end unknown";
    return `<div class="outage-event">Dish reported ${escapeHtml(event.reason)} · ` +
      `First observed ${first} · Last confirmed ${last} · ${closure} · ${escapeHtml(event.source)}</div>`;
  }).join("") || "No dish-reported outages in this window";
}

async function updateHistory(force = false) {
  const requestedRange = historyRange;
  const now = Date.now();
  if (!force && lastHistoryFetchRange === requestedRange &&
      now - lastHistoryFetchMs < HISTORY_REFRESH_MS[requestedRange]) return;
  lastHistoryFetchRange = requestedRange;
  lastHistoryFetchMs = now;
  try {
    const response = await fetch(`${API_URL}/api/history?range=${requestedRange}`);
    if (!response.ok) throw new Error(`History API: HTTP ${response.status}`);
    const history = await response.json();
    if (requestedRange === historyRange) renderHistory(history);
  } catch (error) {
    if (requestedRange === historyRange) {
      lastHistoryFetchMs = 0;
      const label = HISTORY_RANGE_LABELS[requestedRange];
      for (const id of ["history-window", "quality-window", "outage-window"]) {
        byId(id).textContent = `${label} history unavailable`;
      }
      byId("history-time-note").textContent = "Retrying collection history";
      byId("outage-list").textContent = "Outage history unavailable";
    }
    console.error("History fetch failed:", error);
  }
}

function showHistoryLoading(range) {
  const label = HISTORY_RANGE_LABELS[range];
  for (const id of ["history-window", "quality-window", "outage-window"]) {
    byId(id).textContent = `Loading ${label} history…`;
  }
  byId("history-time-note").textContent = "Loading observed samples and gaps";
  byId("outage-track").innerHTML = "";
  byId("outage-list").textContent = "Loading dish-reported outages";
  for (const chart of [speedChart, latencyChart, lossChart]) {
    if (!chart) continue;
    for (const dataset of chart.data.datasets) dataset.data = [];
    chart.update("none");
  }
}

function setHistoryRange(range) {
  if (!(range in HISTORY_REFRESH_MS)) return;
  historyRange = range;
  document.querySelectorAll(".history-range-btn").forEach((button) => {
    const active = button.dataset.range === range;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  showHistoryLoading(range);
  return updateHistory(true);
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
  await updateHistory();
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
  document.querySelectorAll(".history-range-btn").forEach((button) =>
    button.addEventListener("click", () => setHistoryRange(button.dataset.range)));
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
