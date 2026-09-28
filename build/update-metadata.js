const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

function validateUpdateMetadata({ metadataPath, installerPath, blockmapPath, version }) {
  if (!metadataPath || !blockmapPath) throw new Error("Update metadata and blockmap are required");
  const info = yaml.load(fs.readFileSync(metadataPath, "utf8"));
  const file = info?.files?.[0];
  const name = path.basename(installerPath);
  const bytes = fs.readFileSync(installerPath);
  const digest = crypto.createHash("sha512").update(bytes).digest("base64");
  if (info?.version !== version || !Array.isArray(info.files) || info.files.length !== 1 || info.packages ||
      file?.url !== name || file.size !== bytes.length || file.sha512 !== digest ||
      info.path !== name || info.sha512 !== digest) {
    throw new Error("Update metadata must match the exact tested installer version, filename, size and SHA-512");
  }
  if (path.basename(blockmapPath) !== `${name}.blockmap` || fs.statSync(blockmapPath).size === 0) {
    throw new Error("Matching nonempty installer blockmap required");
  }
  return { version, installer: name, sha512: digest };
}

module.exports = { validateUpdateMetadata };
