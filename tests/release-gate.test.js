const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { writeUpdateMetadata } = require("./fixtures/update-artifact");
const version = require("../package.json").version;
const { requireDisposableUpdateRunner } = require("../build/disposable-update-runner");

function writeInstalledUpdateEvidence(directory, installer, metadata) {
  const file = path.join(directory, "installed-update.json");
  const hash = (target) => crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, passed: true, tested_sha: "abc123", run_id: "123",
    from_version: "1.2.99", to_version: version, bootstrap_is_current_source_fixture: true,
    bootstrap_sha256: "f".repeat(64), installer_sha256: hash(installer), metadata_sha256: hash(metadata),
    unattended_installer: true, interactive_wizard_tested: false, discovery_without_download: true,
    download_verified: true, explicit_restart_required: true, collector_exited_before_installer: true,
    installed_version_verified: true, relaunched_with_one_collector: true, history_retained: true,
    history_default_location_verified: true, startup_default_disabled: true,
    startup_enabled_before_update: true, startup_enabled_after_update: true, startup_opt_in_unchanged: true }));
  return file;
}

test("release gate refuses incomplete offline evidence and unacknowledged hardware limitations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-release-gate-"));
  try {
    const hardware = path.join(directory, "hardware.json"), offline = path.join(directory, "offline.json");
    const installer = path.join(directory, "setup.exe");
    fs.writeFileSync(installer, "fixture installer bytes");
    const update = writeUpdateMetadata(installer, version);
    const upgrade = writeInstalledUpdateEvidence(directory, installer, update.metadataPath);
    const capture = Buffer.from('{"sanitized":true}');
    fs.writeFileSync(path.join(directory, "capture.json"), capture);
    fs.writeFileSync(hardware, JSON.stringify({ schema_version: 1, status: "partial", owner_acceptance: "pending",
      observed_at: "2026-09-28T00:00:00Z", dish: { hardware: "rev4", firmware: "fixture-firmware" },
      rpc_results: { status: "success", history: "success" }, capture: { path: "capture.json",
        sha256: crypto.createHash("sha256").update(capture).digest("hex") }, limitations: ["Service interruption not tested"] }));
    const run = (...extra) => spawnSync(process.execPath, ["build/release-gate.js", "--hardware", hardware,
      "--offline", offline, "--installer", installer, "--expected-sha", "abc123", "--expected-run", "123",
      "--update-metadata", update.metadataPath, "--blockmap", update.blockmapPath,
      "--update-smoke", upgrade, ...extra], { encoding: "utf8" });
    assert.notEqual(run("--acknowledge-limitations").status, 0);
    fs.writeFileSync(offline, JSON.stringify({ schema_version: 1, passed: true, network_disabled: true,
      python_on_path: false, installed_app_smoke: true, collector_smoke: true, disabled_adapter_count: 1,
      connected_adapters_remaining: 0, startup_opt_in_unchanged: true, network_restored: true, restored_up_adapter_count: 1,
      tested_sha: "abc123", run_id: "123", installer_sha256: crypto.createHash("sha256").update("fixture installer bytes").digest("hex") }));
    assert.notEqual(run().status, 0);
    assert.equal(run("--acknowledge-limitations").status, 0);
    const approval = path.join(directory, "release-approval.json");
    const approvedHardware = JSON.parse(fs.readFileSync(hardware));
    approvedHardware.owner_acceptance = "accepted";
    fs.writeFileSync(hardware, JSON.stringify(approvedHardware));
    const stable = (...extra) => run("--acknowledge-limitations", "--stable-release", ...extra);
    assert.notEqual(stable().status, 0, "Stable release accepted without approval");
    assert.notEqual(stable("--release-approval", approval).status, 0, "Absent approval accepted");
    const validApproval = { schema_version: 1, version, channel: "stable", owner_authorized: true,
      limitations_acknowledged: true, authorization_basis: "Owner explicitly requested latest stable",
      limitations_basis: "Owner accepted historical limitations" };
    for (const [property, value] of Object.entries({ schema_version: 2, version: "0.0.0", channel: "prerelease",
      owner_authorized: false, limitations_acknowledged: false, authorization_basis: " ", limitations_basis: "" })) {
      fs.writeFileSync(approval, JSON.stringify({ ...validApproval, [property]: value }));
      assert.notEqual(stable("--release-approval", approval).status, 0, `Invalid stable approval ${property} accepted`);
    }
    fs.writeFileSync(approval, JSON.stringify(validApproval));
    assert.notEqual(run("--stable-release", "--release-approval", approval).status, 0,
      "Stable approval bypassed the explicit limitations input");
    const stableResult = stable("--release-approval", approval);
    assert.equal(stableResult.status, 0, stableResult.stderr);
    assert.equal(JSON.parse(stableResult.stdout).prerelease, false);
    assert.equal(JSON.parse(stableResult.stdout).stable_owner_approved, true);
    assert.deepEqual(JSON.parse(stableResult.stdout).limitations, approvedHardware.limitations);
    assert.equal(JSON.parse(run("--acknowledge-limitations").stdout).prerelease, true,
      "Approval changed the default prerelease policy");
    approvedHardware.owner_acceptance = "pending";
    fs.writeFileSync(hardware, JSON.stringify(approvedHardware));
    assert.notEqual(stable("--release-approval", approval).status, 0, "Stable release accepted pending hardware acceptance");
    const validUpgrade = JSON.parse(fs.readFileSync(upgrade));
    for (const [property, value] of Object.entries({ passed: false, tested_sha: "other", run_id: "456",
      from_version: version, to_version: "0.0.0", installer_sha256: "0".repeat(64), metadata_sha256: "0".repeat(64),
      bootstrap_sha256: "invalid", history_retained: false, history_default_location_verified: false,
      startup_opt_in_unchanged: false,
      startup_default_disabled: false, startup_enabled_before_update: false, startup_enabled_after_update: false,
      collector_exited_before_installer: false, explicit_restart_required: false,
      relaunched_with_one_collector: false, download_verified: false, discovery_without_download: false })) {
      fs.writeFileSync(upgrade, JSON.stringify({ ...validUpgrade, [property]: value }));
      assert.notEqual(run("--acknowledge-limitations").status, 0, `Missing or mismatched ${property} accepted`);
    }
    fs.rmSync(upgrade);
    assert.notEqual(run("--acknowledge-limitations").status, 0, "Absent installed update evidence accepted");
    fs.writeFileSync(upgrade, JSON.stringify(validUpgrade));
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

test("default release policy keeps partial or unaccepted hardware prerelease with explicit limitations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-hardware-gate-"));
  try {
    const hardware = path.join(directory, "hardware.json"), offline = path.join(directory, "offline.json");
    const installer = path.join(directory, "setup.exe");
    fs.writeFileSync(installer, "tested fixture installer");
    const update = writeUpdateMetadata(installer, version);
    const upgrade = writeInstalledUpdateEvidence(directory, installer, update.metadataPath);
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
        "--update-metadata", update.metadataPath, "--blockmap", update.blockmapPath,
        "--update-smoke", upgrade,
        ...(scenario.acknowledge ? ["--acknowledge-limitations"] : [])], { encoding: "utf8" });
      assert.equal(result.status === 0, scenario.allowed, JSON.stringify(scenario));
      if (scenario.allowed) assert.equal(JSON.parse(result.stdout).prerelease, scenario.prerelease);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("installed update guard refuses local builds and installs before any mutation", () => {
  const allowed = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows",
    STARLINK_DISPOSABLE_UPDATE_SMOKE: "1" };
  assert.doesNotThrow(() => requireDisposableUpdateRunner(allowed));
  for (const name of Object.keys(allowed)) {
    assert.throws(() => requireDisposableUpdateRunner({ ...allowed, [name]: "" }), /disposable GitHub-hosted/);
  }
  const original = ["package.json", "package-lock.json"].map((file) => fs.readFileSync(file));
  const env = { ...process.env, GITHUB_ACTIONS: "false", STARLINK_DISPOSABLE_UPDATE_SMOKE: "0" };
  for (const script of ["build/build-update-bootstrap.js", "tests/installed-update-smoke.js"]) {
    const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disposable GitHub-hosted Windows runner/);
  }
  for (const [index, file] of ["package.json", "package-lock.json"].entries()) {
    assert.deepEqual(fs.readFileSync(file), original[index], "Refused bootstrap changed project versions");
  }
  const powershell = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "build/installed-update-smoke.ps1"],
    { env, encoding: "utf8" });
  assert.notEqual(powershell.status, 0);
  assert.match(powershell.stderr, /disposable GitHub-hosted Windows runner/);
});
