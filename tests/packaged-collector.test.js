const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const executable = path.resolve(process.env.COLLECTOR_EXE ||
  "build/collector-dist/starlink-collector/starlink-collector.exe");

test("bundled collector runs without Python and admits only its owning desktop session", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "starlink-package-"));
  const token = randomBytes(32).toString("hex");
  const env = { ...process.env, PATH: `${process.env.SystemRoot}\\System32`,
    STARLINK_DASHBOARD_SESSION_TOKEN: token, STARLINK_DASHBOARD_DATA_DIR: directory };
  delete env.PYTHONPATH; delete env.PYTHONHOME;
  const child = spawn(executable, [], { env, cwd: directory, windowsHide: true });
  let errors = "", output = "";
  child.stderr.on("data", (data) => { errors += data; });
  const stopped = once(child, "close");
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No collector readiness: ${errors}`)), 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`Collector exited: ${errors}`)); });
      child.stdout.on("data", (data) => {
        output += data;
        for (const line of output.split(/\r?\n/)) {
          try { const message = JSON.parse(line);
            if (message.event === "collector-listening") { clearTimeout(timer); resolve(message.port); }
          } catch { /* incomplete readiness line */ }
        }
      });
    });
    assert.ok(Number.isInteger(port) && port > 0 && port !== 8000);
    const url = `http://127.0.0.1:${port}`;
    const authorized = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) };
    // Socket readiness precedes ASGI startup by a small interval.
    let ready;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { ready = await fetch(`${url}/health`, authorized); if (ready.ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready?.ok, errors);
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/logs/clear`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: "Bearer wrong-session" } })).status, 401);
    const status = await (await fetch(`${url}/api/status`, authorized)).json();
    assert.ok(["collecting", "dish_unreachable", "reachable", "collector_error"].includes(status.collection_state));
    const history = await (await fetch(`${url}/api/history?range=7d`, authorized)).json();
    assert.equal(history.range, "7d");
    assert.equal(history.window_seconds, 604800);
    const cors = await fetch(`${url}/health`, { ...authorized,
      headers: { ...authorized.headers, Origin: "https://untrusted.example" } });
    assert.equal(cors.headers.get("access-control-allow-origin"), null);
    assert.ok(!output.includes(token));
    child.kill();
    await stopped;
    await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (child.exitCode === null) child.kill();
    await stopped;
    rmSync(directory, { recursive: true, force: true });
  }
});
