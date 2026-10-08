import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";

const execFile = promisify(execFileCallback);

test("Windows process supervisor rejects malformed launch identity before creating a child", {skip: process.platform !== "win32"}, async () => {
  const host = resolve("dist/native/toolfabric-process-host.exe");
  assert.equal(existsSync(host), true, "Windows build must provide its process supervisor");
  await assert.rejects(execFile(host, ["invalid-identity", process.execPath, "-e", "process.exit(0)"], {windowsHide: true}),
    (error: any) => error.code === 125 && error.stderr.includes("TOOLFABRIC_PROCESS_HOST_ERROR"));
});
