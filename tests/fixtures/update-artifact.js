const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

function writeUpdateMetadata(installer, version) {
  const bytes = fs.readFileSync(installer);
  const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  const name = path.basename(installer);
  const metadata = { version, files: [{ url: name, sha512, size: bytes.length }], path: name, sha512 };
  const metadataPath = path.join(path.dirname(installer), "latest.yml");
  const blockmapPath = `${installer}.blockmap`;
  fs.writeFileSync(metadataPath, yaml.dump(metadata));
  fs.writeFileSync(blockmapPath, "explicit blockmap fixture; download tests use full files");
  return { metadata, metadataPath, blockmapPath };
}
module.exports = { writeUpdateMetadata };
