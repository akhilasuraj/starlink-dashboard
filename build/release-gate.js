const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
  const decision = { allowed: true, prerelease, limitations: hardware.limitations };
  if (option("--notes-output")) fs.writeFileSync(option("--notes-output"),
    `# Starlink Dashboard\n\nBundled Windows x64 installer; no separate Python installation. Start on sign-in is opt-in.\n\n` +
    `Offline installer and installed desktop verified for commit ${offline.tested_sha}.\n\n` +
    `Live hardware observed ${hardware.observed_at}: ${hardware.dish.hardware}, firmware ${hardware.dish.firmware}.\n\n` +
    (hardware.limitations.length ? `## Acknowledged limitations\n\n${hardware.limitations.map((item) => `- ${item}`).join("\n")}\n` : "Owner hardware validation accepted.\n"));
  console.log(JSON.stringify(decision));
} catch (error) { console.error(`Release blocked: ${error.message}`); process.exitCode = 1; }
