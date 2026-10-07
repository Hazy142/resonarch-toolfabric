import {randomUUID} from "node:crypto";
import {lookup} from "node:dns/promises";
import {request as httpsRequest} from "node:https";
import {BlockList, isIP} from "node:net";
import {canonicalDigest} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";

const MAX_POLICY_HOSTS=64;
const MAX_POLICY_REQUESTS=256;
const MAX_POLICY_RESPONSE_BYTES=16*1024*1024;
const MAX_URL_CHARS=4096;
const AUTH_REF=/^network-auth:\/\/sha256:[0-9a-f]{64}$/;

const RESERVED=new BlockList();
for(const [network,prefix] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],
  ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],
  ["224.0.0.0",4],["240.0.0.0",4],
] as const) RESERVED.addSubnet(network,prefix,"ipv4");
for(const [network,prefix] of [
  ["::",128],["::1",128],["fc00::",7],["fe80::",10],
  ["2001:db8::",32],["ff00::",8],
] as const) RESERVED.addSubnet(network,prefix,"ipv6");

export interface NetworkReadPolicy{
  allowed_hosts:readonly string[];
  expires_at:string;
  max_requests:number;
  max_response_bytes:number;
  allow_query?:boolean;
  data_locality:"public";
}

export interface NetworkFetchRequest{
  url:string;
  method:"GET"|"HEAD";
  timeout_ms:number;
  max_response_bytes:number;
}

export interface NetworkFetchResponse{
  requested_url:string;
  final_url:string;
  status:number;
  content_type:string|null;
  etag:string|null;
  last_modified:string|null;
  redirect_location:string|null;
  retrieved_at:string;
  body:Uint8Array;
}

export interface NetworkReadTransport{
  fetch(request:NetworkFetchRequest):Promise<NetworkFetchResponse>;
}

interface NormalizedPolicy{
  allowed_hosts:Set<string>;
  expires_at:string;
  expires_ms:number;
  max_requests:number;
  max_response_bytes:number;
  allow_query:boolean;
  data_locality:"public";
  digest:string;
}

interface IssuedAuthorization{
  ref:string;
  task_id:string;
  url:string;
  method:"GET"|"HEAD";
  used:boolean;
}

function integer(value:unknown,name:string,min:number,max:number):number{
  if(!Number.isInteger(value)||Number(value)<min||Number(value)>max){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG",`${name} must be an integer in ${min}..${max}`,"denied");
  }
  return Number(value);
}

function normalizeHost(value:string):string{
  return value.trim().toLowerCase().replace(/\.$/,"");
}

export function isPublicNetworkAddress(address:string,family:4|6):boolean{
  if(family===6){
    const lower=address.toLowerCase();
    const mappedPrefix="::ffff:";
    if(lower.startsWith(mappedPrefix)){
      const embedded=address.slice(mappedPrefix.length);
      if(isIP(embedded)===4)return !RESERVED.check(embedded,"ipv4");
    }
  }
  return !RESERVED.check(address,family===4?"ipv4":"ipv6");
}

function assertPublicLiteral(hostname:string):void{
  const literal=hostname.startsWith("[")&&hostname.endsWith("]")?hostname.slice(1,-1):hostname;
  const family=isIP(literal);
  if(family!==0&&!isPublicNetworkAddress(literal,family as 4|6)){
    throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","private/reserved network targets are forbidden","denied");
  }
}

function normalizePolicy(policy:NetworkReadPolicy|undefined):NormalizedPolicy|undefined{
  if(policy===undefined)return undefined;
  if(!policy||typeof policy!=="object"||Array.isArray(policy)){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","networkReadPolicy must be an object","denied");
  }
  if(!Array.isArray(policy.allowed_hosts)||policy.allowed_hosts.length===0||policy.allowed_hosts.length>MAX_POLICY_HOSTS){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG",`networkReadPolicy.allowed_hosts must contain 1..${MAX_POLICY_HOSTS} exact hosts`,"denied");
  }
  const hosts:string[]=[];
  for(const raw of policy.allowed_hosts){
    if(typeof raw!=="string")throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","network policy host must be a string","denied");
    const host=normalizeHost(raw);
    if(!host||host.includes("*")||host.includes("/")||host.includes("\\")||host.includes("@")||host.includes("\0")){
      throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG",`invalid exact network host: ${raw}`,"denied");
    }
    assertPublicLiteral(host);
    hosts.push(host);
  }
  if(new Set(hosts).size!==hosts.length){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","network policy contains duplicate hosts","denied");
  }
  if(typeof policy.expires_at!=="string"||!Number.isFinite(Date.parse(policy.expires_at))){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","networkReadPolicy.expires_at must be RFC3339-like","denied");
  }
  if(policy.data_locality!=="public"){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","P1D network read only accepts data_locality=public","denied");
  }
  if(policy.allow_query!==undefined&&typeof policy.allow_query!=="boolean"){
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG","networkReadPolicy.allow_query must be boolean","denied");
  }
  const canonical={
    allowed_hosts:[...hosts].sort(),
    expires_at:new Date(policy.expires_at).toISOString(),
    max_requests:integer(policy.max_requests,"networkReadPolicy.max_requests",1,MAX_POLICY_REQUESTS),
    max_response_bytes:integer(policy.max_response_bytes,"networkReadPolicy.max_response_bytes",1,MAX_POLICY_RESPONSE_BYTES),
    allow_query:policy.allow_query??false,
    data_locality:"public" as const,
  };
  return {
    ...canonical,
    allowed_hosts:new Set(canonical.allowed_hosts),
    expires_ms:Date.parse(canonical.expires_at),
    digest:canonicalDigest(canonical),
  };
}

function targetUrl(raw:unknown,policy:NormalizedPolicy):URL{
  if(typeof raw!=="string"||raw.length===0||raw.length>MAX_URL_CHARS||raw.includes("\0")){
    throw new RuntimeExecutionError("INVALID_ARGUMENT",`network URL must be a non-empty string <= ${MAX_URL_CHARS} chars`,"denied");
  }
  let url:URL;
  try{url=new URL(raw);}catch{throw new RuntimeExecutionError("INVALID_ARGUMENT","network URL is invalid","denied");}
  if(url.protocol!=="https:")throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","P1D permits HTTPS only","denied");
  if(url.username||url.password)throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","embedded URL credentials are forbidden","denied");
  if(url.hash)throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","URL fragments are not sent and are forbidden in canonical fetch targets","denied");
  if(url.port&&url.port!=="443")throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","non-standard network ports are forbidden","denied");
  if(url.search&&!policy.allow_query)throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","query strings require explicit host-policy allowance","denied");
  const host=normalizeHost(url.hostname.startsWith("[")&&url.hostname.endsWith("]")?url.hostname.slice(1,-1):url.hostname);
  assertPublicLiteral(host);
  if(!policy.allowed_hosts.has(host))throw new RuntimeExecutionError("DENIED_NETWORK_TARGET",`network host is outside policy: ${host}`,"denied");
  url.hostname=host;
  url.port="";
  return url;
}

function methodArgument(value:unknown):"GET"|"HEAD"{
  if(value===undefined)return "GET";
  if(value!=="GET"&&value!=="HEAD")throw new RuntimeExecutionError("INVALID_ARGUMENT","network read method must be GET or HEAD","denied");
  return value;
}

function headerValue(value:string|string[]|undefined):string|null{
  if(Array.isArray(value))return value.join(", ");
  return typeof value==="string"?value:null;
}

export class NativeHttpsReadTransport implements NetworkReadTransport{
  async fetch(input:NetworkFetchRequest):Promise<NetworkFetchResponse>{
    const url=new URL(input.url);
    const hostname=url.hostname.startsWith("[")&&url.hostname.endsWith("]")?url.hostname.slice(1,-1):url.hostname;
    let addresses;
    try{
      addresses=await lookup(hostname,{all:true,verbatim:true});
    }catch(error){
      throw new RuntimeExecutionError("NETWORK_DNS_FAILED",error instanceof Error?error.message:String(error));
    }
    if(addresses.length===0)throw new RuntimeExecutionError("NETWORK_DNS_FAILED","network target resolved to no addresses");
    for(const address of addresses){
      if(!isPublicNetworkAddress(address.address,address.family as 4|6)){
        throw new RuntimeExecutionError("DENIED_NETWORK_TARGET","DNS resolved to a private/reserved address","denied");
      }
    }
    const selected=addresses[0]!;
    return await new Promise<NetworkFetchResponse>((resolve,reject)=>{
      const req=httpsRequest({
        host:selected.address,
        port:443,
        servername:hostname,
        method:input.method,
        path:url.pathname+url.search,
        headers:{
          host:hostname,
          accept:"text/html,application/json,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.1",
          "user-agent":"resonArch-ToolFabric/0.1 network-read",
          "accept-encoding":"identity",
          connection:"close",
        },
        timeout:input.timeout_ms,
      },response=>{
        const status=response.statusCode??0;
        const contentLength=Number(headerValue(response.headers["content-length"])??"0");
        if(Number.isFinite(contentLength)&&contentLength>input.max_response_bytes){
          response.destroy();
          reject(new RuntimeExecutionError("NETWORK_RESPONSE_TOO_LARGE",`response exceeds ${input.max_response_bytes} bytes`));
          return;
        }
        const chunks:Buffer[]=[];
        let total=0;
        response.on("data",(chunk:Buffer|string)=>{
          const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
          total+=bytes.length;
          if(total>input.max_response_bytes){
            response.destroy(new RuntimeExecutionError("NETWORK_RESPONSE_TOO_LARGE",`response exceeds ${input.max_response_bytes} bytes`));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error",error=>reject(error instanceof RuntimeExecutionError?error:new RuntimeExecutionError("NETWORK_REQUEST_FAILED",error.message)));
        response.on("end",()=>{
          const rawLocation=headerValue(response.headers.location);
          let redirect:string|null=null;
          if(rawLocation){
            try{redirect=new URL(rawLocation,url).toString();}catch{redirect=rawLocation;}
          }
          resolve({
            requested_url:input.url,
            final_url:input.url,
            status,
            content_type:headerValue(response.headers["content-type"]),
            etag:headerValue(response.headers.etag),
            last_modified:headerValue(response.headers["last-modified"]),
            redirect_location:redirect,
            retrieved_at:new Date().toISOString(),
            body:new Uint8Array(Buffer.concat(chunks)),
          });
        });
      });
      req.on("timeout",()=>req.destroy(new RuntimeExecutionError("NETWORK_TIMEOUT","network request timed out","cancelled")));
      req.on("error",error=>reject(error instanceof RuntimeExecutionError?error:new RuntimeExecutionError("NETWORK_REQUEST_FAILED",error.message)));
      req.end();
    });
  }
}

export class NetworkReadBroker{
  private readonly policy:NormalizedPolicy|undefined;
  private readonly transport:NetworkReadTransport;
  private readonly authorizations=new Map<string,IssuedAuthorization>();
  private authorizationCount=0;
  private requestCount=0;

  constructor(policy?:NetworkReadPolicy,transport:NetworkReadTransport=new NativeHttpsReadTransport()){
    this.policy=normalizePolicy(policy);
    this.transport=transport;
  }

  get hasPolicy():boolean{return this.policy!==undefined;}

  authorize(taskId:string,input:Record<string,unknown>):Record<string,unknown>{
    const policy=this.requirePolicy();
    if(Date.now()>=policy.expires_ms)throw new RuntimeExecutionError("DENIED_NETWORK_POLICY","network read policy expired","denied");
    if(this.authorizationCount>=policy.max_requests){
      throw new RuntimeExecutionError("DENIED_NETWORK_BUDGET","network authorization budget exhausted","denied");
    }
    const method=methodArgument(input.method);
    const url=targetUrl(input.url,policy).toString();
    const digest=canonicalDigest({
      task_id:taskId,
      url,
      method,
      policy_digest:policy.digest,
      nonce:randomUUID(),
    });
    const ref="network-auth://"+digest;
    this.authorizations.set(ref,{ref,task_id:taskId,url,method,used:false});
    this.authorizationCount+=1;
    return {
      authorization_ref:ref,
      url,
      method,
      policy_digest:policy.digest,
      expires_at:policy.expires_at,
      single_use:true,
    };
  }

  async fetch(taskId:string,input:Record<string,unknown>,timeoutMs:number):Promise<NetworkFetchResponse>{
    const policy=this.requirePolicy();
    if(Date.now()>=policy.expires_ms)throw new RuntimeExecutionError("DENIED_NETWORK_POLICY","network read policy expired","denied");
    if(typeof input.authorization_ref!=="string"||!AUTH_REF.test(input.authorization_ref)){
      throw new RuntimeExecutionError("DENIED_NETWORK_AUTHORIZATION","valid network authorization_ref required","denied");
    }
    const authorization=this.authorizations.get(input.authorization_ref);
    if(!authorization||authorization.used||authorization.task_id!==taskId){
      throw new RuntimeExecutionError("DENIED_NETWORK_AUTHORIZATION","network authorization is missing, used, or belongs to another task","denied");
    }
    const method=methodArgument(input.method);
    const url=targetUrl(input.url,policy).toString();
    if(url!==authorization.url||method!==authorization.method){
      throw new RuntimeExecutionError("DENIED_NETWORK_AUTHORIZATION","network authorization does not match URL/method","denied");
    }
    if(this.requestCount>=policy.max_requests){
      throw new RuntimeExecutionError("DENIED_NETWORK_BUDGET","network request budget exhausted","denied");
    }
    authorization.used=true;
    this.requestCount+=1;
    const response=await this.transport.fetch({
      url,
      method,
      timeout_ms:timeoutMs,
      max_response_bytes:policy.max_response_bytes,
    });
    if(response.requested_url!==url||response.final_url!==url){
      throw new RuntimeExecutionError("NETWORK_TRANSPORT_SCOPE_VIOLATION","network transport silently changed or followed the authorized URL","denied");
    }
    if(!Number.isFinite(Date.parse(response.retrieved_at))){
      throw new RuntimeExecutionError("NETWORK_INVALID_RESPONSE","network transport returned invalid retrieved_at");
    }
    if(!(response.body instanceof Uint8Array)){
      throw new RuntimeExecutionError("NETWORK_INVALID_RESPONSE","network transport returned invalid body");
    }
    if(response.body.byteLength>policy.max_response_bytes){
      throw new RuntimeExecutionError("NETWORK_RESPONSE_TOO_LARGE",`response exceeds ${policy.max_response_bytes} bytes`);
    }
    if(!Number.isInteger(response.status)||response.status<100||response.status>599){
      throw new RuntimeExecutionError("NETWORK_INVALID_RESPONSE","network transport returned invalid HTTP status");
    }
    return response;
  }

  private requirePolicy():NormalizedPolicy{
    if(!this.policy)throw new RuntimeExecutionError("DENIED_NETWORK_POLICY","network read policy is not configured","denied");
    return this.policy;
  }
}

export function isInlineTextContentType(contentType:string|null):boolean{
  if(contentType===null)return false;
  const type=contentType.split(";",1)[0]!.trim().toLowerCase();
  return type.startsWith("text/")||type==="application/json"||type==="application/xml"||type.endsWith("+json")||type.endsWith("+xml");
}
