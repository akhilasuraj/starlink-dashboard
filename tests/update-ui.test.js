const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../renderer/updates.js"), "utf8");
const initial = { supported: true, currentVersion: "1.3.0", phase: "idle", availableVersion: null,
  percent: null, message: "Updates are checked automatically." };

function ui() {
  const elements = new Map(), calls = [], intervals = [];
  let ready, state = { ...initial };
  const bridge = {};
  for (const action of ["getState", "check", "download", "install"]) bridge[action] = async () => { calls.push(action); return state; };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, hidden: false, value: 0,
        listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
        click() { if (!this.disabled) return this.listeners.click?.(); },
        set innerHTML(_value) { assert.fail("Update state must be rendered as text"); } });
      return elements.get(id);
    },
    addEventListener(_event, callback) { ready = callback; },
  };
  const context = vm.createContext({ document, window: { desktopUpdates: bridge },
    setInterval: (callback) => intervals.push(callback), console });
  vm.runInContext(source, context);
  return { elements, calls, intervals, bridge, context, set: (next) => { state = next; },
    async ready() { ready(); await Promise.resolve(); await Promise.resolve(); },
    render: (next) => context.renderUpdateState(next), element: (id) => document.getElementById(id) };
}

test("update UI exposes download then restart, with progress and no automatic install", async () => {
  const app = ui(); await app.ready();
  assert.equal(app.element("app-version").textContent, "Version 1.3.0");
  assert.equal(app.element("update-notice").hidden, true);
  app.set({ ...initial, phase: "available", availableVersion: "1.4.0", message: "Version 1.4.0 is available." });
  await app.element("update-check").click();
  assert.equal(app.element("update-action").textContent, "Download update");
  assert.equal(app.element("update-notice").hidden, false);
  app.render({ ...initial, phase: "downloading", percent: 42, message: "Downloading — 42%." });
  assert.equal(app.element("update-progress").value, 42);
  assert.equal(app.element("update-progress").hidden, false);
  assert.equal(app.element("update-check").disabled, true);
  app.set({ ...initial, phase: "downloaded", message: "Restart when ready." });
  await app.intervals[0]();
  assert.equal(app.element("update-action").textContent, "Restart and install");
  assert.equal(app.element("update-check").disabled, true);
  assert.equal(app.calls.includes("install"), false);
  app.set({ ...initial, phase: "installing", message: "Stopping monitoring…" });
  await app.element("update-notice-action").click();
  assert.equal(app.calls.filter(action => action === "install").length, 1);
  assert.equal(app.element("update-action").hidden, true);
});

test("unsupported development and IPC failure do not offer installation or expose raw errors", async () => {
  const app = ui(); await app.ready();
  app.render({ ...initial, supported: false, phase: "unsupported", message: "Installed app only." });
  assert.equal(app.element("update-check").disabled, true);
  assert.equal(app.element("update-policy").hidden, true);
  assert.equal(app.element("update-action").hidden, true);
  app.render(initial);
  app.bridge.check = async () => { throw new Error("private filesystem path should not appear"); };
  await app.element("update-check").click();
  assert.equal(app.element("update-message").textContent, "Could not request the update. Try again.");
  assert.equal(app.element("update-check").disabled, false);
  assert.equal(app.element("update-notice").hidden, true);
});
