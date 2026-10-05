import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const runner = fileURLToPath(new URL("../../scripts/run-tests.mjs", import.meta.url));

test("compiled test runner explains when build output is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "toolfabric-run-tests-"));
  try {
    const result = spawnSync(process.execPath, [runner], {cwd, encoding: "utf8"});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /COMPILED_TESTS_MISSING: run npm run build first/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});
