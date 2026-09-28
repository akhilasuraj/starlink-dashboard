const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { validateUpdateMetadata } = require("../build/update-metadata");
const { writeUpdateMetadata } = require("./fixtures/update-artifact");

test("release metadata is bound to the tested version, filename, size and installer hash", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "starlink-update-metadata-"));
  try {
    const installerPath = path.join(directory, "Starlink.Dashboard.Setup.1.3.0.exe");
    fs.writeFileSync(installerPath, "fixture installer");
    const { metadata, metadataPath, blockmapPath } = writeUpdateMetadata(installerPath, "1.3.0");
    const args = { metadataPath, installerPath, blockmapPath, version: "1.3.0" };
    assert.equal(validateUpdateMetadata(args).version, "1.3.0");
    for (const mutate of [
      (info) => { info.version = "1.2.0"; },
      (info) => { info.files[0].url = "https://other.invalid/setup.exe"; },
      (info) => { info.files[0].size++; },
      (info) => { info.files[0].sha512 = "wrong"; },
      (info) => { info.path = "other.exe"; },
      (info) => { info.sha512 = "wrong"; },
      (info) => { info.files.push(info.files[0]); },
      (info) => { info.packages = { x64: {} }; },
    ]) {
      const changed = structuredClone(metadata); mutate(changed);
      fs.writeFileSync(metadataPath, yaml.dump(changed));
      assert.throws(() => validateUpdateMetadata(args), /exact tested installer/);
    }
    fs.writeFileSync(metadataPath, yaml.dump(metadata));
    fs.writeFileSync(installerPath, "tampered installer");
    assert.throws(() => validateUpdateMetadata(args), /exact tested installer/);
    fs.writeFileSync(installerPath, "fixture installer");
    fs.writeFileSync(blockmapPath, "");
    assert.throws(() => validateUpdateMetadata(args), /nonempty/);
    assert.throws(() => validateUpdateMetadata({ ...args, metadataPath: null }), /required/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
