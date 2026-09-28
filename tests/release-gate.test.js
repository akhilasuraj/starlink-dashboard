const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

test("release gate refuses incomplete offline evidence and unacknowledged hardware limitations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-release-gate-"));
  try {
    const hardware = path.join(directory, "hardware.json"), offline = path.join(directory, "offline.json");
    const installer = path.join(directory, "setup.exe");
    fs.writeFileSync(installer, "fixture installer bytes");
    const capture = Buffer.from('{"sanitized":true}');
    fs.writeFileSync(path.join(directory, "capture.json"), capture);
    fs.writeFileSync(hardware, JSON.stringify({ schema_version: 1, status: "partial", owner_acceptance: "pending",
      observed_at: "2026-09-28T00:00:00Z", dish: { hardware: "rev4", firmware: "fixture-firmware" },
      rpc_results: { status: "success", history: "success" }, capture: { path: "capture.json",
        sha256: crypto.createHash("sha256").update(capture).digest("hex") }, limitations: ["Service interruption not tested"] }));
    const run = (...extra) => spawnSync(process.execPath, ["build/release-gate.js", "--hardware", hardware,
      "--offline", offline, "--installer", installer, "--expected-sha", "abc123", "--expected-run", "123", ...extra], { encoding: "utf8" });
    assert.notEqual(run("--acknowledge-limitations").status, 0);
    fs.writeFileSync(offline, JSON.stringify({ schema_version: 1, passed: true, network_disabled: true,
      python_on_path: false, installed_app_smoke: true, collector_smoke: true, disabled_adapter_count: 1,
      connected_adapters_remaining: 0, startup_opt_in_unchanged: true, network_restored: true, restored_up_adapter_count: 1,
      tested_sha: "abc123", run_id: "123", installer_sha256: crypto.createHash("sha256").update("fixture installer bytes").digest("hex") }));
    assert.notEqual(run().status, 0);
    assert.equal(run("--acknowledge-limitations").status, 0);
    const unrestored = JSON.parse(fs.readFileSync(offline)); unrestored.restored_up_adapter_count = 0;
    fs.writeFileSync(offline, JSON.stringify(unrestored));
    assert.notEqual(run("--acknowledge-limitations").status, 0);
    unrestored.restored_up_adapter_count = 1;
    fs.writeFileSync(offline, JSON.stringify(unrestored));
    fs.writeFileSync(installer, "different installer bytes");
    assert.notEqual(run("--acknowledge-limitations").status, 0);
    fs.writeFileSync(installer, "fixture installer bytes");
    const mismatched = JSON.parse(fs.readFileSync(offline)); mismatched.tested_sha = "other-commit";
    fs.writeFileSync(offline, JSON.stringify(mismatched));
    assert.notEqual(run("--acknowledge-limitations").status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("offline installer runner refuses ordinary local execution before installing or changing network", () => {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "build/offline-install-smoke.ps1"], {
    encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", STARLINK_DISPOSABLE_INSTALL_SMOKE: "0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disposable GitHub-hosted Windows runner/i);
});

test("partial or unaccepted hardware needs explicit limitations and can never publish stable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-hardware-gate-"));
  try {
    const hardware = path.join(directory, "hardware.json"), offline = path.join(directory, "offline.json");
    const installer = path.join(directory, "setup.exe");
    fs.writeFileSync(installer, "tested fixture installer");
    const capture = Buffer.from('{"sanitized":true}');
    fs.writeFileSync(path.join(directory, "capture.json"), capture);
    fs.writeFileSync(offline, JSON.stringify({ schema_version: 1, passed: true, network_disabled: true,
      python_on_path: false, installed_app_smoke: true, collector_smoke: true, disabled_adapter_count: 1,
      connected_adapters_remaining: 0, startup_opt_in_unchanged: true, network_restored: true, restored_up_adapter_count: 1,
      tested_sha: "abc123", run_id: "123", installer_sha256: crypto.createHash("sha256").update("tested fixture installer").digest("hex") }));
    const cases = [
      { status: "passed", owner_acceptance: "pending", limitations: [], acknowledge: true, allowed: false },
      { status: "partial", owner_acceptance: "accepted", limitations: [], acknowledge: true, allowed: false },
      { status: "passed", owner_acceptance: "pending", limitations: [" "], acknowledge: true, allowed: false },
      { status: "passed", owner_acceptance: "pending", limitations: ["Owner acceptance pending"], acknowledge: true, allowed: true, prerelease: true },
      { status: "passed", owner_acceptance: "accepted", limitations: [], acknowledge: false, allowed: true, prerelease: false },
    ];
    for (const scenario of cases) {
      fs.writeFileSync(hardware, JSON.stringify({ schema_version: 1, observed_at: "2026-09-28T00:00:00Z",
        dish: { hardware: "rev4", firmware: "fixture-firmware" }, rpc_results: { status: "success", history: "success" },
        capture: { path: "capture.json", sha256: crypto.createHash("sha256").update(capture).digest("hex") },
        status: scenario.status, owner_acceptance: scenario.owner_acceptance, limitations: scenario.limitations }));
      const result = spawnSync(process.execPath, ["build/release-gate.js", "--hardware", hardware,
        "--offline", offline, "--installer", installer, "--expected-sha", "abc123", "--expected-run", "123",
        ...(scenario.acknowledge ? ["--acknowledge-limitations"] : [])], { encoding: "utf8" });
      assert.equal(result.status === 0, scenario.allowed, JSON.stringify(scenario));
      if (scenario.allowed) assert.equal(JSON.parse(result.stdout).prerelease, scenario.prerelease);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
