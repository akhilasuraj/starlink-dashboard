const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { randomBytes } = require("crypto");
const APP_ID = "com.starlink.dashboard";

let tray = null;
let trayState = null;
let mainWindow = null;
let backendProcess = null;
let statusTimer = null;
let restartTimer = null;
let shutdownTimer = null;
let statusInFlight = false;
let restartDelay = 1000;
let isQuitting = false;
let shutdownComplete = false;
let sessionEnding = false;
let collectorSession = null;

async function collectorRequest(route, method = "GET", timeout = 15000) {
  const session = collectorSession;
  if (!session || !session.port) throw new Error("Collector is starting or unavailable");
  const response = await fetch(`http://127.0.0.1:${session.port}${route}`, {
    method, headers: { Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Collector returned ${response.status}`);
  const body = await response.json();
  // A response from an exited session must not replace the current live state.
  if (session !== collectorSession) throw new Error("Collector session changed");
  return body;
}

function setTrayHealth(state, label) {
  if (!tray || isQuitting) return;
  if (state !== trayState) {
    tray.setImage(nativeImage.createFromPath(path.join(__dirname, "assets", "tray", `${state}.png`)));
    trayState = state;
  }
  tray.setToolTip(`Starlink: ${label}`);
}

async function updateTrayStatus() {
  if (isQuitting || statusInFlight) return;
  statusInFlight = true;
  try {
    const status = await collectorRequest("/api/status", "GET", 1500);
    restartDelay = 1000;
    const collection = status && status.collection_state;
    if (collection === "dish_unreachable") {
      setTrayHealth("unreachable", "Dish unreachable — service state unknown");
    } else if (collection === "collector_error") {
      setTrayHealth("collector-error", "Collector unavailable");
    } else if (collection === "collecting") {
      setTrayHealth("collecting", "Collecting");
    } else {
      const observed = status && Date.parse(status.observed_at);
      const hasReading = status && typeof status.source === "string" && status.source.trim() && Number.isFinite(observed);
      if (collection === "stale" || status && status.stale || (hasReading && Date.now() - observed > 6000)) {
        setTrayHealth("stale", "Data stale — service state unknown");
      } else if (collection !== "reachable" || !hasReading) {
        setTrayHealth("unknown", "Service unknown — no current dish reading");
      } else if (status.service_state === "online") {
        setTrayHealth("healthy", "Service online");
      } else if (status.service_state === "impaired") {
        setTrayHealth("impaired", "Service impaired — dish reports ping loss or current obstruction");
      } else if (status.service_state === "offline") {
        setTrayHealth("offline", "Service offline — reported by dish");
      } else {
        setTrayHealth("unknown", "Service unknown");
      }
    }
  } catch (error) {
    setTrayHealth("collector-error", "Collector unavailable — retrying");
  } finally {
    statusInFlight = false;
  }
}

function scheduleBackendRestart() {
  if (isQuitting || restartTimer !== null) return;
  setTrayHealth("collector-error", "Collector unavailable — restarting");
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, restartDelay);
  restartDelay = Math.min(restartDelay * 2, 30000);
}

function backendStopped(child) {
  if (backendProcess !== child) return;
  backendProcess = null;
  collectorSession = null;
  if (isQuitting && !sessionEnding) completeQuit();
  else if (!isQuitting) scheduleBackendRestart();
}

function startBackend() {
  if (isQuitting || backendProcess) return;
  const developmentPython = path.join(__dirname, ".venv", "Scripts", "python.exe");
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, "collector", "starlink-collector.exe") : developmentPython;
  const args = app.isPackaged ? [] : ["-m", "backend.collector"];
  const env = { ...process.env, STARLINK_DASHBOARD_SESSION_TOKEN: randomBytes(32).toString("hex") };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  const session = { token: env.STARLINK_DASHBOARD_SESSION_TOKEN, port: null };
  collectorSession = session;
  const child = spawn(executable, args, { cwd: app.isPackaged ? path.dirname(executable) : __dirname,
    env, windowsHide: true });
  backendProcess = child;
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
    const lines = output.split(/\r?\n/);
    output = lines.pop().slice(-4096);
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (backendProcess === child && message.event === "collector-listening" &&
            Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
          session.port = message.port;
          updateTrayStatus();
        }
      } catch { /* Collector stdout carries readiness messages only. */ }
    }
  });
  child.stderr.on("data", (data) => console.error(`Backend: ${data}`));
  child.on("error", (error) => {
    console.error(`Collector could not start: ${error.message}`);
    if (backendProcess === child) {
      setTrayHealth("collector-error", "Collector unavailable — retrying");
      // Spawn failures have no PID. An error on a running child does not prove
      // it has exited; wait for close before starting another collector.
      if (!child.pid) {
        backendStopped(child);
      }
    }
  });
  child.on("close", (code) => {
    console.log(`Collector exited: ${code}`);
    backendStopped(child);
  });
}

function showWindow() {
  if (isQuitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow(true);
}

function createWindow(show) {
  const window = new BrowserWindow({
    show,
    width: 1120, height: 800, minWidth: 560, minHeight: 640,
    title: "Starlink Dashboard", backgroundColor: "#000000",
    icon: path.join(__dirname, "assets", "app-icon.png"),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  mainWindow = window;
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadFile(path.join(__dirname, "renderer", "index.html"));
  window.on("close", (event) => {
    if (!isQuitting) { event.preventDefault(); window.hide(); }
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.on("session-end", stopForSessionEnd);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "tray", "collecting.png")));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showWindow },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", showWindow);
  setTrayHealth("collecting", "Collecting");
}

function loginOptions() {
  // Electron 44 normalizes surrounding quotes when writing commands; its
  // launch-item lookup still parses the supplied path as a command line.
  return { path: `"${process.execPath}"`, args: ["--hidden"] };
}

function getStartupSetting() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return { supported: false, enabled: false, explanation: "Available in the installed Windows app" };
  }
  const setting = app.getLoginItemSettings(loginOptions());
  const legacyEnabled = Array.isArray(setting.launchItems) && setting.launchItems.some((item) =>
    item.name === "StarlinkDashboard" && item.scope === "user" && item.enabled &&
    Array.isArray(item.args) && item.args.length === 1 && item.args[0] === "--hidden");
  return { supported: true, enabled: legacyEnabled ||
    setting.openAtLogin && setting.executableWillLaunchAtLogin !== false };
}

function checkSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("Unknown dashboard window or frame");
}

function completeQuit() {
  if (shutdownComplete) return;
  if (shutdownTimer !== null) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  if (tray) { tray.destroy(); tray = null; }
  shutdownComplete = true;
  app.quit();
}

function stopDesktopTimers() {
  isQuitting = true;
  if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null; }
  if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
}

function stopForSessionEnd() {
  sessionEnding = true;
  stopDesktopTimers();
  if (backendProcess) backendProcess.kill("SIGTERM");
}

function quitWithCollector(event) {
  if (shutdownComplete) return;
  event.preventDefault();
  if (isQuitting) return;
  stopDesktopTimers();
  const child = backendProcess;
  if (!child) { completeQuit(); return; }
  shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
  child.kill("SIGTERM");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {}); // The tray owns the app while the window is hidden.
  app.on("before-quit", quitWithCollector);
  process.on("exit", () => { if (backendProcess) backendProcess.kill(); });
  ipcMain.handle("startup:get", (event) => { checkSender(event); return getStartupSetting(); });
  ipcMain.handle("collector:status", (event) => {
    checkSender(event); return collectorRequest("/api/status", "GET", 1500);
  });
  ipcMain.handle("collector:history", (event, range) => {
    checkSender(event);
    if (!["15m", "24h", "7d"].includes(range)) throw new Error("Unsupported history range");
    return collectorRequest(`/api/history?range=${range}`);
  });
  ipcMain.handle("collector:logs", (event) => { checkSender(event); return collectorRequest("/api/logs"); });
  ipcMain.handle("collector:clear-logs", (event) => {
    checkSender(event); return collectorRequest("/api/logs/clear", "POST");
  });
  ipcMain.handle("startup:set", (event, enabled) => {
    checkSender(event);
    if (typeof enabled !== "boolean" || !getStartupSetting().supported) throw new Error("Startup setting unavailable");
    // Remove the old installer's forced entry only when the user changes startup.
    app.setLoginItemSettings({ ...loginOptions(), name: "StarlinkDashboard", openAtLogin: false });
    app.setLoginItemSettings({ ...loginOptions(), openAtLogin: enabled, enabled });
    return getStartupSetting();
  });
  app.whenReady().then(() => {
    if (isQuitting) return;
    createTray();
    startBackend();
    // Keep a hidden native window to receive Windows session-end during logoff.
    createWindow(!process.argv.includes("--hidden"));
    statusTimer = setInterval(updateTrayStatus, 2000);
    updateTrayStatus();
  });
}
