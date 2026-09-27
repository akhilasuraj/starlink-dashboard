const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const appSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
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

function desktop(response) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) {
        elements.set(id, { textContent: "", style: {}, hidden: false, title: "" });
      }
      return elements.get(id);
    },
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement() { return { textContent: "", innerHTML: "" }; },
  };
  const context = vm.createContext({
    document,
    console: { error() {} },
    fetch: async (url) => ({
      ok: true,
      json: async () => url.endsWith("/api/status") ? response : { samples: [] },
    }),
    setInterval() {},
    Date,
  });
  vm.runInContext(appSource, context);
  return {
    async render() { await vm.runInContext("updateData()", context); },
    text(id) { return document.getElementById(id).textContent; },
    hidden(id) { return document.getElementById(id).hidden; },
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
