import {existsSync, readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";

const compiledTestDir = "dist/tests";
if (!existsSync(compiledTestDir)) {
  console.error("COMPILED_TESTS_MISSING: run npm run build first");
  process.exitCode = 1;
} else {
  const files = readdirSync(compiledTestDir)
    .filter(file => file.endsWith(".test.js"))
    .sort()
    .map(file => compiledTestDir + "/" + file);

  if (files.length === 0) {
    console.error("NO_COMPILED_TESTS");
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, ["--test", ...files], {stdio: "inherit"});
    if (result.error) {
      console.error("TEST_RUNNER_SPAWN_ERROR:" + result.error.message);
      process.exitCode = 1;
    } else if (result.signal) {
      console.error("TEST_RUNNER_SIGNAL:" + result.signal);
      process.exitCode = 1;
    } else if (result.status === null) {
      console.error("TEST_RUNNER_EXIT_STATUS_UNKNOWN");
      process.exitCode = 1;
    } else {
      process.exitCode = result.status;
    }
  }
}
