const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const { NsisUpdater } = require("electron-updater");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { createUpdateController } = require("../updater");

// Real updater and hashing over loopback; these bytes are never executed.
class FixtureHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    assert.equal(options.hostname, "127.0.0.1");
    return http.request(options, callback);
  }
}

test("actual GitHub provider discovers a prerelease with a stable-semver tag through latest.yml", async () => {
  const requested = [];
  const provider = new GitHubProvider({ provider: "github", owner: "akhilasuraj", repo: "starlink-dashboard" },
    { allowPrerelease: true, currentVersion: require("semver").parse("1.3.0"), fullChangelog: false },
    { platform: "win32", executor: { request: async options => {
      requested.push(options.path);
      assert.equal(options.hostname, "github.com");
      if (options.path.endsWith("releases.atom")) return '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Preview 1.4.0</title><link href="https://github.com/akhilasuraj/starlink-dashboard/releases/tag/v1.4.0"/><content>Fixture preview release</content></entry><entry><title>Old stable</title><link href="https://github.com/akhilasuraj/starlink-dashboard/releases/tag/v1.0.2"/><content>Fixture stable release</content></entry></feed>';
      assert.equal(options.path, "/akhilasuraj/starlink-dashboard/releases/download/v1.4.0/latest.yml");
      return yaml.dump({ version: "1.4.0", files: [{ url: "fixture.exe", sha512: "fixture-hash" }], path: "fixture.exe", sha512: "fixture-hash" });
    } } });
  assert.equal((await provider.getLatestVersion()).version, "1.4.0");
  assert.equal(requested.length, 2);
});

test("real NSIS updater downloads verified bytes, rejects corruption, and excludes equal/older versions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-update-download-"));
  const bytes = Buffer.alloc(160000, "a"), corrupt = Buffer.alloc(bytes.length, "b");
  let advertisedVersion = "1.4.0", serveCorrupt = false, installerRequests = 0;
  const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  const server = http.createServer((request, response) => {
    if (request.url.split("?")[0] === "/latest.yml") {
      response.end(yaml.dump({ version: advertisedVersion, files: [{ url: "fixture.exe", size: bytes.length, sha512 }], path: "fixture.exe", sha512 }));
    } else if (request.url === "/fixture.exe") {
      installerRequests++;
      response.writeHead(200, { "Content-Length": bytes.length }); response.end(serveCorrupt ? corrupt : bytes);
    } else { response.writeHead(404); response.end(); }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    function client(name) {
      const userDataPath = path.join(directory, name);
      fs.mkdirSync(userDataPath);
      const appUpdateConfigPath = path.join(userDataPath, "app-update.yml");
      fs.writeFileSync(appUpdateConfigPath, yaml.dump({ updaterCacheDirName: name }));
      const updater = new NsisUpdater(null, { version: "1.3.0", name, isPackaged: true,
        userDataPath, baseCachePath: directory, appUpdateConfigPath, whenReady: async () => {},
        onQuit: () => {}, quit: () => assert.fail("test must never install or quit") });
      updater.httpExecutor = new FixtureHttpExecutor();
      updater.logger = null;
      const errors = [];
      updater.on("error", error => errors.push(error.stack));
      updater.disableDifferentialDownload = true;
      updater._testOnlyOptions = { platform: "win32" };
      const controller = createUpdateController({ updater, version: "1.3.0",
        onInstallRequested: () => assert.fail("no installation requested"), onInstallFailed: () => {} });
      updater.setFeedURL({ provider: "generic", url }); // Test transport only; production feed is fixed.
      return { updater, controller, errors };
    }
    const good = client("good");
    assert.equal((await good.controller.check()).phase, "available");
    assert.equal(installerRequests, 0);
    assert.equal((await good.controller.download()).phase, "downloaded", good.errors.join("\n"));
    assert.deepEqual(fs.readFileSync(good.updater.installerPath), bytes);
    serveCorrupt = true;
    const bad = client("corrupt");
    await bad.controller.check();
    assert.equal((await bad.controller.download()).phase, "error");
    assert.equal(bad.updater.installerPath, null);
    for (const version of ["1.3.0", "1.2.0"]) {
      advertisedVersion = version;
      const current = client(version);
      assert.equal((await current.controller.check()).phase, "current");
      await current.controller.download();
    }
    assert.equal(installerRequests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
