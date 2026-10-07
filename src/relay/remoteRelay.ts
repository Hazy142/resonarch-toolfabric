import {randomUUID} from "node:crypto";

export const REMOTE_RELAY_REQUEST_SCHEMA="resonarch.toolfabric.remote-relay.request/v1";
export const REMOTE_RELAY_RESPONSE_SCHEMA="resonarch.toolfabric.remote-relay.response/v1";
export const REMOTE_RELAY_LIFECYCLE_SCHEMA="resonarch.toolfabric.remote-relay.lifecycle/v1";

const MAX_ENDPOINT_CHARS=2048;
const MAX_PAYLOAD_BYTES=1024*1024;
const MAX_IN_FLIGHT=64;
const MAX_QUEUE=256;
const MAX_SESSION_REQUESTS=4096;
const MAX_TIMEOUT_MS=120_000;
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
const LOOPBACK=new Set(["localhost","127.0.0.1","::1"]);
const ERROR_CODES=["INVALID_ENVELOPE","UNSUPPORTED_VERSION","INVALID_CONFIG","RELAY_DISABLED","RELAY_OFFLINE","DUPLICATE_REQUEST_ID","REQUEST_BUDGET_EXCEEDED","QUEUE_FULL","IN_FLIGHT_LIMIT","TIMEOUT","CANCELLED","DISCONNECTED","STALE_SESSION","CORRELATION_MISMATCH","PAYLOAD_TOO_LARGE","INVALID_CREDENTIAL","REMOTE_ERROR"] as const;
export type RemoteRelayErrorCode=typeof ERROR_CODES[number];
type LifecycleState="connected"|"disconnected"|"cancelled"|"timed_out";

export class RemoteRelayError extends Error{
  constructor(readonly code:RemoteRelayErrorCode){
    super(code);
    this.name="RemoteRelayError";
  }
}

export interface RemoteRelayConfig{
  enabled:boolean;
  endpoint?:string;
  route_id?:string;
  allow_loopback?:boolean;
  max_payload_bytes?:number;
  max_in_flight?:number;
  max_queue?:number;
}

export const DEFAULT_REMOTE_RELAY_CONFIG:Readonly<RemoteRelayConfig>=Object.freeze({enabled:false});

export interface RemoteRelayRequest{
  schema:typeof REMOTE_RELAY_REQUEST_SCHEMA;
  kind:"request";
  route_id:string;
  session_id:string;
  request_id:string;
  payload:unknown;
}

export interface RemoteRelayResponse{
  schema:typeof REMOTE_RELAY_RESPONSE_SCHEMA;
  kind:"response";
  route_id:string;
  session_id:string;
  request_id:string;
  ok:boolean;
  payload?:unknown;
  error?:{code:string;message:string};
}

export interface RemoteRelayLifecycle{
  schema:typeof REMOTE_RELAY_LIFECYCLE_SCHEMA;
  kind:"lifecycle";
  route_id:string;
  session_id:string;
  state:LifecycleState;
  request_id?:string;
}

export type RemoteRelayEnvelope=RemoteRelayRequest|RemoteRelayResponse|RemoteRelayLifecycle;

export interface RelayConnection{
  endpoint:string;
  route_id:string;
  session_id:string;
  credential:string;
}

export interface RemoteRelayTransport{
  connect(connection:RelayConnection):Promise<void>;
  send(request:RemoteRelayRequest,signal:AbortSignal):Promise<unknown>;
  disconnect(connection:Omit<RelayConnection,"credential">):Promise<void>|void;
  lifecycle?(event:RemoteRelayLifecycle):void;
}

export type RelayCredentialProvider=()=>string|undefined|Promise<string|undefined>;

function fail(code:RemoteRelayErrorCode):never{
  throw new RemoteRelayError(code);
}

function validId(value:unknown):value is string{
  return typeof value==="string"&&ID.test(value);
}

function integer(value:unknown,min:number,max:number):value is number{
  return Number.isInteger(value)&&Number(value)>=min&&Number(value)<=max;
}

function assertJsonValue(value:unknown,seen=new Set<object>(),depth=0):void{
  if(depth>64)fail("INVALID_ENVELOPE");
  if(value===null||typeof value==="string"||typeof value==="boolean")return;
  if(typeof value==="number"&&Number.isFinite(value))return;
  if(typeof value!=="object")fail("INVALID_ENVELOPE");
  if(seen.has(value))fail("INVALID_ENVELOPE");
  const prototype=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&prototype!==Object.prototype&&prototype!==null)fail("INVALID_ENVELOPE");
  seen.add(value);
  const keys=Reflect.ownKeys(value);
  for(const key of keys){
    if(typeof key!=="string")fail("INVALID_ENVELOPE");
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!("value" in descriptor))fail("INVALID_ENVELOPE");
    assertJsonValue(descriptor.value,seen,depth+1);
  }
  seen.delete(value);
}

function encodedSize(value:unknown):{bytes:number;text:string}{
  assertJsonValue(value);
  let text:string|undefined;
  try{text=JSON.stringify(value);}catch{fail("INVALID_ENVELOPE");}
  if(text===undefined)fail("INVALID_ENVELOPE");
  return {bytes:new TextEncoder().encode(text).byteLength,text};
}

function cloneBounded<T>(value:T,maxBytes:number):T{
  const encoded=encodedSize(value);
  if(encoded.bytes>maxBytes)fail("PAYLOAD_TOO_LARGE");
  try{return JSON.parse(encoded.text) as T;}catch{fail("INVALID_ENVELOPE");}
}

function isLoopback(hostname:string):boolean{
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,"");
  if(LOOPBACK.has(host))return true;
  const octets=host.split(".");
  return octets.length===4&&octets[0]==="127"&&octets.slice(1).every(part=>/^\d{1,3}$/.test(part)&&Number(part)<=255);
}

export function validateRemoteRelayConfig(input:RemoteRelayConfig):Readonly<Required<Pick<RemoteRelayConfig,"enabled">>&RemoteRelayConfig>{
  if(!input||typeof input!=="object"||Array.isArray(input)||typeof input.enabled!=="boolean")fail("INVALID_CONFIG");
  const allowedKeys=new Set(["enabled","endpoint","route_id","allow_loopback","max_payload_bytes","max_in_flight","max_queue"]);
  if(Object.keys(input).some(key=>!allowedKeys.has(key)))fail("INVALID_CONFIG");
  if(!input.enabled){
    if(Object.keys(input).some(key=>key!=="enabled"))fail("INVALID_CONFIG");
    return Object.freeze({enabled:false});
  }
  if(typeof input.endpoint!=="string"||input.endpoint.length===0||input.endpoint.length>MAX_ENDPOINT_CHARS||!validId(input.route_id))fail("INVALID_CONFIG");
  let endpoint:URL;
  try{endpoint=new URL(input.endpoint);}catch{fail("INVALID_CONFIG");}
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.hostname)fail("INVALID_CONFIG");
  if(endpoint.protocol!=="https:"&&endpoint.protocol!=="wss:"&&endpoint.protocol!=="http:"&&endpoint.protocol!=="ws:")fail("INVALID_CONFIG");
  if((endpoint.protocol==="http:"||endpoint.protocol==="ws:")&&!(input.allow_loopback===true&&isLoopback(endpoint.hostname)))fail("INVALID_CONFIG");
  if(input.allow_loopback!==undefined&&typeof input.allow_loopback!=="boolean")fail("INVALID_CONFIG");
  const maxPayload=input.max_payload_bytes??64*1024;
  const maxFlight=input.max_in_flight??8;
  const maxQueue=input.max_queue??32;
  if(!integer(maxPayload,1,MAX_PAYLOAD_BYTES)||!integer(maxFlight,1,MAX_IN_FLIGHT)||!integer(maxQueue,0,MAX_QUEUE))fail("INVALID_CONFIG");
  return Object.freeze({
    enabled:true,
    endpoint:endpoint.toString().replace(/\/$/,""),
    route_id:input.route_id,
    allow_loopback:input.allow_loopback??false,
    max_payload_bytes:maxPayload,
    max_in_flight:maxFlight,
    max_queue:maxQueue,
  });
}

export function assertRemoteRelayEnvelope(value:unknown,maxBytes=MAX_PAYLOAD_BYTES):asserts value is RemoteRelayEnvelope{
  const bounded=cloneBounded(value,maxBytes);
  if(!bounded||typeof bounded!=="object"||Array.isArray(bounded))fail("INVALID_ENVELOPE");
  const envelope=bounded as Record<string,unknown>;
  if(typeof envelope.schema!=="string"||!envelope.schema.endsWith("/v1"))fail("UNSUPPORTED_VERSION");
  if(!validId(envelope.route_id)||!validId(envelope.session_id))fail("INVALID_ENVELOPE");
  if(envelope.kind==="request"){
    if(envelope.schema!==REMOTE_RELAY_REQUEST_SCHEMA||!validId(envelope.request_id)||!Object.hasOwn(envelope,"payload"))fail("INVALID_ENVELOPE");
    cloneBounded(envelope.payload,maxBytes);
    return;
  }
  if(envelope.kind==="response"){
    if(envelope.schema!==REMOTE_RELAY_RESPONSE_SCHEMA||!validId(envelope.request_id)||typeof envelope.ok!=="boolean")fail("INVALID_ENVELOPE");
    if(envelope.ok){
      if(!Object.hasOwn(envelope,"payload")||Object.hasOwn(envelope,"error"))fail("INVALID_ENVELOPE");
      cloneBounded(envelope.payload,maxBytes);
    }else{
      const error=envelope.error;
      if(!error||typeof error!=="object"||typeof (error as Record<string,unknown>).code!=="string"||typeof (error as Record<string,unknown>).message!=="string"||(error as Record<string,unknown>).message && String((error as Record<string,unknown>).message).length>256||Object.hasOwn(envelope,"payload"))fail("INVALID_ENVELOPE");
    }
    return;
  }
  if(envelope.kind==="lifecycle"){
    if(envelope.schema!==REMOTE_RELAY_LIFECYCLE_SCHEMA||!["connected","disconnected","cancelled","timed_out"].includes(String(envelope.state)))fail("INVALID_ENVELOPE");
    if(envelope.request_id!==undefined&&!validId(envelope.request_id))fail("INVALID_ENVELOPE");
    if((envelope.state==="cancelled"||envelope.state==="timed_out")&&!validId(envelope.request_id))fail("INVALID_ENVELOPE");
    return;
  }
  fail("INVALID_ENVELOPE");
}

interface PendingRequest{
  envelope:RemoteRelayRequest;
  controller:AbortController;
  resolve(value:unknown):void;
  reject(error:RemoteRelayError):void;
  timer:ReturnType<typeof setTimeout>;
  timeout_ms:number;
  queued:boolean;
}

export class RemoteRelayClient{
  readonly config:Readonly<RemoteRelayConfig>;
  private session: string|undefined;
  private state:"disconnected"|"connecting"|"connected"="disconnected";
  private connection:RelayConnection|undefined;
  private readonly pending=new Map<string,PendingRequest>();
  private readonly queue:PendingRequest[]=[];
  private readonly usedRequestIds=new Set<string>();
  private readonly active=new Set<string>();

  constructor(
    config:RemoteRelayConfig,
    private readonly transport:RemoteRelayTransport,
    private readonly credentialProvider:RelayCredentialProvider,
    private readonly newSessionId:()=>string=randomUUID,
  ){
    this.config=validateRemoteRelayConfig(config);
  }

  get sessionId():string|undefined{return this.session;}
  get inFlightCount():number{return this.active.size;}
  get queuedCount():number{return this.queue.length;}

  async connect():Promise<void>{
    if(!this.config.enabled)fail("RELAY_DISABLED");
    if(this.state!=="disconnected")fail("RELAY_OFFLINE");
    this.state="connecting";
    let credential:string|undefined;
    try{credential=await this.credentialProvider();}catch{this.state="disconnected";fail("INVALID_CREDENTIAL");}
    if(typeof credential!=="string"||credential.length===0||credential.length>8192||/[\r\n\0]/.test(credential)){
      this.state="disconnected";
      fail("INVALID_CREDENTIAL");
    }
    const sessionId=this.newSessionId();
    if(!validId(sessionId)){this.state="disconnected";fail("INVALID_CONFIG");}
    const connection:RelayConnection={
      endpoint:this.config.endpoint!,
      route_id:this.config.route_id!,
      session_id:sessionId,
      credential,
    };
    try{
      await this.transport.connect(connection);
    }catch{
      this.state="disconnected";
      fail("RELAY_OFFLINE");
    }
    if(this.state!=="connecting"){
      try{await this.transport.disconnect({endpoint:connection.endpoint,route_id:connection.route_id,session_id:connection.session_id});}catch{}
      fail("RELAY_OFFLINE");
    }
    this.connection=connection;
    this.session=sessionId;
    this.state="connected";
    this.usedRequestIds.clear();
    this.emitLifecycle("connected",sessionId);
  }

  request(requestId:string,payload:unknown,timeoutMs=30_000):Promise<unknown>{
    if(this.state!=="connected"||!this.session) return Promise.reject(new RemoteRelayError(this.config.enabled?"RELAY_OFFLINE":"RELAY_DISABLED"));
    if(!validId(requestId))return Promise.reject(new RemoteRelayError("INVALID_ENVELOPE"));
    if(this.usedRequestIds.has(requestId))return Promise.reject(new RemoteRelayError("DUPLICATE_REQUEST_ID"));
    if(this.usedRequestIds.size>=MAX_SESSION_REQUESTS)return Promise.reject(new RemoteRelayError("REQUEST_BUDGET_EXCEEDED"));
    if(!integer(timeoutMs,1,MAX_TIMEOUT_MS))return Promise.reject(new RemoteRelayError("INVALID_CONFIG"));
    let safePayload:unknown;
    try{safePayload=cloneBounded(payload,this.config.max_payload_bytes!);}catch(error){return Promise.reject(error);}
    if(this.active.size>=(this.config.max_in_flight!)&&this.queue.length>=this.config.max_queue!)return Promise.reject(new RemoteRelayError("QUEUE_FULL"));
    const envelope:RemoteRelayRequest={
      schema:REMOTE_RELAY_REQUEST_SCHEMA,
      kind:"request",
      route_id:this.config.route_id!,
      session_id:this.session,
      request_id:requestId,
      payload:safePayload,
    };
    try{assertRemoteRelayEnvelope(envelope,this.config.max_payload_bytes!);}catch(error){return Promise.reject(error);}
    this.usedRequestIds.add(requestId);
    return new Promise((resolve,reject)=>{
      const entry:PendingRequest={
        envelope,
        controller:new AbortController(),
        resolve,
        reject,
        timeout_ms:timeoutMs,
        queued:this.active.size>=(this.config.max_in_flight!),
        timer:setTimeout(()=>this.finish(entry,new RemoteRelayError("TIMEOUT"),"timed_out"),timeoutMs),
      };
      this.pending.set(requestId,entry);
      if(entry.queued)this.queue.push(entry);
      else this.dispatch(entry);
    });
  }

  cancel(requestId:string):boolean{
    const entry=this.pending.get(requestId);
    if(!entry)return false;
    this.finish(entry,new RemoteRelayError("CANCELLED"),"cancelled");
    return true;
  }

  async disconnect():Promise<void>{
    const sessionId=this.session;
    const connection=this.connection;
    this.state="disconnected";
    this.session=undefined;
    this.connection=undefined;
    this.queue.splice(0);
    for(const entry of [...this.pending.values()])this.finish(entry,new RemoteRelayError("DISCONNECTED"));
    if(sessionId)this.emitLifecycle("disconnected",sessionId);
    if(connection){
      try{await this.transport.disconnect({endpoint:connection.endpoint,route_id:connection.route_id,session_id:connection.session_id});}catch{}
    }
  }

  private dispatch(entry:PendingRequest):void{
    if(this.state!=="connected"||this.session!==entry.envelope.session_id){
      this.finish(entry,new RemoteRelayError("STALE_SESSION"));
      return;
    }
    entry.queued=false;
    this.active.add(entry.envelope.request_id);
    void this.transport.send(entry.envelope,entry.controller.signal).then(response=>{
      if(this.pending.get(entry.envelope.request_id)!==entry)return;
      if(this.session!==entry.envelope.session_id){
        this.finish(entry,new RemoteRelayError("STALE_SESSION"));
        return;
      }
      try{
        assertRemoteRelayEnvelope(response,this.config.max_payload_bytes!);
        const envelope=response as RemoteRelayResponse;
        if(envelope.kind!=="response")fail("INVALID_ENVELOPE");
        if(envelope.route_id!==entry.envelope.route_id||envelope.session_id!==entry.envelope.session_id||envelope.request_id!==entry.envelope.request_id)fail("CORRELATION_MISMATCH");
        if(!envelope.ok)fail("REMOTE_ERROR");
        entry.resolve(cloneBounded(envelope.payload,this.config.max_payload_bytes!));
        this.remove(entry);
        this.pump();
      }catch(error){
        this.finish(entry,error instanceof RemoteRelayError?error:new RemoteRelayError("INVALID_ENVELOPE"));
      }
    },(error)=>{
      if(this.pending.get(entry.envelope.request_id)===entry){
        const relayErr=error instanceof RemoteRelayError?error:new RemoteRelayError("RELAY_OFFLINE");
        this.finish(entry,relayErr);
      }
    });
  }

  private finish(entry:PendingRequest,error:RemoteRelayError,state?:"cancelled"|"timed_out"):void{
    if(this.pending.get(entry.envelope.request_id)!==entry)return;
    if(state)this.emitLifecycle(state,entry.envelope.session_id,entry.envelope.request_id);
    this.remove(entry);
    entry.controller.abort();
    entry.reject(error);
    this.pump();
  }

  private remove(entry:PendingRequest):void{
    clearTimeout(entry.timer);
    this.pending.delete(entry.envelope.request_id);
    this.active.delete(entry.envelope.request_id);
    const queuedIndex=this.queue.indexOf(entry);
    if(queuedIndex>=0)this.queue.splice(queuedIndex,1);
  }

  private pump():void{
    while(this.state==="connected"&&this.active.size<this.config.max_in_flight!&&this.queue.length){
      const entry=this.queue.shift()!;
      if(this.pending.get(entry.envelope.request_id)===entry)this.dispatch(entry);
    }
  }

  private emitLifecycle(state:LifecycleState,sessionId:string,requestId?:string):void{
    const event:RemoteRelayLifecycle={
      schema:REMOTE_RELAY_LIFECYCLE_SCHEMA,
      kind:"lifecycle",
      route_id:this.config.route_id!,
      session_id:sessionId,
      state,
      ...(requestId===undefined?{}:{request_id:requestId}),
    };
    try{this.transport.lifecycle?.(event);}catch{}
  }
}

export type RemoteRelayHandler=(payload:unknown,signal?:AbortSignal)=>unknown|Promise<unknown>;

export class InMemoryRemoteRelayReference implements RemoteRelayTransport{
  private session: string|undefined;
  private route: string|undefined;
  private active=0;
  readonly lifecycleEvents:RemoteRelayLifecycle[]=[];

  constructor(private readonly handler:RemoteRelayHandler=payload=>payload,private readonly maxInFlight=8){
    if(!integer(maxInFlight,1,MAX_IN_FLIGHT))fail("INVALID_CONFIG");
  }

  async connect(connection:RelayConnection):Promise<void>{
    this.session=connection.session_id;
    this.route=connection.route_id;
  }

  async send(request:RemoteRelayRequest,signal:AbortSignal):Promise<RemoteRelayResponse>{
    assertRemoteRelayEnvelope(request);
    if(request.session_id!==this.session||request.route_id!==this.route)fail("STALE_SESSION");
    if(signal.aborted)fail("CANCELLED");
    if(this.active>=this.maxInFlight)fail("IN_FLIGHT_LIMIT");
    this.active+=1;
    try{
      const handlerPromise=Promise.resolve().then(()=>this.handler(cloneBounded(request.payload,MAX_PAYLOAD_BYTES),signal));
      let abortListener:(()=>void)|undefined;
      const abortPromise=new Promise<never>((_,reject)=>{
        if(signal.aborted){
          reject(new RemoteRelayError("CANCELLED"));
          return;
        }
        abortListener=()=>reject(new RemoteRelayError("CANCELLED"));
        signal.addEventListener("abort",abortListener,{once:true});
      });
      try{
        const payload=await Promise.race([handlerPromise,abortPromise]);
        if(signal.aborted)fail("CANCELLED");
        return {
          schema:REMOTE_RELAY_RESPONSE_SCHEMA,
          kind:"response",
          route_id:request.route_id,
          session_id:request.session_id,
          request_id:request.request_id,
          ok:true,
          payload:cloneBounded(payload,MAX_PAYLOAD_BYTES),
        };
      }finally{
        if(abortListener){
          signal.removeEventListener("abort",abortListener);
        }
      }
    }finally{
      this.active-=1;
    }
  }

  disconnect(connection:Omit<RelayConnection,"credential">):void{
    if(this.session===connection.session_id){
      this.session=undefined;
      this.route=undefined;
    }
  }

  lifecycle(event:RemoteRelayLifecycle):void{
    assertRemoteRelayEnvelope(event);
    if(this.lifecycleEvents.length>=256){
      this.lifecycleEvents.shift();
    }
    this.lifecycleEvents.push(event);
  }
}

