import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sha256} from "../src/contracts/canonical.js";
import {ReadPlaneRuntime, type ToolCall} from "../src/runtime/readPlane.js";
import {
  isPublicNetworkAddress,
  type NetworkFetchRequest,
  type NetworkFetchResponse,
  type NetworkReadTransport,
} from "../src/runtime/networkRead.js";

async function fixture():Promise<{workspace:string;artifacts:string}>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-p1d-"));
  const workspace=join(root,"workspace");
  const artifacts=join(root,"artifacts");
  await mkdir(workspace,{recursive:true});
  return {workspace,artifacts};
}

function call(tool:string,args:Record<string,unknown>,workspace:string,suffix:string,taskId="p1d-task"):ToolCall{
  return {
    schema:"resonarch.toolfabric.call/v1",
    call_id:"p1d-"+suffix,
    task_id:taskId,
    trace_id:"p1d-trace",
    tool:{id:tool,version:tool==="network.authorize"||tool==="web.fetch"?"2.0.0":"1.0.0"},
    arguments:args,
    scope:{workspace_root:workspace},
    deadline:new Date(Date.now()+60_000).toISOString(),
  };
}

class FixtureTransport implements NetworkReadTransport{
  readonly requests:NetworkFetchRequest[]=[];
  constructor(private readonly body:string="fixture source body"){}
  async fetch(request:NetworkFetchRequest):Promise<NetworkFetchResponse>{
    this.requests.push(request);
    const body=new TextEncoder().encode(this.body);
    return {
      requested_url:request.url,
      final_url:request.url,
      status:200,
      content_type:"text/plain; charset=utf-8",
      etag:"\"fixture-v1\"",
      last_modified:"Mon, 05 Oct 2026 20:00:00 GMT",
      redirect_location:null,
      retrieved_at:"2026-10-06T00:00:00.000Z",
      body,
    };
  }
}

test("P1D SSRF classifier distinguishes public, private, and IPv4-mapped addresses",()=>{
  assert.equal(isPublicNetworkAddress("104.20.23.154",4),true);
  assert.equal(isPublicNetworkAddress("127.0.0.1",4),false);
  assert.equal(isPublicNetworkAddress("10.1.2.3",4),false);
  assert.equal(isPublicNetworkAddress("2606:4700::6814:179a",6),true);
  assert.equal(isPublicNetworkAddress("::1",6),false);
  assert.equal(isPublicNetworkAddress("::ffff:127.0.0.1",6),false);
  assert.equal(isPublicNetworkAddress("::ffff:104.20.23.154",6),true);
});

test("P1D canonical descriptors keep network reads read-only while retaining elevated network risk",async()=>{
  for(const id of ["web.search","web.fetch","docs.resolve","package.resolve","vulnerability.search"]){
    const web=JSON.parse(await readFile(`contracts/tools/research/${id}.json`,"utf8"));
    assert.equal(web.version,"2.0.0");
    assert.deepEqual(web.capabilities,["network:web_read"]);
    assert.equal(web.risk_class,"R2");
    assert.equal(web.side_effect,"none");
    assert.equal(web.idempotency,"conditional");
    assert.equal(web.network,"required");
  }

  const authorize=JSON.parse(await readFile("contracts/tools/security/network.authorize.json","utf8"));
  assert.equal(authorize.version,"2.0.0");
  assert.deepEqual(authorize.capabilities,["network:authorize"]);
  assert.equal(authorize.risk_class,"R0");
  assert.equal(authorize.side_effect,"none");
  assert.equal(authorize.idempotency,"conditional");
  assert.equal(authorize.network,"forbidden");
});

test("P1D network authority is deny-by-default",async()=>{
  const {workspace,artifacts}=await fixture();
  const runtime=await ReadPlaneRuntime.create({artifactRoot:artifacts});
  const denied=await runtime.execute(call(
    "network.authorize",
    {url:"https://docs.example.test/source",method:"GET"},
    workspace,
    "no-policy",
  ));
  assert.equal(denied.result.status,"denied");
  assert.equal((denied.result.error as {code:string}).code,"DENIED_NETWORK_POLICY");
});

test("P1D authorized web.fetch is task-bound, single-use, content-addressed and receipted",async()=>{
  const {workspace,artifacts}=await fixture();
  const transport=new FixtureTransport("public documentation\n");
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:4,
      max_response_bytes:4096,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:transport,
  });

  const authorization=await runtime.execute(call(
    "network.authorize",
    {url:"https://docs.example.test/source",method:"GET"},
    workspace,
    "authorize",
  ));
  assert.equal(authorization.result.status,"succeeded");
  const auth=authorization.result.output as {authorization_ref:string;url:string;method:string;single_use:boolean};
  assert.match(auth.authorization_ref,/^network-auth:\/\/sha256:[0-9a-f]{64}$/);
  assert.equal(auth.url,"https://docs.example.test/source");
  assert.equal(auth.method,"GET");
  assert.equal(auth.single_use,true);

  const fetched=await runtime.execute(call(
    "web.fetch",
    {url:auth.url,method:"GET",authorization_ref:auth.authorization_ref},
    workspace,
    "fetch",
  ));
  assert.equal(fetched.result.status,"succeeded");
  assert.equal(transport.requests.length,1);
  const output=fetched.result.output as {
    source:{url:string;status:number;bytes:number;sha256:string;artifact_ref:string;content_type:string};
    text:string;
  };
  assert.equal(output.source.url,auth.url);
  assert.equal(output.source.status,200);
  assert.equal(output.source.bytes,new TextEncoder().encode("public documentation\n").byteLength);
  assert.equal(output.source.sha256,sha256(new TextEncoder().encode("public documentation\n")));
  assert.equal(output.source.artifact_ref,"artifact://"+output.source.sha256);
  assert.equal(output.text,"public documentation\n");
  assert.deepEqual(fetched.result.artifacts,[output.source.artifact_ref]);
  assert.deepEqual(new TextDecoder().decode(await runtime.artifactStore.get(output.source.artifact_ref)),"public documentation\n");

  const replay=await runtime.execute(call(
    "web.fetch",
    {url:auth.url,method:"GET",authorization_ref:auth.authorization_ref},
    workspace,
    "replay",
  ));
  assert.equal(replay.result.status,"denied");
  assert.equal((replay.result.error as {code:string}).code,"DENIED_NETWORK_AUTHORIZATION");
  assert.equal(transport.requests.length,1);
});

test("P1D authorization cannot cross tasks or widen URL/method",async()=>{
  const {workspace,artifacts}=await fixture();
  const transport=new FixtureTransport();
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:4,
      max_response_bytes:4096,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:transport,
  });
  const authorization=await runtime.execute(call(
    "network.authorize",
    {url:"https://docs.example.test/source",method:"GET"},
    workspace,
    "authorize-scope",
  ));
  const ref=(authorization.result.output as {authorization_ref:string}).authorization_ref;

  for(const [suffix,args,taskId] of [
    ["other-task",{url:"https://docs.example.test/source",method:"GET",authorization_ref:ref},"different-task"],
    ["other-url",{url:"https://docs.example.test/other",method:"GET",authorization_ref:ref},"p1d-task"],
    ["other-method",{url:"https://docs.example.test/source",method:"HEAD",authorization_ref:ref},"p1d-task"],
  ] as const){
    const result=await runtime.execute(call("web.fetch",args,workspace,suffix,taskId));
    assert.equal(result.result.status,"denied");
    assert.equal((result.result.error as {code:string}).code,"DENIED_NETWORK_AUTHORIZATION");
  }
  assert.equal(transport.requests.length,0);
});

test("P1D policy rejects unauthorized hosts, plaintext HTTP, embedded credentials and queries by default",async()=>{
  const {workspace,artifacts}=await fixture();
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:4,
      max_response_bytes:4096,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:new FixtureTransport(),
  });
  const cases=[
    ["host","https://evil.example.test/source"],
    ["scheme","http://docs.example.test/source"],
    ["credentials","https://user:pass@docs.example.test/source"],
    ["query","https://docs.example.test/source?token=secret"],
  ] as const;
  for(const [suffix,url] of cases){
    const result=await runtime.execute(call("network.authorize",{url,method:"GET"},workspace,suffix));
    assert.equal(result.result.status,"denied");
  }
});

test("P1D network policy request and response budgets fail closed",async()=>{
  const {workspace,artifacts}=await fixture();
  const transport=new FixtureTransport("x".repeat(32));
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:1,
      max_response_bytes:16,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:transport,
  });
  const authorization=await runtime.execute(call("network.authorize",{url:"https://docs.example.test/a"},workspace,"budget-auth"));
  const ref=(authorization.result.output as {authorization_ref:string}).authorization_ref;
  const oversized=await runtime.execute(call("web.fetch",{
    url:"https://docs.example.test/a",
    authorization_ref:ref,
  },workspace,"budget-fetch"));
  assert.equal(oversized.result.status,"failed");
  assert.equal((oversized.result.error as {code:string}).code,"NETWORK_RESPONSE_TOO_LARGE");
});

test("P1D authorization issuance itself is bounded by the network request budget",async()=>{
  const {workspace,artifacts}=await fixture();
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:1,
      max_response_bytes:1024,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:new FixtureTransport(),
  });
  const first=await runtime.execute(call("network.authorize",{url:"https://docs.example.test/a"},workspace,"auth-budget-1"));
  assert.equal(first.result.status,"succeeded");
  const second=await runtime.execute(call("network.authorize",{url:"https://docs.example.test/b"},workspace,"auth-budget-2"));
  assert.equal(second.result.status,"denied");
  assert.equal((second.result.error as {code:string}).code,"DENIED_NETWORK_BUDGET");
});

test("P1D rejects transports that silently follow or substitute the authorized URL",async()=>{
  const {workspace,artifacts}=await fixture();
  const transport:NetworkReadTransport={
    async fetch(request){
      return {
        requested_url:request.url,
        final_url:"https://other.example.test/followed",
        status:200,
        content_type:"text/plain",
        etag:null,
        last_modified:null,
        redirect_location:null,
        retrieved_at:"2026-10-06T00:00:00.000Z",
        body:new TextEncoder().encode("followed"),
      };
    },
  };
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:1,
      max_response_bytes:1024,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:transport,
  });
  const authorization=await runtime.execute(call("network.authorize",{url:"https://docs.example.test/a"},workspace,"scope-auth"));
  const ref=(authorization.result.output as {authorization_ref:string}).authorization_ref;
  const fetched=await runtime.execute(call("web.fetch",{url:"https://docs.example.test/a",authorization_ref:ref},workspace,"scope-fetch"));
  assert.equal(fetched.result.status,"denied");
  assert.equal((fetched.result.error as {code:string}).code,"NETWORK_TRANSPORT_SCOPE_VIOLATION");
});

test("P1D redirect metadata is returned but redirects are not silently followed",async()=>{
  const {workspace,artifacts}=await fixture();
  const transport:NetworkReadTransport={
    async fetch(request){
      return {
        requested_url:request.url,
        final_url:request.url,
        status:302,
        content_type:"text/html",
        etag:null,
        last_modified:null,
        redirect_location:"https://other.example.test/target",
        retrieved_at:"2026-10-06T00:00:00.000Z",
        body:new Uint8Array(),
      };
    },
  };
  const runtime=await ReadPlaneRuntime.create({
    artifactRoot:artifacts,
    networkReadPolicy:{
      allowed_hosts:["docs.example.test"],
      expires_at:new Date(Date.now()+60_000).toISOString(),
      max_requests:2,
      max_response_bytes:1024,
      allow_query:false,
      data_locality:"public",
    },
    networkTransport:transport,
  });
  const authorization=await runtime.execute(call("network.authorize",{url:"https://docs.example.test/redirect"},workspace,"redirect-auth"));
  const ref=(authorization.result.output as {authorization_ref:string}).authorization_ref;
  const fetched=await runtime.execute(call("web.fetch",{
    url:"https://docs.example.test/redirect",
    authorization_ref:ref,
  },workspace,"redirect-fetch"));
  assert.equal(fetched.result.status,"succeeded");
  const source=(fetched.result.output as {source:{status:number;redirect_location:string|null}}).source;
  assert.equal(source.status,302);
  assert.equal(source.redirect_location,"https://other.example.test/target");
});
