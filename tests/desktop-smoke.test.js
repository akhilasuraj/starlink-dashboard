const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const appSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");
const htmlIds = new Set([...htmlSource.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const observedAt = "2026-09-27T12:00:00Z";
const reading = (value, availability = "available") => ({
  value,
  availability,
  unit: "Mbps",
  source: "starlink-grpc-core.status_data",
  observed_at: observedAt,
});
const python = process.env.PYTHON || (
  process.platform === "win32" && fs.existsSync(path.join(__dirname, "..", ".venv", "Scripts", "python.exe"))
    ? path.join(__dirname, "..", ".venv", "Scripts", "python.exe")
    : "python"
);

function apiStatus(scenario) {
  const result = spawnSync(python, ["-m", "backend.tests.fixture_status_api", scenario], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `Fixture API failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

function apiHistory(scenario, range = "15m") {
  const result = spawnSync(python, ["-m", "backend.tests.fixture_status_api", scenario, "history", range], {
    cwd: path.join(__dirname, ".."), encoding: "utf8",
  });
  assert.equal(result.status, 0, `Fixture history API failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

function desktop(response, history = { samples: [] }, withCharts = false, domReady = false, settingsBridge = null) {
  const elements = new Map();
  const charts = [];
  const requests = [];
  const rangeButtons = ["15m", "24h", "7d"].map((range) => ({
    dataset: { range },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(_event, callback) { this.onClick = callback; },
    click() { return this.onClick(); },
  }));
  let onReady;
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) {
        const element = { textContent: "", style: {}, hidden: false, title: "", htmlWrites: 0,
          checked: false, disabled: false, listeners: {}, getContext() { return {}; },
          addEventListener(name, callback) { this.listeners[name] = callback; } };
        let html = "";
        Object.defineProperty(element, "innerHTML", {
          get() { return html; },
          set(value) { html = value; element.htmlWrites += 1; },
        });
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener(name, callback) { if (name === "DOMContentLoaded") onReady = callback; },
    querySelectorAll(selector) { return selector === ".history-range-btn" ? rangeButtons : []; },
    createElement() {
      return {
        innerHTML: "",
        set textContent(value) {
          this.innerHTML = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
        },
      };
    },
  };
  const context = vm.createContext({
    document,
    window: { desktopSettings: settingsBridge, desktopAPI: {
      getStatus: async () => { requests.push("/api/status"); return response; },
      getHistory: async (range) => { requests.push(`/api/history?range=${range}`);
        return history.byRange ? history.byRange[range] : history; },
      getLogs: async () => ({ logs: [] }),
      clearLogs: async () => ({ status: "ok" }),
    } },
    console: { error() {} },
    Chart: withCharts ? class {
      constructor(_context, configuration) {
        this.data = configuration.data;
        this.options = configuration.options;
        charts.push(this);
      }
      update() {}
    } : undefined,
    setInterval() {},
    Date,
  });
  vm.runInContext(appSource, context);
  if (domReady) onReady();
  else if (withCharts) vm.runInContext("initChart()", context);
  return {
    async render() { await vm.runInContext("updateData()", context); },
    text(id) { return document.getElementById(id).textContent; },
    title(id) { return document.getElementById(id).title; },
    html(id) { return document.getElementById(id).innerHTML; },
    htmlWrites(id) { return document.getElementById(id).htmlWrites; },
    hidden(id) { return document.getElementById(id).hidden; },
    checked(id) { return document.getElementById(id).checked; },
    disabled(id) { return document.getElementById(id).disabled; },
    async initializeSettings() { await vm.runInContext("setupStartupSetting()", context); },
    async changeStartup(enabled) {
      const checkbox = document.getElementById("start-on-login");
      checkbox.checked = enabled;
      await checkbox.listeners.change();
    },
    charts,
    requests,
    setStatus(nextStatus) { response = nextStatus; },
    async clickRange(range) { await rangeButtons.find((button) => button.dataset.range === range).click(); },
    rangePressed(range) { return rangeButtons.find((button) => button.dataset.range === range).attrs["aria-pressed"]; },
  };
}

function status(collectionState, serviceState, metrics = {}) {
  return {
    collection_state: collectionState,
    service_state: serviceState,
    observed_at: observedAt,
    source: "fixture-status-api",
    stale: collectionState === "stale",
    guidance: collectionState === "dish_unreachable"
      ? "With bypass mode or a third-party router, add a route to 192.168.100.1."
      : null,
    metrics,
    device: {},
  };
}

test("idle but connected displays service online and a real zero traffic reading", async () => {
  const app = desktop(apiStatus("online-idle"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.equal(app.text("download"), "0.0");
  assert.match(app.text("download-meta"), /starlink-grpc-core\.status_data/);
});

test("reported impairment can recover to healthy idle service without reopening the window", async () => {
  const app = desktop(apiStatus("service-impaired"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE IMPAIRED");
  assert.equal(app.text("drop-rate"), "10.0");
  app.setStatus(apiStatus("dish-unreachable"));
  await app.render();
  assert.equal(app.text("status"), "DISH UNREACHABLE");
  app.setStatus(apiStatus("online-idle"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.equal(app.text("download"), "0.0");
});

test("start-on-sign-in control is opt-in and can be turned off through the desktop bridge", async () => {
  const changes = [];
  const app = desktop(apiStatus("online-idle"), { samples: [] }, false, false, {
    getStartOnLogin: async () => ({ supported: true, enabled: false }),
    setStartOnLogin: async (enabled) => { changes.push(enabled); return { supported: true, enabled }; },
  });
  await app.initializeSettings();
  assert.equal(app.checked("start-on-login"), false);
  assert.equal(app.disabled("start-on-login"), false);
  assert.equal(changes.length, 0);
  await app.changeStartup(true);
  assert.equal(app.checked("start-on-login"), true);
  assert.match(app.text("start-on-login-status"), /Starts in the tray/);
  await app.changeStartup(false);
  assert.equal(app.checked("start-on-login"), false);
  assert.deepEqual(changes, [true, false]);
});

test("dish reported offline is separate from a reachable collector", async () => {
  const app = desktop(apiStatus("service-offline"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE OFFLINE");
  assert.match(app.text("collection-state"), /Collection: reachable · Service: offline/);
});

test("unreachable dish shows route guidance and unavailable fields", async () => {
  const app = desktop(apiStatus("dish-unreachable"));
  await app.render();
  assert.equal(app.text("status"), "DISH UNREACHABLE");
  assert.match(app.text("guidance"), /third-party router/);
  assert.equal(app.hidden("guidance"), false);
  assert.equal(app.text("download"), "Unavailable");
});

test("stale readings retain provenance and absent alignment stays unavailable", async () => {
  const app = desktop(apiStatus("stale"));
  await app.render();
  assert.equal(app.text("status"), "DATA STALE");
  assert.match(app.text("download-meta"), /^Stale/);
  assert.equal(app.text("latency"), "38");
  assert.match(app.text("latency-meta"), /^Stale/);
  assert.equal(app.text("azimuth"), "Unavailable");
});

test("readings with missing source or observation time are unavailable", async () => {
  const response = status("reachable", "online", {
    download_mbps: { ...reading(5), source: null },
    upload_mbps: { ...reading(6), observed_at: null },
    latency_ms: { ...reading(23), observed_at: "yesterday" },
    drop_rate: { ...reading(0.1), availability: "mystery" },
  });
  response.device = {
    hardware: { value: "rev4", availability: "available", source: null, observed_at: observedAt },
    software: { value: "firmware", availability: "available", source: "dish", observed_at: null },
  };
  const app = desktop(response);
  await app.render();
  assert.equal(app.text("download"), "Unavailable");
  assert.equal(app.text("upload"), "Unavailable");
  assert.equal(app.text("latency"), "Unavailable");
  assert.equal(app.text("drop-rate"), "Unavailable");
  assert.equal(app.text("hardware"), "Unavailable");
  assert.equal(app.text("software"), "Unavailable");
});

test("headline uses the API's source instead of a renderer constant", async () => {
  const app = desktop(status("reachable", "online"));
  await app.render();
  assert.match(app.text("observed-at"), /Source: fixture-status-api/);
});

test("15-minute traffic, latency, and loss charts consume the persisted history API", async () => {
  const history = apiHistory("history-quality");
  const app = desktop(apiStatus("history-quality"), history, true);
  await app.render();
  assert.match(app.text("history-window"), /15-minute window · Observed/);
  assert.match(app.text("history-time-note"), /estimated from the local poll time/);
  assert.equal(app.text("ping-success"), "78.0");
  assert.match(app.text("ping-success-meta"), /15-minute window · 5 observed samples/);
  assert.match(app.text("ping-success-meta"), /Uncollected time excluded/);
  assert.match(htmlSource, /Observed ping success/);
  assert.equal(app.charts.length, 3);
  const [traffic, latency, loss] = app.charts;
  assert.equal(traffic.data.datasets[0].label, "Current download traffic (Mbps)");
  assert.equal(traffic.data.datasets[1].label, "Current upload traffic (Mbps)");
  assert.equal(traffic.options.scales.y.title.text, "Mbps");
  assert.equal(latency.data.datasets[0].label, "Latency (ms)");
  assert.equal(latency.options.scales.y.title.text, "ms");
  assert.equal(loss.data.datasets[0].label, "Ping drop rate (%)");
  assert.equal(loss.options.scales.y.title.text, "%");
  assert.match(htmlSource, /id="traffic-explainer"[^>]*>Dish traffic is current usage, not a speed test or available capacity\./);
  assert.equal(traffic.options.scales.x.max - traffic.options.scales.x.min, 900_000);
  assert.ok(traffic.data.datasets[0].data.some((point) => point.y === 0));
  assert.ok(traffic.data.datasets[0].data.some((point) => point.y === null));
  assert.ok(latency.data.datasets[0].data.some((point) => point.y === null));
  assert.ok(loss.data.datasets[0].data.some((point) => point.y === 100));
  assert.match(traffic.data.datasets[0].data.find((point) => point.y === 0).meta, /Estimated sample time/);
});

test("observed ping success distinguishes no measurements from real zero and hundred percent", async () => {
  for (const [scenario, expected] of [["ping-unavailable", "--"], ["online-idle", "100.0"], ["ping-total-loss", "0.0"]]) {
    const app = desktop(apiStatus(scenario), apiHistory(scenario));
    await app.render();
    assert.equal(app.text("ping-success"), expected);
    assert.match(app.text("ping-success-meta"), /15-minute window/);
    assert.match(app.text("ping-success-meta"), expected === "--" ? /No valid ping observations · Unavailable/ : /1 observed samples/);
  }
});

test("dish-reported outage reason and recovery appear on the same 15-minute timeline", async () => {
  const history = apiHistory("reported-outage");
  assert.equal(history.outages.length, 1);
  const app = desktop(apiStatus("reported-outage"), history, true);
  await app.render();
  assert.match(app.text("outage-window"), /15-minute window/);
  assert.match(app.html("outage-list"), /NO_PINGS/);
  assert.match(app.html("outage-list"), /Recovery observed/);
  assert.match(app.html("outage-track"), /outage-segment/);
  const width = Number(app.html("outage-track").match(/width:([\d.]+)%/)[1]);
  assert.ok(Math.abs(width - 2 / 900 * 100) < 0.001);
  assert.match(htmlSource, /id="outage-note"[^>]*>Blank time and collector gaps are not confirmed outages/i);
});

test("one offline observation remains a marker without painting time until recovery", async () => {
  const history = apiHistory("outage-boundary");
  const app = desktop(apiStatus("outage-boundary"), history, true);
  await app.render();
  assert.equal(history.outages[0].last_confirmed_at, history.outages[0].first_observed_at);
  assert.notEqual(history.outages[0].recovery_observed_at, history.outages[0].last_confirmed_at);
  assert.match(app.html("outage-track"), /width:0%/);
  assert.match(cssSource, /\.outage-segment\s*\{[^}]*min-width:\s*3px/s);
  assert.match(app.html("outage-list"), /Recovery observed/);
});

test("recovery in window does not paint an earlier confirmed outage at the window edge", async () => {
  const history = apiHistory("outage-recovery-in-window");
  assert.equal(history.outages.length, 1);
  assert.ok(Date.parse(history.outages[0].last_confirmed_at) < Date.parse(history.window_start));
  const app = desktop(apiStatus("outage-recovery-in-window"), history, true);
  await app.render();
  assert.equal(app.html("outage-track"), "");
  assert.match(app.html("outage-list"), /Recovery observed/);
});

test("range selector switches charts and outage window without replacing the live status", async () => {
  const histories = {
    byRange: {
      "15m": apiHistory("range-views", "15m"),
      "24h": apiHistory("range-views", "24h"),
      "7d": apiHistory("range-views", "7d"),
    },
  };
  const app = desktop(apiStatus("range-views"), histories, true, true);
  await app.render();
  await app.clickRange("15m");
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.match(app.text("history-window"), /15-minute window/);
  await app.clickRange("24h");
  assert.match(app.text("history-window"), /24-hour window/);
  assert.match(app.text("ping-success-meta"), /24-hour window · 2 observed samples/);
  assert.equal(app.text("ping-success"), "100.0");
  assert.equal(app.rangePressed("24h"), "true");
  assert.equal(app.charts[0].options.scales.x.max - app.charts[0].options.scales.x.min, 86400_000);
  assert.equal(app.charts[0].data.datasets[0].showLine, false);
  assert.match(app.charts[0].data.datasets[0].data.find((point) => point.y !== null).meta, /observed samples/i);
  assert.equal(app.text("status"), "SERVICE ONLINE");
  await app.clickRange("7d");
  assert.match(app.text("quality-window"), /7-day window/);
  assert.equal(app.charts[0].options.scales.x.max - app.charts[0].options.scales.x.min, 604800_000);
  assert.match(app.html("outage-list"), /NO_PINGS/);
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.ok(app.requests.some((url) => url.endsWith("/api/history?range=7d")));
  const weekFetches = app.requests.filter((url) => url.endsWith("/api/history?range=7d")).length;
  app.setStatus(apiStatus("service-offline"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE OFFLINE");
  assert.equal(app.requests.filter((url) => url.endsWith("/api/history?range=7d")).length, weekFetches);
});

test("switching to a slow 7-day view clears the old chart and labels while it loads", async () => {
  let finishWeek;
  const pendingWeek = new Promise((resolve) => { finishWeek = resolve; });
  const histories = { byRange: {
    "15m": apiHistory("range-views", "15m"),
    "7d": pendingWeek,
  } };
  const app = desktop(apiStatus("range-views"), histories, true, true);
  await app.clickRange("15m");
  assert.match(app.text("history-window"), /15-minute window/);
  assert.ok(app.charts[0].data.datasets[0].data.length > 0);
  const switching = app.clickRange("7d");
  assert.equal(app.rangePressed("7d"), "true");
  assert.match(app.text("history-window"), /Loading 7-day history/);
  assert.equal(app.text("ping-success"), "--");
  assert.match(app.text("ping-success-meta"), /Loading 7-day/);
  assert.equal(app.charts[0].data.datasets[0].data.length, 0);
  assert.equal(app.html("outage-track"), "");
  finishWeek(apiHistory("range-views", "7d"));
  await switching;
  assert.match(app.text("history-window"), /7-day window/);
});

test("device view shows official dish and optional router details with reported alerts", async () => {
  const app = desktop(apiStatus("device-details"));
  await app.render();
  assert.equal(app.text("hardware"), "rev-official");
  assert.match(app.title("hardware"), /SpaceX Device API GetDiagnostics/);
  assert.equal(app.text("router-id"), "Router-fixture");
  assert.equal(app.text("router-hardware"), "router-rev");
  assert.equal(app.text("router-software"), "router-firmware");
  assert.match(app.text("dish-alerts"), /slow ethernet speeds/i);
  assert.match(app.text("device-capabilities"), /Router diagnostics: available/);
  assert.match(htmlSource, /GPS reception · satellites/);
});

test("missing router and alert observations are unavailable while dish stays online", async () => {
  const app = desktop(apiStatus("router-unavailable"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.equal(app.text("hardware"), "rev-official");
  assert.equal(app.text("router-id"), "Unavailable");
  assert.equal(app.text("dish-alerts"), "Dish alerts unavailable");
  assert.equal(app.text("gps-sats"), "Unavailable");
  assert.match(app.text("device-capabilities"), /Router diagnostics: unavailable/);
});

test("old diagnostics stay visible as stale after router and dish checks fail", async () => {
  const app = desktop(apiStatus("stale-diagnostics"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.equal(app.text("router-id"), "Router-fixture");
  assert.match(app.title("router-id"), /^Stale/);
  assert.match(app.text("device-capabilities"), /Dish diagnostics: stale/);
  assert.match(app.text("device-capabilities"), /Router diagnostics: stale/);
  assert.match(app.text("device-capabilities"), /Dish alerts: stale/);
  assert.match(app.text("dish-alerts-meta"), /^Stale/);
});

test("all-false community alert defaults do not appear as a confirmed clear state", async () => {
  const app = desktop(apiStatus("community-alerts-all-clear"));
  await app.render();
  assert.equal(app.text("dish-alerts"), "Dish alerts unavailable");
  assert.match(app.text("device-capabilities"), /Dish alerts: unavailable/);
});

test("obstruction view distinguishes reported fraction from directional SNR samples", async () => {
  const response = apiStatus("obstruction-supported");
  const app = desktop(response);
  await app.render();
  assert.match(htmlSource, /data-tab="obstruction"/);
  assert.equal(app.text("obstruction-text"), "Obstructed area reported: 12.50%");
  assert.match(app.text("obstruction-meta"), /starlink-grpc-core\.status_data/);
  assert.equal(app.text("obstruction-current"), "Currently obstructed: No");
  assert.match(app.text("obstruction-current-meta"), /starlink-grpc-core\.status_data/);
  assert.match(app.text("obstruction-snr-meta"), /starlink-grpc-core\.obstruction_map/);
  assert.match(app.text("obstruction-snr-meta"), /5 of 6 valid/);
  assert.equal((app.html("obstruction-snr-grid").match(/class="snr-cell/g) || []).length, 6);
  assert.match(app.html("obstruction-snr-grid"), /snr-cell invalid/);
  const gridWrites = app.htmlWrites("obstruction-snr-grid");
  await app.render();
  assert.equal(app.htmlWrites("obstruction-snr-grid"), gridWrites);
  assert.match(htmlSource, /Directional SNR samples.*not an exact obstruction outline/i);
  assert.doesNotMatch(htmlSource, /camera scan|serving.satellite count/i);
});

test("unsupported obstruction telemetry shows an explanation without a fabricated map", async () => {
  const app = desktop(apiStatus("obstruction-unsupported"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.equal(app.text("obstruction-text"), "Obstruction: Unavailable");
  assert.equal(app.text("obstruction-current"), "Currently obstructed: Unavailable");
  assert.equal(app.hidden("obstruction-progress"), true);
  assert.match(app.text("obstruction-snr-meta"), /not reported by this dish or firmware/i);
  assert.equal(app.html("obstruction-snr-grid"), "");
});

test("protobuf obstruction defaults show unavailable while an observed zero remains visible", async () => {
  const app = desktop(apiStatus("obstruction-status-defaults"));
  await app.render();
  assert.equal(app.text("obstruction-text"), "Obstruction: Unavailable");
  assert.equal(app.text("obstruction-current"), "Currently obstructed: Unavailable");
  assert.equal(app.hidden("obstruction-progress"), true);
  app.setStatus(apiStatus("obstruction-observed-zero"));
  await app.render();
  assert.equal(app.text("obstruction-text"), "Obstructed area reported: 0.00%");
  assert.equal(app.text("obstruction-current"), "Currently obstructed: No");
  assert.equal(app.hidden("obstruction-progress"), false);
});

test("reported grid with no valid SNR cells explains the invalid samples without drawing a map", async () => {
  const response = apiStatus("obstruction-no-valid-samples");
  assert.equal(response.obstruction.signal_map.reason, "no_valid_samples");
  const app = desktop(response);
  await app.render();
  assert.match(app.text("obstruction-snr-meta"), /no valid SNR samples/i);
  assert.match(app.text("obstruction-snr-meta"), /starlink-grpc-core\.obstruction_map/);
  assert.doesNotMatch(app.text("obstruction-snr-meta"), /not reported by this dish or firmware/i);
  assert.equal(app.html("obstruction-snr-grid"), "");
});

test("the obstruction view labels old directional samples stale while status remains live", async () => {
  const app = desktop(apiStatus("obstruction-stale"));
  await app.render();
  assert.equal(app.text("status"), "SERVICE ONLINE");
  assert.match(app.text("obstruction-snr-meta"), /^Stale · /);
  assert.match(app.text("obstruction-snr-meta"), /5 of 6 valid/);
  assert.match(app.text("obstruction-meta"), /starlink-grpc-core\.status_data/);
});
