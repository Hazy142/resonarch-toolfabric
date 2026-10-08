import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rename,symlink,writeFile} from "node:fs/promises";
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

test("sealed snapshot pins directories against replacement by an outside junction or symlink",async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-race-dir-"));const source=join(root,"source"),outside=join(root,"outside");
  await mkdir(join(source,"nested"),{recursive:true});await mkdir(outside);
  await writeFile(join(source,"nested/sentinel.txt"),"approved original");await writeFile(join(outside,"sentinel.txt"),"OUTSIDE SECRET");
  let checked=false;
  await snapshotInputs(source,join(root,"snapshot"),{on_entry_opened:async(path,kind)=>{
    if(path!=="nested"||kind!=="directory")return;checked=true;
    try{await rename(join(source,"nested"),join(source,"original"));}
    catch(error){assert.ok(["EACCES","EPERM","EBUSY"].includes((error as NodeJS.ErrnoException).code??""));return;}
    await symlink(outside,join(source,"nested"),process.platform==="win32"?"junction":"dir");
  }});
  assert.equal(checked,true);assert.equal(await readFile(join(root,"snapshot/nested/sentinel.txt"),"utf8"),"approved original");
});

test("sealed snapshot pins regular files against replacement by an outside symlink",{skip:process.platform==="win32"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-race-file-"));const source=join(root,"source");await mkdir(source);
  await writeFile(join(source,"sentinel.txt"),"approved original");await writeFile(join(root,"outside.txt"),"OUTSIDE SECRET");
  let checked=false;
  await snapshotInputs(source,join(root,"snapshot"),{on_entry_opened:async(path,kind)=>{
    if(path!=="sentinel.txt"||kind!=="file")return;checked=true;
    await rename(join(source,path),join(source,"original"));await symlink(join(root,"outside.txt"),join(source,path));
  }});
  assert.equal(checked,true);assert.equal(await readFile(join(root,"snapshot/sentinel.txt"),"utf8"),"approved original");
});

test("sealed snapshot never traverses a replaced source ancestor",async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-race-root-"));const source=join(root,"source"),outside=join(root,"outside");
  await mkdir(join(source,"nested"),{recursive:true});await mkdir(join(outside,"nested"),{recursive:true});
  await writeFile(join(source,"nested/sentinel.txt"),"approved original");await writeFile(join(outside,"nested/sentinel.txt"),"OUTSIDE SECRET");
  let checked=false;
  await snapshotInputs(source,join(root,"snapshot"),{on_entry_opened:async(path,kind)=>{
    if(path!=="nested"||kind!=="directory")return;checked=true;
    try{await rename(source,join(root,"original"));}
    catch(error){assert.ok(["EACCES","EPERM","EBUSY"].includes((error as NodeJS.ErrnoException).code??""));return;}
    await symlink(outside,source,process.platform==="win32"?"junction":"dir");
  }});
  assert.equal(checked,true);assert.equal(await readFile(join(root,"snapshot/nested/sentinel.txt"),"utf8"),"approved original");
});

test("sealed Windows copier pins files against concurrent replacement",{skip:process.platform!=="win32"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-file-lock-"));const source=join(root,"source");await mkdir(source);
  await writeFile(join(source,"sentinel.txt"),"approved original");let blocked=false;
  await snapshotInputs(source,join(root,"snapshot"),{on_entry_opened:async(path,kind)=>{
    if(path!=="sentinel.txt"||kind!=="file")return;
    await assert.rejects(rename(join(source,path),join(source,"original")),error=>["EACCES","EPERM","EBUSY"].includes((error as NodeJS.ErrnoException).code??""));blocked=true;
  }});
  assert.equal(blocked,true);assert.equal(await readFile(join(root,"snapshot/sentinel.txt"),"utf8"),"approved original");
});

test("sealed snapshot bounds actual bytes even when an opened Linux file grows",{skip:process.platform!=="linux"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-growing-"));const source=join(root,"source");await mkdir(source);await writeFile(join(source,"growing.txt"),"a");
  let checked=false;
  await assert.rejects(snapshotInputs(source,join(root,"snapshot"),{max_input_bytes:32,on_entry_opened:async()=>{checked=true;await writeFile(join(source,"growing.txt"),"a".repeat(33));}}),{code:"CAPSULE_INPUT_LIMIT"});
  assert.equal(checked,true);
});

test("sealed snapshots reject existing input links and enforce a reduced host byte limit",async()=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-seal-denial-"));const source=join(root,"source"),outside=join(root,"outside");
  await mkdir(source);await mkdir(outside);await writeFile(join(outside,"secret.txt"),"OUTSIDE SECRET");
  await symlink(outside,join(source,"linked"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(snapshotInputs(source,join(root,"denied")),error=>/CAPSULE_(SYMLINK_FORBIDDEN|INPUT_OPEN_FAILED)/.test((error as any).code));
  const regular=join(root,"regular");await mkdir(regular);await writeFile(join(regular,"large.txt"),"a".repeat(33));
  await assert.rejects(snapshotInputs(regular,join(root,"limited"),{max_input_bytes:32}),{code:"CAPSULE_INPUT_LIMIT"});
});
