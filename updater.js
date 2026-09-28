const FEED = Object.freeze({ provider: "github", owner: "akhilasuraj", repo: "starlink-dashboard" });
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The renderer sees a small state snapshot; it cannot choose a feed or installer.
function createUpdateController({ updater, version, onInstallRequested, onInstallFailed,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  let state = { supported: !!updater, currentVersion: version, phase: updater ? "idle" : "unsupported",
    availableVersion: null, percent: null, checkedAt: null, message: updater
      ? "Updates are checked automatically. Prerelease versions are included."
      : "Updates are available in the installed Windows app." };
  let startupTimer = null, checkTimer = null;
  const snapshot = () => ({ ...state });
  const change = (phase, message, extra = {}) => { state = { ...state, phase, message, ...extra }; };
  function fail() {
    const installing = state.phase === "installing";
    const downloading = state.phase === "downloading";
    change("error", installing ? "Could not start the update installer. Monitoring has resumed; try again."
      : downloading ? "Download failed. Keep using the app and check again to retry."
      : "Could not check for updates. Keep using the app and try again later.", { percent: null });
    if (installing) onInstallFailed();
  }
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = true;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.setFeedURL(FEED);
    updater.on("update-available", (info) => {
      if (state.phase === "checking") change("available", `Version ${info.version} is available.`,
        { availableVersion: info.version, checkedAt: new Date().toISOString(), percent: null });
    });
    updater.on("update-not-available", () => {
      if (state.phase === "checking") change("current", "You are using the newest available version.",
        { availableVersion: null, checkedAt: new Date().toISOString(), percent: null });
    });
    updater.on("download-progress", (progress) => {
      if (state.phase !== "downloading") return;
      const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
      change("downloading", `Downloading version ${state.availableVersion} — ${Math.round(percent)}%.`, { percent });
    });
    updater.on("update-downloaded", () => {
      if (state.phase === "downloading") change("downloaded", "Update downloaded. Restart when you are ready to install.", { percent: 100 });
    });
    updater.on("error", fail);
  }
  async function check() {
    if (!updater || ["checking", "downloading", "downloaded", "installing"].includes(state.phase)) return snapshot();
    change("checking", "Checking for updates…", { availableVersion: null, percent: null });
    try { await updater.checkForUpdates(); } catch { if (state.phase !== "error") fail(); }
    return snapshot();
  }
  async function download() {
    if (!updater || state.phase !== "available") return snapshot();
    change("downloading", `Downloading version ${state.availableVersion}…`, { percent: 0 });
    try { await updater.downloadUpdate(); } catch { if (state.phase !== "error") fail(); }
    return snapshot();
  }
  function requestInstall() {
    if (!updater || state.phase !== "downloaded") return snapshot();
    change("installing", "Stopping monitoring before restarting to install…");
    onInstallRequested();
    return snapshot();
  }
  // Called by the main process only after its collector has exited.
  function installAfterCollectorStopped() {
    if (!updater || state.phase !== "installing") return;
    try { updater.quitAndInstall(false, true); } catch { fail(); }
  }
  function stop() {
    if (startupTimer !== null) timers.clearTimeout(startupTimer);
    if (checkTimer !== null) timers.clearInterval(checkTimer);
    startupTimer = checkTimer = null;
  }
  function start() {
    if (!updater || checkTimer !== null) return;
    startupTimer = timers.setTimeout(() => { startupTimer = null; check(); }, 15000);
    checkTimer = timers.setInterval(check, CHECK_INTERVAL_MS);
  }
  return { snapshot, check, download, requestInstall, installAfterCollectorStopped, start, stop };
}

module.exports = { createUpdateController, CHECK_INTERVAL_MS };
