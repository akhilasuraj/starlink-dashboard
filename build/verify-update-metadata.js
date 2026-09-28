const path = require("node:path");
const { validateUpdateMetadata } = require("./update-metadata");
const version = require("../package.json").version;
const installer = path.join("dist", `Starlink.Dashboard.Setup.${version}.exe`);
console.log(validateUpdateMetadata({ metadataPath: path.join("dist", "latest.yml"), installerPath: installer,
  blockmapPath: `${installer}.blockmap`, version }));
