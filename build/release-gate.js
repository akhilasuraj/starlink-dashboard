const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateUpdateMetadata } = require("./update-metadata");

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }
try {
  const hardwarePath = option("--hardware");
  const hardware = JSON.parse(fs.readFileSync(hardwarePath));
  const offline = JSON.parse(fs.readFileSync(option("--offline")));
  const requireEvidence = (condition, explanation) => { if (!condition) throw new Error(explanation); };
  requireEvidence(offline.schema_version === 1 && offline.passed === true &&
    offline.network_disabled === true && offline.python_on_path === false &&
    offline.installed_app_smoke === true && offline.collector_smoke === true &&
    offline.disabled_adapter_count > 0 && offline.connected_adapters_remaining === 0 &&
    offline.startup_opt_in_unchanged === true && offline.network_restored === true &&
    offline.restored_up_adapter_count === offline.disabled_adapter_count,
  "Complete offline installed-artifact evidence required");
  requireEvidence(offline.tested_sha === option("--expected-sha") &&
    offline.run_id === option("--expected-run") && /^[a-f0-9]{64}$/i.test(offline.installer_sha256),
  "Offline evidence must match this commit and workflow run");
  requireEvidence(crypto.createHash("sha256").update(fs.readFileSync(option("--installer"))).digest("hex") ===
    offline.installer_sha256.toLowerCase(), "Installer bytes differ from the offline-tested artifact");
  const upgrade = JSON.parse(fs.readFileSync(option("--update-smoke")));
  const version = require("../package.json").version;
  requireEvidence(upgrade.schema_version === 1 && upgrade.passed === true &&
    upgrade.tested_sha === option("--expected-sha") && upgrade.run_id === option("--expected-run") &&
    upgrade.from_version === "1.2.99" && upgrade.to_version === version &&
    upgrade.bootstrap_is_current_source_fixture === true && /^[a-f0-9]{64}$/i.test(upgrade.bootstrap_sha256) &&
    upgrade.unattended_installer === true && upgrade.interactive_wizard_tested === false &&
    upgrade.discovery_without_download === true && upgrade.download_verified === true &&
    upgrade.explicit_restart_required === true && upgrade.collector_exited_before_installer === true &&
    upgrade.installed_version_verified === true && upgrade.relaunched_with_one_collector === true &&
    upgrade.history_retained === true && upgrade.history_default_location_verified === true &&
    upgrade.startup_default_disabled === true && upgrade.startup_enabled_before_update === true &&
    upgrade.startup_enabled_after_update === true &&
    upgrade.startup_opt_in_unchanged === true,
  "Complete installed two-version update evidence required for this commit and workflow run");
  requireEvidence(upgrade.installer_sha256 === offline.installer_sha256.toLowerCase() &&
    crypto.createHash("sha256").update(fs.readFileSync(option("--update-metadata"))).digest("hex") === upgrade.metadata_sha256,
  "Update evidence installer or metadata bytes differ from the tested release assets");
  requireEvidence(hardware.schema_version === 1 && ["partial", "passed"].includes(hardware.status) &&
    Number.isFinite(Date.parse(hardware.observed_at)) && hardware.dish?.hardware && hardware.dish?.firmware &&
    hardware.rpc_results?.status === "success" && hardware.rpc_results?.history === "success" &&
    Array.isArray(hardware.limitations), "Read-only live hardware evidence required");
  requireEvidence(hardware.capture?.path && /^[a-f0-9]{64}$/i.test(hardware.capture.sha256),
    "Sanitized capture evidence required");
  const bytes = fs.readFileSync(path.resolve(path.dirname(hardwarePath), hardware.capture.path));
  requireEvidence(crypto.createHash("sha256").update(bytes).digest("hex") === hardware.capture.sha256 &&
    JSON.parse(bytes).sanitized === true, "Hardware capture hash or sanitization declaration differs");
  const acknowledged = process.argv.includes("--acknowledge-limitations");
  const incomplete = hardware.status !== "passed" || hardware.owner_acceptance !== "accepted";
  requireEvidence(hardware.limitations.every((item) => typeof item === "string" && item.trim().length > 0) &&
    (!incomplete || hardware.limitations.length > 0),
  "Incomplete or unaccepted hardware evidence requires nonempty explicit limitations");
  requireEvidence(hardware.owner_acceptance === "accepted" || acknowledged,
    "Owner hardware acceptance or explicit limitations acknowledgment required");
  requireEvidence(hardware.limitations.length === 0 || acknowledged,
    "Hardware limitations must be explicitly acknowledged");
  const prerelease = incomplete || hardware.limitations.length > 0;
  validateUpdateMetadata({ metadataPath: option("--update-metadata"), installerPath: option("--installer"),
    blockmapPath: option("--blockmap"), version });
  const decision = { allowed: true, prerelease, limitations: hardware.limitations };
  if (option("--notes-output")) fs.writeFileSync(option("--notes-output"),
    `# Starlink Dashboard\n\nBundled Windows x64 installer; no separate Python installation. Start on sign-in is opt-in.\n\n` +
    `Offline installer and installed desktop verified for commit ${offline.tested_sha}.\n\n` +
    `In-app updates verified from an updater-enabled ${upgrade.from_version} fixture to ${version}, including collector shutdown, relaunch, and retained history. CI uses an unattended NSIS install; the interactive wizard is not exercised.\n\n` +
    `Version 1.2.0 and earlier require one manual installation of this updater-enabled release. Their historical uninstaller may clear an enabled start-on-sign-in setting; re-enable it after that bootstrap installation if needed.\n\n` +
    `The app checks for newer releases, including prereleases, and asks before downloading and restarting to install. Windows builds remain unsigned: SHA512 verifies downloaded bytes against the feed, not publisher authenticity.\n\n` +
    `Live hardware observed ${hardware.observed_at}: ${hardware.dish.hardware}, firmware ${hardware.dish.firmware}.\n\n` +
    (hardware.limitations.length ? `## Acknowledged limitations\n\n${hardware.limitations.map((item) => `- ${item}`).join("\n")}\n` : "Owner hardware validation accepted.\n"));
  console.log(JSON.stringify(decision));
} catch (error) { console.error(`Release blocked: ${error.message}`); process.exitCode = 1; }
