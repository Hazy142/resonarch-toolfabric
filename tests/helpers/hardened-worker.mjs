import {readFile} from 'node:fs/promises';
import {DockerBackend} from '../../dist/src/runtime/dockerBackend.js';
import {HardenedJobRuntime} from '../../dist/src/runtime/hardenedJobRuntime.js';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const runtime=HardenedJobRuntime.open({backend:new DockerBackend(config.backend),state_directory:config.state_directory,
  artifact_directory:config.artifact_directory,namespace:config.namespace,signing_key:Buffer.alloc(32,9),capsules:[config.capsule],
  lease_ms:5000,authority:{capabilities:['test:run','process:host_execution','process:isolated_execution'],approved_refs:['approval:fixture']},
  on_phase:async phase=>{if(phase===config.pause_phase){process.stdout.write('READY:'+phase+'\n');await new Promise(()=>setInterval(()=>{},1000));}}});
try {const result=await runtime.run(config.operation,config.capsule,'approval:fixture');process.stdout.write(JSON.stringify(result)+'\n');}
finally{runtime.close();}
