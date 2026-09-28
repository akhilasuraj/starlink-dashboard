const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
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
    const response = await fetch("http://127.0.0.1:8000/api/status", { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Status API returned ${response.status}`);
    const status = await response.json();
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
  if (isQuitting && !sessionEnding) completeQuit();
  else if (!isQuitting) scheduleBackendRestart();
}

function startBackend() {
  if (isQuitting || backendProcess) return;
  const backendDir = app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(__dirname, "backend");
  const developmentPython = path.join(__dirname, ".venv", "Scripts", "python.exe");
  const pythonPath = !app.isPackaged && fs.existsSync(developmentPython) ? developmentPython : "python";
  const child = spawn(pythonPath, [path.join(backendDir, "server.py")], { cwd: backendDir, windowsHide: true });
  backendProcess = child;
  child.stdout.on("data", (data) => console.log(`Backend: ${data}`));
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
    width: 600, height: 750, title: "Starlink Dashboard", backgroundColor: "#1a1a1a",
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  mainWindow = window;
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
  // Electron 28 concatenates this path into a registry command without quoting.
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
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Unknown dashboard window");
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
