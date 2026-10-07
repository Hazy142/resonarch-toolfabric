import {existsSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";

if (process.platform === "win32") {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const compiler = ["Framework64", "Framework"].map(arch =>
    join(windows, "Microsoft.NET", arch, "v4.0.30319", "csc.exe")).find(existsSync);
  if (!compiler) throw new Error("WINDOWS_PROCESS_HOST_COMPILER_MISSING");
  mkdirSync("dist/native", {recursive: true});
  const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:anycpu", "/optimize+",
    `/out:${resolve("dist/native/toolfabric-process-host.exe")}`, resolve("src/runtime/windowsProcessHost.cs")],
    {stdio: "inherit", windowsHide: true, timeout: 30_000, shell: false});
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) throw new Error("WINDOWS_PROCESS_HOST_BUILD_FAILED");
}
