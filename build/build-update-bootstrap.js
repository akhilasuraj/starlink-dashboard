// A disposable lower-version fixture of the current updater-enabled source.
// This is not a historical release, and is never uploaded or published.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requireDisposableUpdateRunner } = require("./disposable-update-runner");

try {
  requireDisposableUpdateRunner(); // Before changing versions or invoking a builder.
  const root = path.resolve(__dirname, "..");
  const files = ["package.json", "package-lock.json"].map((name) => path.join(root, name));
  const originals = files.map((file) => fs.readFileSync(file));
  try {
    for (let index = 0; index < files.length; index += 1) {
      const value = JSON.parse(originals[index]);
      value.version = "1.2.99";
      if (value.packages?.[""]) value.packages[""].version = value.version;
      fs.writeFileSync(files[index], JSON.stringify(value, null, 2) + "\n");
    }
    const result = spawnSync(process.execPath, [path.join(root, "node_modules/electron-builder/cli.js"),
      "--win", "--publish", "never", "-c.directories.output=dist/update-bootstrap"],
    { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw result.error || new Error(`Bootstrap build exited ${result.status}`);
  } finally {
    files.forEach((file, index) => fs.writeFileSync(file, originals[index]));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
