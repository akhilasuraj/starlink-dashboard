// Run explicitly after packaging; the inspector is enabled only for this check.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function smoke() {
const executable = path.resolve(process.env.DESKTOP_EXE || "dist/win-unpacked/Starlink Dashboard.exe");
const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
// Fail before launching anything when this runner cannot inspect owned PIDs.
const processAccess = spawnSync(powershell, ["-NoProfile", "-Command",
  "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"name = 'starlink-collector.exe'\" | Out-Null"],
  { encoding: "utf8", windowsHide: true, timeout: 15000 });
assert.equal(processAccess.status, 0, processAccess.stderr || "Process inspection unavailable");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-desktop-package-"));
const env = { ...process.env, PATH: `${process.env.SystemRoot}\\System32`,
  STARLINK_DASHBOARD_DATA_DIR: directory };
delete env.PYTHONPATH; delete env.PYTHONHOME; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ["--hidden", "--inspect=127.0.0.1:0"],
  { env, cwd: directory, windowsHide: true });
const stopped = once(child, "close");
let socket, errors = "", sequence = 0;
const ownedCollectorPids = new Set();
const pending = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collectorProcesses = () => {
  const result = spawnSync(powershell,
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "name = 'starlink-collector.exe'" | ` +
      `Where-Object ParentProcessId -eq ${child.pid} | Select-Object -ExpandProperty ProcessId`],
    { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const pids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  pids.forEach((pid) => ownedCollectorPids.add(pid));
  return pids;
};
function evaluate(expression) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Inspector command timed out")); }, 5000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
      expression, awaitPromise: true, returnByValue: true,
    } }));
  });
}
const electron = `process.getBuiltinModule("module").createRequire(process.execPath)("electron")`;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No app inspector: ${errors}`)), 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`Desktop exited: ${errors}`)); });
    child.stderr.on("data", (data) => {
      errors += data;
      const match = errors.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  socket = new WebSocket(url);
  await Promise.race([once(socket, "open"), pause(5000).then(() => {
    throw new Error("App inspector connection timed out");
  })]);
  const disconnected = () => {
    for (const request of pending.values()) request.reject(new Error("App inspector disconnected"));
    pending.clear();
  };
  socket.addEventListener("close", disconnected);
  socket.addEventListener("error", disconnected);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error || message.result.exceptionDetails) request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result.result.value);
  });
  let result, lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    collectorProcesses();
    try {
      result = await evaluate(`(async () => {
        const window = ${electron}.BrowserWindow.getAllWindows()[0];
        if (!window || window.webContents.isLoading()) throw new Error("Window loading");
        return window.webContents.executeJavaScript(${JSON.stringify(`(async () => ({
          status: await window.desktopAPI.getStatus(), history: await window.desktopAPI.getHistory("7d"),
          chartReady: typeof Chart === "function", label: document.getElementById("status").textContent,
          methods: Object.keys(window.desktopAPI).sort(),
        }))()`)});
      })()`);
      if (result.status.collection_state === "collecting") { result = null; await pause(500); continue; }
      break;
    } catch (error) { lastError = error; await pause(500); }
  }
  assert.ok(result, `Window/preload/collector did not become usable: ${lastError}\n${errors}`);
  assert.ok(result.chartReady, "Bundled chart library missing");
  assert.equal(result.history.range, "7d");
  assert.ok(result.status.collection_state);
  assert.notEqual(result.status.collection_state, "collector_error", "Bundled runtime failed collection");
  assert.deepEqual(result.methods, ["clearLogs", "getHistory", "getLogs", "getStatus"]);
  // Exercise real layout after resizing; a flexed canvas can stretch independently
  // of Chart.js's drawing size and distort labels even when the data is correct.
  for (const [width, height] of [[600, 750], [1000, 1050]]) {
    await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].setSize(${width},${height})`);
    await pause(750);
    const layout = await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(`(() => {
      const chart = Chart.getChart("speedChart");
      const rectangle = document.getElementById("speedChart").getBoundingClientRect();
      return { width: chart.width, height: chart.height, displayedWidth: rectangle.width, displayedHeight: rectangle.height };
    })()`)});`);
    assert.ok(Math.abs(layout.width - layout.displayedWidth) <= 2, "Traffic canvas width differs from its drawing size");
    assert.ok(Math.abs(layout.height - layout.displayedHeight) <= 2, "Traffic canvas height differs from its drawing size");
  }
  const pids = collectorProcesses();
  assert.equal(pids.length, 1, "One app owns exactly one bundled collector");
  const duplicate = spawn(executable, ["--hidden"], { env, cwd: directory, windowsHide: true });
  const duplicateStopped = once(duplicate, "close");
  const [code] = await Promise.race([duplicateStopped, pause(10000).then(() => { duplicate.kill();
    throw new Error("Duplicate desktop did not quit"); })]);
  assert.equal(code, 0);
  assert.deepEqual(collectorProcesses(), pids, "Duplicate launch created another collector");
  console.log(JSON.stringify({ windowLoaded: true, chartLoaded: true,
    privateBridge: true, chartResizeVerified: true, collectorCount: 1, duplicateExited: true,
    collectionState: result.status.collection_state, pythonOnPath: false }));
} finally {
  let cleanupError;
  if (socket?.readyState === WebSocket.OPEN) {
    try { await evaluate(`${electron}.app.quit()`); } catch {}
  }
  socket?.close();
  try {
    await Promise.race([stopped, pause(10000).then(() => { child.kill();
      throw new Error("Desktop did not finish collector cleanup"); })]);
    assert.deepEqual(collectorProcesses(), [], "Quit left an orphan collector");
  } catch (error) { cleanupError = error; }
  const orphaned = [...ownedCollectorPids].filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  // Clean up only collector PIDs captured as this test app's children.
  orphaned.forEach((pid) => { try { process.kill(pid); } catch {} });
  try {
    assert.deepEqual(orphaned, [], "A captured collector PID survived desktop quit");
    if (cleanupError) throw cleanupError;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

}
smoke().catch((error) => { console.error(error); process.exitCode = 1; });
