// Real installs are permitted only in the disposable CI job. Never run on a user's PC.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { requireDisposableUpdateRunner } = require("../build/disposable-update-runner");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, explanation, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error(`${explanation}${lastError ? `: ${lastError.message}` : ""}`);
}

async function smoke() {
  requireDisposableUpdateRunner(); // Before seeding history, opening a server, or starting any app.
  const root = path.resolve(__dirname, "..");
  const installRoot = path.resolve(process.env.STARLINK_UPDATE_INSTALL_ROOT);
  const dataRoot = path.resolve(process.env.STARLINK_UPDATE_DATA_ROOT);
  const historyRoot = path.resolve(process.env.STARLINK_UPDATE_HISTORY_ROOT);
  const temporaryRoot = path.resolve(process.env.RUNNER_TEMP) + path.sep;
  for (const target of [installRoot, dataRoot]) {
    assert.ok(target.toLowerCase().startsWith(temporaryRoot.toLowerCase()), "Test target outside runner temp");
  }
  assert.equal(historyRoot.toLowerCase(), path.join(process.env.LOCALAPPDATA, "Starlink Dashboard").toLowerCase(),
    "History fixture must use the normal installed app location on this disposable runner");
  const version = require("../package.json").version;
  const installer = path.resolve(process.env.STARLINK_UPDATE_INSTALLER);
  const bootstrap = path.resolve(process.env.STARLINK_UPDATE_BOOTSTRAP);
  const executable = path.join(installRoot, "Starlink Dashboard.exe");
  const metadata = path.join(root, "dist/latest.yml");
  const reportPath = path.resolve(process.env.STARLINK_UPDATE_REPORT);
  const markerPath = path.join(dataRoot, "installer-start.json");
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const report = { schema_version: 1, passed: false, tested_sha: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID, from_version: "1.2.99", to_version: version,
    bootstrap_is_current_source_fixture: true, bootstrap_sha256: hash(bootstrap),
    installer_sha256: hash(installer), metadata_sha256: hash(metadata),
    unattended_installer: true, interactive_wizard_tested: false,
    startup_opt_in_unchanged: false };
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  function ps(command) {
    const result = spawnSync(powershell, ["-NoProfile", "-Command", `$ErrorActionPreference='Stop'; ${command}`],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const quotedRoot = installRoot.replaceAll("'", "''");
  function installedProcesses() {
    const value = ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ` +
      `$_.ExecutablePath.StartsWith('${quotedRoot}\\',[StringComparison]::OrdinalIgnoreCase) } | ` +
      `Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress`);
    return value ? [].concat(JSON.parse(value)) : [];
  }
  function startupRegistry() {
    return JSON.parse(ps(`$run='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; ` +
      `$approved='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; ` +
      `$command=Get-ItemPropertyValue -LiteralPath $run -Name 'com.starlink.dashboard'; ` +
      `$approval=(Get-ItemProperty -LiteralPath $approved -ErrorAction SilentlyContinue).'com.starlink.dashboard'; ` +
      `[pscustomobject]@{command=$command;approval=$approval} | ConvertTo-Json -Compress`));
  }
  const ownedPids = new Set();
  const python = path.join(root, ".venv/Scripts/python.exe");
  function pythonRun(script) {
    const result = spawnSync(python, ["-c", script, path.join(historyRoot, "history.sqlite3")],
      { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const retained = pythonRun(`import json, sys, sqlite3\nfrom datetime import datetime, timedelta, timezone\n` +
    `from pathlib import Path\nfrom backend.history import HistoryStore\n` +
    `status=json.loads(Path('backend/tests/fixtures/online-idle.json').read_text())\n` +
    `HistoryStore(Path(sys.argv[1])).record_status(status, datetime.now(timezone.utc)-timedelta(seconds=120))\n` +
    `with sqlite3.connect(sys.argv[1]) as db: print(json.dumps(db.execute('SELECT * FROM samples').fetchone()))`);
  assert.ok(retained?.[0]?.startsWith("status:"), "History fixture was not recorded through HistoryStore");
  let requests = 0;
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname;
    const file = name === "/latest.yml" ? metadata : name === `/${path.basename(installer)}` ? installer : null;
    if (!file) { response.writeHead(404).end(); return; }
    if (file === installer) requests += 1;
    response.setHeader("Content-Length", fs.statSync(file).size);
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const feed = `http://127.0.0.1:${server.address().port}/`;
  const env = { ...process.env,
    PATH: path.join(process.env.SystemRoot, "System32") };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PYTHONHOME; delete env.PYTHONPATH;
  delete env.STARLINK_DASHBOARD_DATA_DIR;
  let child, socket, sequence = 0, errors = "";
  const pending = new Map();
  function evaluate(expression, timeout = 15000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Inspector command timed out")); }, timeout);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression,
        awaitPromise: true, returnByValue: true } }));
    });
  }
  const electron = `process.getBuiltinModule("module").createRequire(process.execPath)("electron")`;
  const renderer = (script, timeout) => evaluate(`${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(script)})`, timeout);
  try {
    assert.deepEqual(installedProcesses(), [], "Bootstrap installer unexpectedly started the app");
    child = spawn(executable, ["--hidden", "--inspect=127.0.0.1:0"], { env, cwd: dataRoot, windowsHide: true });
    ownedPids.add(child.pid);
    const closed = once(child, "close");
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No installed inspector: ${errors}`)), 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`Installed app exited: ${errors}`)); });
      child.stderr.on("data", (data) => {
        errors += data;
        const match = errors.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    socket = new WebSocket(url);
    await Promise.race([once(socket, "open"), pause(5000).then(() => { throw new Error("Inspector connection timed out"); })]);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message)));
      else request.resolve(message.result.result.value);
    });
    const disconnected = () => { for (const request of pending.values()) request.reject(new Error("Inspector disconnected")); pending.clear(); };
    socket.addEventListener("close", disconnected); socket.addEventListener("error", disconnected);
    await waitFor(() => evaluate(`(() => { const window=${electron}.BrowserWindow.getAllWindows()[0];
      return !!window && !window.webContents.isLoading(); })()`), "Installed window did not load");
    assert.equal(await evaluate(`${electron}.app.getVersion()`), report.from_version);
    // Inspector-only adaptation: a loopback feed and silent installer on a disposable runner.
    // The production bridge still cannot supply URLs, paths, or installer arguments.
    await evaluate(`(() => {
      const electron=${electron};
      const requireApp=process.getBuiltinModule("module").createRequire(electron.app.getAppPath()+"/package.json");
      const updater=requireApp("electron-updater").autoUpdater;
      updater.setFeedURL({provider:"generic",url:${JSON.stringify(feed)}});
      updater.disableDifferentialDownload=true;
      const install=updater.quitAndInstall.bind(updater);
      updater.quitAndInstall=(silent,forceRun)=>{
        const result=process.getBuiltinModule("child_process").spawnSync(${JSON.stringify(powershell)},
          ["-NoProfile","-Command", "@(Get-CimInstance Win32_Process -Filter \\\"name = 'starlink-collector.exe'\\\" | Where-Object ParentProcessId -eq "+process.pid+").Count"],
          {encoding:"utf8",windowsHide:true});
        if(result.status!==0 || Number(result.stdout.trim())!==0) throw new Error("Collector survived to installer launch");
        if(silent!==false || forceRun!==true) throw new Error("Production installer arguments changed");
        process.getBuiltinModule("fs").writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({collector_exited:true,production_arguments_verified:true}));
        return install(true,true);
      };
      return true;
    })()`);
    const collectors = await waitFor(() => {
      const entries = installedProcesses(); entries.forEach((entry) => ownedPids.add(entry.ProcessId));
      const matches = entries.filter((entry) => entry.Name === "starlink-collector.exe" && entry.ParentProcessId === child.pid);
      return matches.length === 1 && matches;
    }, "Bootstrap did not own one bundled collector");
    const startup = await renderer("window.desktopSettings.getStartOnLogin()");
    assert.equal(startup.enabled, false);
    report.startup_default_disabled = true;
    const optedIn = await renderer("window.desktopSettings.setStartOnLogin(true)");
    assert.equal(optedIn.enabled, true);
    const startupBefore = startupRegistry();
    assert.ok(startupBefore.command.includes(executable), "Startup command targets a different installation");
    assert.ok(startupBefore.command.includes("--hidden"), "Startup command lost the hidden launch option");
    report.startup_enabled_before_update = true;
    const available = await renderer("window.desktopUpdates.check()");
    assert.equal(available.phase, "available"); assert.equal(available.availableVersion, version);
    assert.equal(requests, 0, "Checking unexpectedly downloaded the installer");
    report.discovery_without_download = true;
    const downloaded = await renderer("window.desktopUpdates.download()", 120000);
    assert.equal(downloaded.phase, "downloaded"); assert.ok(requests > 0, "Installer was not downloaded from the test feed");
    assert.equal(child.exitCode, null); assert.equal(fs.existsSync(markerPath), false);
    assert.ok(installedProcesses().some((entry) => entry.ProcessId === collectors[0].ProcessId));
    report.download_verified = true; report.explicit_restart_required = true;
    // Schedule outside the inspector request so the process can exit after its response.
    await evaluate(`setImmediate(()=>${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.desktopUpdates.install()")); true`);
    await waitFor(() => fs.existsSync(markerPath), "Explicit restart never launched the installer");
    socket.close();
    const [exitCode] = await Promise.race([closed, pause(30000).then(() => { throw new Error("Previous desktop did not quit"); })]);
    assert.equal(exitCode, 0, "Previous desktop crashed during update shutdown");
    const marker = JSON.parse(fs.readFileSync(markerPath));
    assert.equal(marker.collector_exited, true); assert.equal(marker.production_arguments_verified, true);
    report.collector_exited_before_installer = true;
    const relaunched = await waitFor(() => {
      const entries = installedProcesses(); entries.forEach((entry) => ownedPids.add(entry.ProcessId));
      const apps = entries.filter((entry) => entry.Name === "Starlink Dashboard.exe" && entry.ParentProcessId !== child.pid);
      // Electron renderer children have the same executable name; identify the main by its collector.
      const main = apps.find((entry) => entries.some((candidate) => candidate.ParentProcessId === entry.ProcessId && candidate.Name === "starlink-collector.exe"));
      if (!main) return false;
      const fileVersion = ps(`(Get-Item -LiteralPath '${quotedRoot}\\Starlink Dashboard.exe').VersionInfo.ProductVersion`);
      return (fileVersion === version || fileVersion === `${version}.0`) && { main, entries, fileVersion };
    }, "Updated version did not relaunch with a collector", 120000);
    assert.equal(relaunched.entries.filter((entry) => entry.Name === "starlink-collector.exe").length, 1);
    assert.ok(!relaunched.entries.some((entry) => entry.ProcessId === collectors[0].ProcessId), "Previous collector remained alive");
    report.installed_version_verified = true; report.relaunched_with_one_collector = true;
    report.installed_product_version = relaunched.fileVersion;
    assert.deepEqual(startupRegistry(), startupBefore, "Update changed the user's enabled startup preference");
    report.startup_enabled_after_update = true;
    const retainedAfter = pythonRun(`import json, sys, sqlite3\nwith sqlite3.connect(sys.argv[1]) as db:\n` +
      ` print(json.dumps(db.execute('SELECT * FROM samples WHERE sample_key = ?', (${JSON.stringify(retained[0])},)).fetchone()))`);
    assert.deepEqual(retainedAfter, retained, "Fixture history changed or disappeared across update");
    report.history_retained = true;
    report.history_default_location_verified = true;
    report.passed = true;
  } finally {
    socket?.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    // Parent PowerShell cleanup also verifies executable paths before stopping leftovers.
    // Here stop only captured test PIDs that still belong to this install directory.
    for (const entry of installedProcesses()) {
      if (ownedPids.has(entry.ProcessId)) { try { process.kill(entry.ProcessId); } catch {} }
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, inspector_stderr: errors.slice(-6000) }, null, 2) + "\n");
  }
}

smoke().catch((error) => { console.error(error); process.exitCode = 1; });
