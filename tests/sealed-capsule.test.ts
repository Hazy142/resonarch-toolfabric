import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {snapshotInputs} from "../src/runtime/sealedCapsule.js";

test("sealed input snapshot owns its bytes after live source changes", async () => {
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-"));const source=join(root,"source");await mkdir(source);
  await writeFile(join(source,"module.cjs"),"original");
  const digest=await snapshotInputs(source,join(root,"snapshot"));
  await writeFile(join(source,"module.cjs"),"changed");
  assert.equal(await readFile(join(root,"snapshot/module.cjs"),"utf8"),"original");
  assert.match(digest,/^sha256:[a-f0-9]{64}$/);
});

test("sealed snapshots reject an outside alias that resolves into live source", async () => {
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-alias-"));const source=join(root,"source");await mkdir(source);
  await writeFile(join(source,"module.cjs"),"unchanged");
  const alias=join(root,"outside-alias");await symlink(source,alias,process.platform==="win32"?"junction":"dir");
  await assert.rejects(snapshotInputs(source,alias),{code:"INVALID_CAPSULE_CONTEXT"});
  assert.equal(await readFile(join(source,"module.cjs"),"utf8"),"unchanged");
});
