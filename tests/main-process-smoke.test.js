const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
const python = process.env.PYTHON || path.join(root, ".venv", "Scripts", "python.exe");

function apiStatus(scenario) {
  const result = spawnSync(python, ["-m", "backend.tests.fixture_status_api", scenario],
    { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function desktopMain(response, { lock = true, hidden = false, legacyStartup = false } = {}) {
  const windows = [], trays = [], children = [], intervals = new Map(), timeouts = new Map();
  const handlers = new Map(), loginChanges = [], loginQueries = [], requests = [];
  let timerId = 0, fetchError = null;
  const executable = "C:\\App\\Starlink Dashboard.exe";
  const loginRegistry = new Map(legacyStartup ? [["StarlinkDashboard", `"${executable}" --hidden`]] : []);
  const program = (command) => /^"([^"]+)"/.exec(command)?.[1] || command.split(" ")[0];
  const commandLine = (options) => `${options.path}${options.args.length ? ` ${options.args.join(" ")}` : ""}`;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, quitCount: 0, appId: "electron.test-default",
    setAppUserModelId(value) { this.appId = value; },
    requestSingleInstanceLock: () => lock,
    whenReady: () => Promise.resolve(),
    getLoginItemSettings(options) {
      loginQueries.push(options);
      // Electron 28 reads openAtLogin under the AppUserModelID, regardless of
      // the custom name used by setLoginItemSettings, and compares raw commands.
      const launchItems = [...loginRegistry].filter(([, command]) =>
        program(command) === program(options.path)).map(([name, command]) => ({
          name, path: program(command), args: command.endsWith(" --hidden") ? ["--hidden"] : [],
          enabled: true, scope: "user",
        }));
      return { openAtLogin: loginRegistry.get(this.appId) === commandLine(options),
        executableWillLaunchAtLogin: launchItems.length > 0, launchItems };
    },
    setLoginItemSettings(options) {
      loginChanges.push(options);
      const name = options.name || this.appId;
      if (options.openAtLogin) loginRegistry.set(name, commandLine(options));
      else loginRegistry.delete(name);
    },
    quit() {
      let prevented = false;
      app.emit("before-quit", { preventDefault() { prevented = true; } });
      if (!prevented) { app.quitCount += 1; app.emit("will-quit", { preventDefault() {} }); }
    },
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.visible = options.show !== false; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler() {}, executeJavaScript: async () => {} });
      windows.push(this);
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    restore() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
  }
  class Tray extends EventEmitter {
    constructor(image) { super(); this.image = image; trays.push(this); }
    setImage(image) { this.image = image; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, { platform: "win32", execPath: executable,
    resourcesPath: "C:\\App\\resources", argv: hidden ? ["app", "--hidden"] : ["app"], env: {} });
  class ClockDate extends Date { static now() { return Date.parse("2026-09-27T12:00:00Z"); } }
  const context = vm.createContext({
    __dirname: root, process: fakeProcess, console: { log() {}, error() {} }, Date: ClockDate,
    AbortSignal, Buffer,
    require(name) {
      if (name === "electron") return { app, BrowserWindow: Window, Tray,
        Menu: { buildFromTemplate: (items) => items },
        ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
        nativeImage: { createFromPath: (file) => file, createEmpty: () => "empty",
          createFromDataURL: () => "canvas-image" } };
      if (name === "child_process") return { spawn(command, args, options) {
        const child = new EventEmitter();
        Object.assign(child, { command, args, options, pid: 100 + children.length,
          stdout: new EventEmitter(), stderr: new EventEmitter(), killCount: 0, signals: [], closeOnKill: true,
          kill(signal) { this.killCount += 1; this.signals.push(signal);
            if (this.closeOnKill) this.emit("close", 0); return true; } });
        children.push(child); return child;
      } };
      return require(name);
    },
    fetch: async (url, options) => { requests.push({ url, options });
      if (fetchError) throw fetchError; return { ok: true, json: async () => response }; },
    setInterval(callback, delay) { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  });
  vm.runInContext(source, context);
  return {
    app, windows, trays, children, intervals, timeouts, loginChanges, loginQueries, loginRegistry, requests,
    async ready() {
      await Promise.resolve(); await Promise.resolve();
      children.at(-1)?.stdout.emit("data", Buffer.from('{"event":"collector-listening","port":49152}\n'));
      for (const [id, timer] of [...timeouts]) if (timer.delay === 2000) { timeouts.delete(id); await timer.callback(); }
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    },
    async poll(nextResponse = response) {
      response = nextResponse;
      for (const timer of intervals.values()) await timer.callback();
    },
    failFetch() { fetchError = new Error("collector disconnected"); },
    recoverFetch() { fetchError = null; },
    async runTimeouts() {
      for (const [id, timer] of [...timeouts]) { timeouts.delete(id); await timer.callback(); }
      children.at(-1)?.stdout.emit("data", Buffer.from('{"event":"collector-listening","port":49153}\n'));
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    },
    async ipc(channel, value) {
      assert.ok(handlers.has(channel), `Missing ${channel} bridge`);
      return handlers.get(channel)({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame }, value);
    },
    async foreignIpc(channel, subframe = false) {
      return handlers.get(channel)({ sender: subframe ? windows.at(-1).webContents : {}, senderFrame: {} });
    },
  };
}

test("tray follows observed health and recovery without spawning another collector or status loop", async () => {
  const desktop = desktopMain(apiStatus("online-idle"));
  await desktop.ready();
  const icons = [];
  for (const [scenario, label] of [
    ["online-idle", "Service online"], ["service-impaired", "Service impaired"],
    ["service-offline", "Service offline"], ["dish-unreachable", "Dish unreachable"],
    ["stale", "Data stale"], ["online-idle", "Service online"],
  ]) {
    await desktop.poll(apiStatus(scenario));
    assert.match(desktop.trays[0].tooltip, new RegExp(label));
    const png = fs.readFileSync(desktop.trays[0].image);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 16);
    assert.equal(png.readUInt32BE(20), 16);
    icons.push(desktop.trays[0].image);
  }
  assert.equal(new Set(icons.slice(0, 5)).size, 5);
  desktop.windows[0].close();
  assert.equal(desktop.windows[0].visible, false);
  desktop.app.emit("second-instance");
  assert.equal(desktop.windows.length, 1);
  desktop.trays[0].emit("click");
  assert.equal(desktop.windows[0].visible, true);
  desktop.windows[0].destroy();
  desktop.trays[0].emit("click");
  assert.equal(desktop.windows.length, 2);
  assert.equal(desktop.children.length, 1);
  assert.equal(desktop.intervals.size, 1);
});

test("desktop reads through a constrained private collector session", async () => {
  const response = apiStatus("online-idle");
  const desktop = desktopMain(response);
  await desktop.ready();
  assert.deepEqual(await desktop.ipc("collector:status"), response);
  await assert.rejects(desktop.ipc("collector:history", "all-time"), /range/i);
  assert.equal(desktop.children[0].command, path.join("C:\\App\\resources", "collector", "starlink-collector.exe"));
  assert.match(desktop.children[0].options.env.STARLINK_DASHBOARD_SESSION_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(desktop.children[0].options.env.PYTHONPATH, undefined);
  const request = desktop.requests.at(-1);
  assert.equal(request.url, "http://127.0.0.1:49152/api/status");
  assert.equal(request.options.headers.Authorization,
    `Bearer ${desktop.children[0].options.env.STARLINK_DASHBOARD_SESSION_TOKEN}`);
  await assert.rejects(desktop.foreignIpc("collector:status"), /window or frame/);
  await assert.rejects(desktop.foreignIpc("collector:status", true), /window or frame/);
});

test("hidden sign-in launch monitors from the tray and collector exit retries once", async () => {
  const desktop = desktopMain(apiStatus("online-idle"), { hidden: true });
  await desktop.ready();
  assert.equal(desktop.windows.length, 1);
  assert.equal(desktop.windows[0].visible, false);
  assert.equal(desktop.intervals.size, 1);
  desktop.failFetch(); await desktop.poll();
  assert.match(desktop.trays[0].tooltip, /Collector unavailable/);
  desktop.children[0].emit("close", 1);
  assert.equal(desktop.timeouts.size, 1);
  await desktop.runTimeouts();
  assert.equal(desktop.children.length, 2);
  desktop.recoverFetch(); await desktop.poll(apiStatus("online-idle"));
  assert.match(desktop.trays[0].tooltip, /Service online/);
  desktop.trays[0].emit("click");
  assert.equal(desktop.windows.length, 1);
  assert.equal(desktop.windows[0].visible, true);
});

test("spawn error followed by close schedules one retry and live-child errors do not spawn duplicates", async () => {
  const desktop = desktopMain(apiStatus("online-idle"));
  await desktop.ready();
  desktop.children[0].emit("error", new Error("child communication error"));
  assert.equal(desktop.timeouts.size, 0);
  desktop.children[0].pid = undefined;
  desktop.children[0].emit("error", new Error("spawn failed"));
  desktop.children[0].emit("close", 1);
  assert.equal(desktop.timeouts.size, 1);
  await desktop.runTimeouts();
  assert.equal(desktop.children.length, 2);
});

test("quit waits for collector close and escalates a slow SIGTERM without restarting", async () => {
  const desktop = desktopMain(apiStatus("online-idle"));
  await desktop.ready();
  const child = desktop.children[0];
  child.closeOnKill = false;
  desktop.app.quit();
  assert.equal(desktop.app.quitCount, 0);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await desktop.runTimeouts();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", 0);
  assert.equal(desktop.app.quitCount, 1);
  assert.equal(desktop.timeouts.size, 0);
  assert.equal(desktop.children.length, 1);
});

test("hidden Windows session end stops collection without scheduling a restart", async () => {
  const desktop = desktopMain(apiStatus("online-idle"), { hidden: true });
  await desktop.ready();
  desktop.windows[0].emit("session-end");
  assert.equal(desktop.children[0].killCount, 1);
  assert.equal(desktop.intervals.size, 0);
  assert.equal(desktop.timeouts.size, 0);
});

test("a second desktop process quits before starting a collector", async () => {
  const desktop = desktopMain(apiStatus("online-idle"), { lock: false });
  await desktop.ready();
  assert.equal(desktop.app.quitCount, 1);
  assert.equal(desktop.children.length, 0);
  assert.equal(desktop.trays.length, 0);
});

test("start-on-sign-in is untouched until selected, can be disabled, and quit cleans up", async () => {
  const desktop = desktopMain(apiStatus("online-idle"));
  await desktop.ready();
  assert.equal(desktop.loginChanges.length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8"),
    /WriteRegStr[^\n]*CurrentVersion\\Run/);
  assert.equal((await desktop.ipc("startup:get")).enabled, false);
  assert.equal((await desktop.ipc("startup:set", true)).enabled, true);
  assert.equal(desktop.app.appId, "com.starlink.dashboard");
  assert.equal(desktop.app.appId, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.appId);
  assert.equal(desktop.loginRegistry.get("com.starlink.dashboard"), '"C:\\App\\Starlink Dashboard.exe" --hidden');
  assert.equal((await desktop.ipc("startup:set", false)).enabled, false);
  const enabledWrite = desktop.loginChanges.find((setting) => setting.openAtLogin);
  assert.equal(enabledWrite.args[0], "--hidden");
  assert.equal(desktop.loginQueries.at(-1).path, enabledWrite.path);
  assert.deepEqual(Array.from(desktop.loginQueries.at(-1).args), Array.from(enabledWrite.args));
  desktop.app.quit();
  assert.equal(desktop.children[0].killCount, 1);
  assert.equal(desktop.intervals.size, 0);
  assert.equal(desktop.timeouts.size, 0);
  assert.equal(desktop.app.quitCount, 1);
});

test("an existing legacy installer startup entry is shown and can be turned off", async () => {
  const desktop = desktopMain(apiStatus("online-idle"), { legacyStartup: true });
  await desktop.ready();
  assert.equal(desktop.loginChanges.length, 0);
  assert.equal((await desktop.ipc("startup:get")).enabled, true);
  assert.equal((await desktop.ipc("startup:set", false)).enabled, false);
  assert.equal(desktop.loginRegistry.size, 0);
});

test("preload exposes finite desktop methods without an endpoint or session secret", async () => {
  const bridges = {};
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "preload.js"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld(name, value) { bridges[name] = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { supported: true, enabled: false }; } },
    }),
  });
  await bridges.desktopSettings.getStartOnLogin();
  await bridges.desktopSettings.setStartOnLogin(true);
  await bridges.desktopAPI.getStatus();
  await bridges.desktopAPI.getHistory("7d");
  await bridges.desktopAPI.getLogs();
  await bridges.desktopAPI.clearLogs();
  assert.deepEqual(calls, [["startup:get"], ["startup:set", true], ["collector:status"],
    ["collector:history", "7d"], ["collector:logs"], ["collector:clear-logs"]]);
  assert.deepEqual(Object.keys(bridges.desktopAPI).sort(), ["clearLogs", "getHistory", "getLogs", "getStatus"]);
});
