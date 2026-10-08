// Trusted image-baked collector. No model-selected path or executable.
const fs = require("node:fs");
const path = "/state/control/result.json";
try {
  const info = fs.lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || info.size > 4 * 1024 * 1024) throw new Error("INVALID_PRIVATE_RESULT");
  process.stdout.write(fs.readFileSync(path));
} catch (error) {
  if (error.code === "ENOENT") process.stdout.write(JSON.stringify({schema:"resonarch.toolfabric.capsule-result/v1",state:"incomplete"}));
  else {process.stderr.write(String(error));process.exitCode=125;}
}
