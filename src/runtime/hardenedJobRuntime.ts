import {randomUUID,createHmac} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {OperationJournal,type OperationLease,type JournalRecord} from "../evidence/operationJournal.js";
import {createReceipt,verifyChain,type Receipt} from "../evidence/receipt.js";
import {canonicalDigest,canonicalJson,sha256} from "../contracts/canonical.js";
import type {DockerBackend} from "./dockerBackend.js";
import {verifyCapsule,type SealedCapsule} from "./sealedCapsule.js";
import {RuntimeExecutionError} from "./errors.js";
import type {MutationAuthority} from "./writePlane.js";
export type HardenedPhase="intent_committed"|"backend_created"|"backend_started"|"result_collected"|"before_publish"|"published";
export interface HardenedJobOptions {
  backend:DockerBackend;state_directory:string;artifact_directory:string;namespace:string;signing_key:Uint8Array;
  lease_ms?:number;max_attempts?:number;on_phase?:(phase:HardenedPhase,record:JournalRecord)=>void|Promise<void>;
  capsules:readonly SealedCapsule[];authority:MutationAuthority;
}
export class HardenedJobRuntime {
  readonly journal:OperationJournal;
  private readonly owner=randomUUID();
  private readonly pending=new Map<string,Promise<any>>();
  private readonly active=new Set<string>();
  private readonly approvedCapsules:Map<string,string>;
  private readonly capabilities:Set<string>;
  private readonly approvals:Set<string>;
  private constructor(private readonly options:HardenedJobOptions){
    if(!Array.isArray(options.capsules)||options.capsules.length>64||new Set(options.capsules.map(c=>c.digest)).size!==options.capsules.length)throw new RuntimeExecutionError("INVALID_CAPSULE_REGISTRY","host must register unique sealed capsules","denied");
    this.approvedCapsules=new Map(options.capsules.map(c=>[c.digest,canonicalJson(c)]));
    this.capabilities=new Set(options.authority.capabilities);this.approvals=new Set(options.authority.approved_refs??[]);
    this.journal=OperationJournal.open({directory:options.state_directory,namespace:options.namespace,signing_key:options.signing_key});
  }
  static open(options:HardenedJobOptions){return new HardenedJobRuntime(options);}
  async run(operation:string,capsule:SealedCapsule,approvalRef?:string):Promise<any> {
    for(const capability of ["test:run","process:host_execution","process:isolated_execution"])if(!this.capabilities.has(capability))throw new RuntimeExecutionError("CAPABILITY_DENIED","missing host capability: "+capability,"denied");
    if(!approvalRef)throw new RuntimeExecutionError("APPROVAL_REQUIRED","isolated job requires host-approved reference","denied");
    if(!this.approvals.has(approvalRef))throw new RuntimeExecutionError("APPROVAL_DENIED","approval is not host-owned","denied");
    if(this.approvedCapsules.get(capsule.digest)!==canonicalJson(capsule))throw new RuntimeExecutionError("CAPSULE_NOT_REGISTERED","capsule was not registered by the host or was changed","denied");
    const semantic=canonicalDigest({operation,capsule_digest:capsule.digest,namespace:this.options.namespace});
    const existing=this.journal.reserve(operation,semantic,{capsule,attempt:0});
    if(existing.record.state==="published")return {...existing.record.result,replayed:true,publication_count:1};
    if(this.pending.has(operation))return this.pending.get(operation)!;
    const pending=this.execute(operation,capsule);this.pending.set(operation,pending);
    try{return await pending;}finally{this.pending.delete(operation);}
  }
  private async phase(phase:HardenedPhase,operation:string) {
    if(this.options.on_phase)await this.options.on_phase(phase,this.journal.get(operation)!);
  }
  private authority(operation:string):string {
    return createHmac("sha256",this.options.signing_key).update(this.backendOperation(operation)).digest("hex");
  }
  private backendOperation(operation:string):string{return canonicalDigest({journal_id:this.journal.identity,namespace:this.options.namespace,operation});}
  private labels(operation:string,capsule:SealedCapsule,attempt:number,role="job"):Record<string,string> {
    return {"org.resonarch.tf.authority":this.authority(operation),"org.resonarch.tf.operation":this.backendOperation(operation),
      "org.resonarch.tf.capsule":capsule.digest,"org.resonarch.tf.attempt":String(attempt),"org.resonarch.tf.role":role};
  }
  private labelArgs(labels:Record<string,string>):string[] {return Object.entries(labels).flatMap(([key,value])=>["--label",key+"="+value]);}
  private validateOwned(container:any,operation:string,capsule:SealedCapsule,attempt:number):void {
    const expected=this.labels(operation,capsule,attempt);
    for(const [key,value]of Object.entries(expected))if(container.Config?.Labels?.[key]!==value)throw new RuntimeExecutionError("CONTAINER_IDENTITY_CONFLICT","container is not owned by this operation","denied");
    const config=container.HostConfig;
    const caps=["SETUID","SETGID","CHOWN","DAC_READ_SEARCH","KILL"].sort();
    const tmpfs={"/tmp":"rw,noexec,nosuid,nodev,size=16777216,mode=1777","/output":"rw,noexec,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700"};
    if(container.Image!==capsule.image_id||config.NetworkMode!=="none"||!config.ReadonlyRootfs||config.Privileged
      ||config.PidMode||config.IpcMode!=="private"||!config.CapDrop?.includes("ALL")
      ||!config.SecurityOpt?.some((value:string)=>value.startsWith("no-new-privileges"))
      ||canonicalDigest([...(config.CapAdd??[])].map((cap:string)=>cap.replace(/^CAP_/,"")).sort())!==canonicalDigest(caps)
      ||canonicalDigest(config.Tmpfs)!==canonicalDigest(tmpfs)||config.PidsLimit!==64||config.Memory!==268435456||config.NanoCpus!==1000000000
      ||container.Mounts.length!==1||container.Mounts.some((mount:any)=>mount.Type!=="volume"||mount.Destination!=="/state")) {
      throw new RuntimeExecutionError("ISOLATION_POLICY_DRIFT","container isolation policy differs from approved profile","denied");
    }
  }
  private async ensureVolume(name:string,operation:string,capsule:SealedCapsule,attempt:number):Promise<void> {
    const labels=this.labels(operation,capsule,attempt,"state");
    await this.options.backend.command(["volume","create",...this.labelArgs(labels),name]);
    const volume=JSON.parse(await this.options.backend.command(["volume","inspect",name]))[0];
    for(const [key,value]of Object.entries(labels))if(volume.Labels?.[key]!==value)throw new RuntimeExecutionError("VOLUME_IDENTITY_CONFLICT","state volume is not owned","denied");
  }
  private async readResult(volume:string,operation:string,capsule:SealedCapsule,attempt:number):Promise<any> {
    const reader="tf-reader-"+randomUUID();
    const result=await this.options.backend.command(["run","--rm","--name",reader,...this.labelArgs(this.labels(operation,capsule,attempt,"reader")),
      "--network=none","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges","--ipc=private","--pids-limit=16",
      "--memory=128m","--mount",`type=volume,source=${volume},target=/state,readonly`,
      "--entrypoint","/usr/local/bin/node",capsule.image_id,"/broker/capsuleReader.cjs"],30000);
    const body=JSON.parse(result);
    if(body.state!=="incomplete"&&(body.operation_key!==this.backendOperation(operation)||body.capsule_digest!==capsule.digest||body.attempt!==attempt)) {
      throw new RuntimeExecutionError("CAPSULE_RESULT_IDENTITY_MISMATCH","private result belongs to another operation","denied");
    }
    return body;
  }
  private async execute(operation:string,capsule:SealedCapsule):Promise<any> {
    await verifyCapsule(this.options.backend,capsule);
    let lease:OperationLease;
    const ownershipUntil=Date.now()+180000;
    while(true) {
      try {lease=this.journal.claim(operation,this.owner,this.options.lease_ms??30000);break;}
      catch(error) {
        const observed=this.journal.get(operation)!;
        if(observed.state==="published")return {...observed.result,publication_count:1,replayed:true};
        if(!(error instanceof RuntimeExecutionError)||error.code!=="OPERATION_LEASE_HELD"||Date.now()>=ownershipUntil)throw error;
        await delay(100);
      }
    }
    const maximum=this.options.max_attempts??2;
    if(!Number.isInteger(maximum)||maximum<1||maximum>3)throw new RuntimeExecutionError("INVALID_RETRY_BUDGET","safe attempt budget is 1..3","denied");
    try {
      for(let remaining=maximum;remaining>0;remaining--) {
        let record=this.journal.get(operation)!;
        const attempt=Number(record.payload.attempt??0);
        if(attempt>=maximum)throw new RuntimeExecutionError("ISOLATED_RETRY_BUDGET_EXCEEDED","isolated retry budget exhausted");
        const stem="tf-job-"+this.backendOperation(operation).slice(7)+"-"+attempt;
        const volume=stem+"-state";
        if(!record.payload.intent_receipt) {
          const intent=createReceipt({schema:"resonarch.toolfabric.receipt/v1",receipt_id:operation+":intent",trace_id:sha256(operation),task_id:operation,
            call_id:operation,tool_id:"test.run",tool_version:"2.0.0",request_digest:record.semantic_digest,result_digest:capsule.digest,
            side_effect:"process",status:"intent",phase:"intent",previous_receipt_hash:"sha256:GENESIS",artifact_refs:[],
            execution_profile:"isolated-linux-capsule",operation_key:operation});
          this.journal.update(operation,lease,"prepared",{intent_receipt:intent});
          await this.phase("intent_committed",operation);
        }
        record=this.journal.get(operation)!;
        if(record.payload.container_name!==stem) {
          this.journal.update(operation,lease,"prepared",{container_name:stem,volume_name:volume,attempt,
            expiry:Date.now()+Number(capsule.recipe.max_runtime_ms??10000)+15000});
        }
        lease=this.journal.renew(operation,lease,this.options.lease_ms??30000);
        await this.ensureVolume(volume,operation,capsule,attempt);
        let container=await this.options.backend.inspectContainer(stem);
        if(!container) {
          const labels=this.labels(operation,capsule,attempt);
          const expiry=Number(this.journal.get(operation)!.payload.expiry);
          await this.options.backend.command(["create","--name",stem,...this.labelArgs(labels),"--network=none","--read-only",
            "--cap-drop=ALL","--cap-add=SETUID","--cap-add=SETGID","--cap-add=CHOWN","--cap-add=DAC_READ_SEARCH","--cap-add=KILL",
            "--security-opt=no-new-privileges","--ipc=private","--pids-limit=64","--memory=256m","--cpus=1",
            "--log-opt=max-size=1m","--log-opt=max-file=1","--mount",`type=volume,source=${volume},target=/state`,
            "--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777",
            "--tmpfs","/output:rw,noexec,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700",
            "--env","TF_OPERATION="+this.backendOperation(operation),"--env","TF_CAPSULE="+capsule.digest,"--env","TF_ATTEMPT="+attempt,
            "--env","TF_EXPIRY="+expiry,capsule.image_id]);
          container=await this.options.backend.inspectContainer(stem);
        }
        this.validateOwned(container,operation,capsule,attempt);
        lease=this.journal.renew(operation,lease,this.options.lease_ms??30000);
        this.journal.update(operation,lease,"prepared",{container_id:container.Id});
        await this.phase("backend_created",operation);
        if(container.State.Status==="created") {
          this.journal.update(operation,lease,"started",{});
          await this.options.backend.command(["start",container.Id]);
        }
        this.active.add(container.Id);
        await this.phase("backend_started",operation);
        const until=Number(this.journal.get(operation)!.payload.expiry)+10000;
        let renewed=Date.now();
        while(Date.now()<until) {
          container=await this.options.backend.inspectContainer(container.Id);
          if(!container)throw new RuntimeExecutionError("OWNED_CONTAINER_MISSING","owned container disappeared");
          this.validateOwned(container,operation,capsule,attempt);
          if(!container.State.Running)break;
          if(Date.now()-renewed>(this.options.lease_ms??30000)/3){lease=this.journal.renew(operation,lease,this.options.lease_ms??30000);renewed=Date.now();}
          await delay(100);
        }
        if(container.State.Running) {
          await this.options.backend.command(["kill",container.Id]);
          container=await this.options.backend.inspectContainer(container.Id);
          if(container?.State.Running)throw new RuntimeExecutionError("ISOLATION_TERMINATION_UNCONFIRMED","owned PID namespace still running");
        }
        this.active.delete(container.Id);
        lease=this.journal.renew(operation,lease,this.options.lease_ms??30000);
        const execution=await this.readResult(volume,operation,capsule,attempt);
        await this.phase("result_collected",operation);
        if(execution.state==="incomplete"||execution.state==="uncertain") {
          this.journal.update(operation,lease,"uncertain",{attempt:attempt+1,last_attempt_reason:execution.reason??"BROKER_INTERRUPTED"});
          continue; // Only after inspected non-running namespace; all provisional effects remain private.
        }
        const artifacts:string[]=[];
        const stdout=this.journal.putArtifact(Buffer.from(execution.stdout_base64??"","base64"));artifacts.push(stdout);
        const stderr=this.journal.putArtifact(Buffer.from(execution.stderr_base64??"","base64"));artifacts.push(stderr);
        const files=[];
        for(const file of execution.files??[]) {
          const bytes=Buffer.from(file.base64,"base64");
          if(sha256(bytes)!==file.sha256||file.path.startsWith("/")||file.path.split(/[\\/]/).includes(".."))throw new RuntimeExecutionError("UNSAFE_OUTPUT_FILE","invalid sealed output");
          const ref=this.journal.putArtifact(bytes);artifacts.push(ref);files.push({path:file.path,artifact_ref:ref,sha256:file.sha256});
        }
        const status=execution.state==="cancelled"?"cancelled":execution.state==="completed"&&execution.application_exit_code===0?"succeeded":"failed";
        const outcome={status,operation_key:operation,capsule_digest:capsule.digest,image_id:capsule.image_id,backend_identity:capsule.backend,
          execution:{...execution,stdout_base64:undefined,stderr_base64:undefined,files:undefined},stdout_ref:stdout,stderr_ref:stderr,files,artifacts};
        const resultDigest=canonicalDigest(outcome);
        const intent=this.journal.get(operation)!.payload.intent_receipt as Receipt;
        const completion=createReceipt({schema:"resonarch.toolfabric.receipt/v1",receipt_id:operation+":completion",trace_id:sha256(operation),task_id:operation,
          call_id:operation,tool_id:"test.run",tool_version:"2.0.0",request_digest:record.semantic_digest,result_digest:resultDigest,
          side_effect:"process",status,phase:"completion",previous_receipt_hash:intent.receipt_hash,artifact_refs:artifacts,
          execution_profile:"isolated-linux-capsule",operation_key:operation});
        const result={...outcome,result_digest:resultDigest,receipts:[intent,completion]};
        if(!verifyChain(result.receipts))throw new RuntimeExecutionError("DURABLE_RECEIPT_CHAIN_INVALID","publication receipt chain is invalid");
        await this.phase("before_publish",operation);
        const published=this.journal.publish(operation,lease,result);
        await this.phase("published",operation);
        return {...published.result,publication_count:1,replayed:false};
      }
      throw new RuntimeExecutionError("ISOLATED_RETRY_BUDGET_EXCEEDED","isolated attempts did not produce a confirmed result");
    } catch(error) {
      try {if(this.journal.get(operation)?.state!=="published")this.journal.update(operation,lease,"uncertain",{last_error:error instanceof Error?error.message:String(error)});}catch{}
      throw error;
    }
  }
  readArtifact(operation:string,ref:string):Uint8Array{return this.journal.getArtifact(operation,ref);}
  async cleanup(operation:string,capsule:SealedCapsule):Promise<void> {
    const record=this.journal.get(operation);
    if(record?.state!=="published")throw new RuntimeExecutionError("OPERATION_NOT_PUBLISHED","cleanup requires a durable published result","denied");
    const id=record.payload.container_id as string|undefined;
    if(id) {
      const container=await this.options.backend.inspectContainer(id);
      if(container) {
        this.validateOwned(container,operation,capsule,Number(record.payload.attempt));
        if(container.State.Running)throw new RuntimeExecutionError("PUBLISHED_CONTAINER_STILL_RUNNING","published namespace is not quiescent","denied");
        await this.options.backend.command(["rm",container.Id]);
      }
    }
    const volume=record.payload.volume_name as string|undefined;
    if(volume) {
      let object:any;
      try{object=JSON.parse(await this.options.backend.command(["volume","inspect",volume]))[0];}
      catch(error){if(error instanceof RuntimeExecutionError&&/No such volume/i.test(error.message))return;throw error;}
      for(const [key,value]of Object.entries(this.labels(operation,capsule,Number(record.payload.attempt),"state"))) {
        if(object.Labels?.[key]!==value)throw new RuntimeExecutionError("VOLUME_IDENTITY_CONFLICT","cleanup target is not owned","denied");
      }
      await this.options.backend.command(["volume","rm",volume]);
    }
  }
  close(){this.journal.close();}
}
