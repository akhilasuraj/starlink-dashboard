const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateController, CHECK_INTERVAL_MS } = require("../updater");

function fixture() {
  const updater = new EventEmitter(), timeouts = new Map(), intervals = new Map();
  let timerId = 0, checks = 0, downloads = 0, requested = 0, installs = 0, failures = 0;
  updater.setFeedURL = (feed) => { updater.feed = feed; };
  updater.checkForUpdates = async () => { checks++; updater.emit("update-available", { version: "1.4.0" }); };
  updater.downloadUpdate = async () => { downloads++; };
  updater.quitAndInstall = () => { installs++; };
  const controller = createUpdateController({ updater, version: "1.3.0",
    onInstallRequested: () => { requested++; }, onInstallFailed: () => { failures++; }, timers: {
      setTimeout: (fn, delay) => { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (fn, delay) => { const id = ++timerId; intervals.set(id, { fn, delay }); return id; },
      clearInterval: (id) => intervals.delete(id),
    } });
  return { updater, controller, timeouts, intervals, counts: () => ({ checks, downloads, requested, installs, failures }) };
}

test("fixed repository discovery includes current prereleases without downloading or allowing downgrades", async () => {
  const f = fixture();
  assert.equal(f.updater.feed.provider, "github");
  assert.equal(f.updater.feed.owner, "akhilasuraj");
  assert.equal(f.updater.feed.repo, "starlink-dashboard");
  assert.equal(f.updater.allowPrerelease, true);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.disableWebInstaller, true);
  await f.controller.check();
  assert.equal(f.controller.snapshot().phase, "available");
  assert.equal(f.controller.snapshot().availableVersion, "1.4.0");
  assert.equal(f.counts().downloads, 0);
  assert.equal(f.counts().installs, 0);
});

test("progress and verified download require separate explicit restart, after collector shutdown", async () => {
  const f = fixture();
  f.controller.requestInstall();
  assert.equal(f.counts().requested, 0);
  await f.controller.check();
  await f.controller.download();
  await f.controller.download();
  assert.equal(f.counts().downloads, 1);
  f.updater.emit("download-progress", { percent: 55.5 });
  assert.equal(f.controller.snapshot().percent, 55.5);
  f.updater.emit("update-downloaded");
  assert.equal(f.controller.snapshot().phase, "downloaded");
  await f.controller.check();
  assert.equal(f.counts().checks, 1);
  f.controller.requestInstall();
  f.controller.requestInstall();
  assert.equal(f.counts().requested, 1);
  assert.equal(f.counts().installs, 0);
  f.controller.installAfterCollectorStopped();
  assert.equal(f.counts().installs, 1);
});

test("check/download failures stay retryable and installer failure resumes monitoring", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error("offline"); };
  assert.equal((await f.controller.check()).phase, "error");
  f.updater.checkForUpdates = async () => f.updater.emit("update-available", { version: "1.4.0" });
  await f.controller.check();
  f.updater.downloadUpdate = async () => { f.updater.emit("error", new Error("corrupt")); throw new Error("corrupt"); };
  assert.equal((await f.controller.download()).phase, "error");
  assert.equal(f.counts().installs, 0);
  await f.controller.check();
  f.updater.downloadUpdate = async () => f.updater.emit("update-downloaded");
  await f.controller.download();
  f.controller.requestInstall();
  f.updater.quitAndInstall = () => { throw new Error("installer unavailable"); };
  f.controller.installAfterCollectorStopped();
  assert.equal(f.counts().failures, 1);
  assert.equal(f.controller.snapshot().phase, "error");
});

test("automatic checks have one timer set and stop on shutdown; development makes no update calls", async () => {
  const f = fixture();
  f.controller.start(); f.controller.start();
  assert.equal(f.timeouts.size, 1); assert.equal(f.intervals.size, 1);
  assert.equal([...f.timeouts.values()][0].delay, 15000);
  assert.equal([...f.intervals.values()][0].delay, CHECK_INTERVAL_MS);
  await [...f.timeouts.values()][0].fn();
  assert.equal(f.counts().checks, 1);
  f.controller.stop();
  assert.equal(f.intervals.size, 0);
  const dev = createUpdateController({ updater: null, version: "1.3.0" });
  dev.start();
  assert.equal((await dev.check()).phase, "unsupported");
  assert.equal((await dev.download()).phase, "unsupported");
  assert.equal(dev.requestInstall().phase, "unsupported");
});
