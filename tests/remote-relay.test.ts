import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRemoteRelayEnvelope,
  DEFAULT_REMOTE_RELAY_CONFIG,
  InMemoryRemoteRelayReference,
  RemoteRelayClient,
  RemoteRelayError,
  REMOTE_RELAY_REQUEST_SCHEMA,
  type RemoteRelayConfig,
  type RemoteRelayRequest,
  type RemoteRelayResponse,
  type RemoteRelayTransport,
  validateRemoteRelayConfig,
} from "../src/relay/remoteRelay.js";

const config:RemoteRelayConfig={
  enabled:true,
  endpoint:"https://relay.example.test/v1",
  route_id:"test-route",
  max_payload_bytes:1024,
  max_in_flight:1,
  max_queue:1,
};

function client(transport:RemoteRelayTransport,overrides:Partial<RemoteRelayConfig>={},credentialProvider=()=>"test-credential"){
  return new RemoteRelayClient({...config,...overrides},transport,credentialProvider);
}

function deferred<T>():{promise:Promise<T>;resolve(value:T):void;reject(error:unknown):void}{
  let resolve!:(value:T)=>void;
  let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

class DeferredTransport implements RemoteRelayTransport{
  readonly requests:RemoteRelayRequest[]=[];
  readonly responses:Array<ReturnType<typeof deferred<unknown>>>=[];
  async connect():Promise<void>{}
  async send(request:RemoteRelayRequest):Promise<unknown>{
    this.requests.push(request);
    const result=deferred<unknown>();
    this.responses.push(result);
    return result.promise;
  }
  disconnect():void{}
}

function response(request:RemoteRelayRequest,payload:unknown,patch:Partial<RemoteRelayResponse>={}):RemoteRelayResponse{
  return {
    schema:"resonarch.toolfabric.remote-relay.response/v1",
    kind:"response",
    route_id:request.route_id,
    session_id:request.session_id,
    request_id:request.request_id,
    ok:true,
    payload,
    ...patch,
  };
}

test("relay is explicitly opt-in and has no hosted endpoint default",async()=>{
  assert.deepEqual(DEFAULT_REMOTE_RELAY_CONFIG,{enabled:false});
  assert.equal("endpoint" in DEFAULT_REMOTE_RELAY_CONFIG,false);
  assert.throws(()=>validateRemoteRelayConfig({enabled:true}),{code:"INVALID_CONFIG"});
  const disabled=new RemoteRelayClient(DEFAULT_REMOTE_RELAY_CONFIG,new InMemoryRemoteRelayReference(),()=>"unused");
  await assert.rejects(disabled.connect(),{code:"RELAY_DISABLED"});
});

test("endpoint and credential configuration fail closed",async()=>{
  for(const endpoint of [
    "http://relay.example.test",
    "******relay.example.test",
    "https://relay.example.test/?token=secret",
    "https://relay.example.test/#fragment",
    "file:///tmp/relay",
  ]){
    assert.throws(()=>validateRemoteRelayConfig({...config,endpoint}),{code:"INVALID_CONFIG"});
  }
  assert.throws(()=>validateRemoteRelayConfig({...config,token:"plaintext"} as RemoteRelayConfig),{code:"INVALID_CONFIG"});
  assert.throws(()=>validateRemoteRelayConfig({...config,endpoint:"http://127.0.0.1"}),{code:"INVALID_CONFIG"});
  assert.equal(validateRemoteRelayConfig({...config,endpoint:"ws://127.0.0.1:8080",allow_loopback:true}).endpoint,"ws://127.0.0.1:8080/");
  const invalidCredential=client(new InMemoryRemoteRelayReference(),{},()=>"bad\ncredential");
  await assert.rejects(invalidCredential.connect(),{code:"INVALID_CREDENTIAL"});
});

test("versioned envelopes reject unsupported versions, malformed values, and oversize payloads",()=>{
  assert.throws(()=>assertRemoteRelayEnvelope({
    schema:"resonarch.toolfabric.remote-relay.request/v2",
    kind:"request",
    route_id:"route",
    session_id:"session",
    request_id:"request",
    payload:{},
  }),{code:"UNSUPPORTED_VERSION"});
  assert.throws(()=>assertRemoteRelayEnvelope({
    schema:REMOTE_RELAY_REQUEST_SCHEMA,
    kind:"request",
    route_id:"route",
    session_id:"session",
    request_id:"bad id",
    payload:{},
  }),{code:"INVALID_ENVELOPE"});
  assert.throws(()=>assertRemoteRelayEnvelope({
    schema:REMOTE_RELAY_REQUEST_SCHEMA,
    kind:"request",
    route_id:"route",
    session_id:"session",
    request_id:"request",
    payload:"oversized",
  },8),{code:"PAYLOAD_TOO_LARGE"});
  const circular:Record<string,unknown>={};
  circular.self=circular;
  assert.throws(()=>assertRemoteRelayEnvelope({
    schema:REMOTE_RELAY_REQUEST_SCHEMA,
    kind:"request",
    route_id:"route",
    session_id:"session",
    request_id:"request",
    payload:circular,
  }),{code:"INVALID_ENVELOPE"});
});

test("in-memory reference echoes bounded payloads with bound route, session, and request IDs",async()=>{
  const transport=new InMemoryRemoteRelayReference(payload=>({echo:payload}));
  const relay=client(transport);
  await relay.connect();
  const session=relay.sessionId;
  assert.equal(await relay.request("round-trip",{text:"hello"}),JSON.stringify({echo:{text:"hello"}}));
  assert.equal(relay.sessionId,session);
  assert.deepEqual(transport.lifecycleEvents.map(event=>event.state),["connected"]);
  await relay.disconnect();
  assert.deepEqual(transport.lifecycleEvents.map(event=>event.state),["connected","disconnected"]);
});

test("response route, session, and request correlation are enforced",async()=>{
  for(const patch of [
    {route_id:"other-route"},
    {session_id:"other-session"},
    {request_id:"other-request"},
  ]){
    const transport=new DeferredTransport();
    const relay=client(transport);
    await relay.connect();
    const result=relay.request("correlated",{});
    transport.responses[0]!.resolve(response(transport.requests[0]!,{},patch));
    await assert.rejects(result,{code:"CORRELATION_MISMATCH"});
    await relay.disconnect();
  }
});

test("duplicate request IDs and payload limits fail closed",async()=>{
  const relay=client(new InMemoryRemoteRelayReference());
  await relay.connect();
  await relay.request("once",{});
  await assert.rejects(relay.request("once",{}),{code:"DUPLICATE_REQUEST_ID"});
  await assert.rejects(relay.request("too-large","x".repeat(1025)),{code:"PAYLOAD_TOO_LARGE"});
  await relay.disconnect();
});

test("in-flight and queued work remain bounded and queued requests dispatch in order",async()=>{
  const transport=new DeferredTransport();
  const relay=client(transport);
  await relay.connect();
  const first=relay.request("first",{});
  const second=relay.request("second",{});
  assert.equal(relay.inFlightCount,1);
  assert.equal(relay.queuedCount,1);
  await assert.rejects(relay.request("third",{}),{code:"QUEUE_FULL"});
  transport.responses[0]!.resolve(response(transport.requests[0]!,{n:1}));
  assert.equal(await first,JSON.stringify({n:1}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(transport.requests.map(request=>request.request_id),["first","second"]);
  transport.responses[1]!.resolve(response(transport.requests[1]!,{n:2}));
  assert.equal(await second,JSON.stringify({n:2}));
  assert.equal(relay.inFlightCount,0);
  assert.equal(relay.queuedCount,0);
  await relay.disconnect();
});

test("cancellation and timeout clean pending state and reject late completion",async()=>{
  const transport=new DeferredTransport();
  const relay=client(transport);
  await relay.connect();
  const cancelled=relay.request("cancel-me",{});
  assert.equal(relay.cancel("cancel-me"),true);
  await assert.rejects(cancelled,{code:"CANCELLED"});
  assert.equal(relay.inFlightCount,0);
  transport.responses[0]!.resolve(response(transport.requests[0]!,{late:true}));

  const timedOut=relay.request("time-out",{ },5);
  await assert.rejects(timedOut,{code:"TIMEOUT"});
  assert.equal(relay.inFlightCount,0);
  assert.deepEqual(transport.lifecycleEvents?.map(event=>event.state),undefined);
  assert.equal(relay.cancel("time-out"),false);
  await relay.disconnect();
});

test("disconnect/reconnect uses a new session and never replays old requests",async()=>{
  const transport=new DeferredTransport();
  const relay=client(transport);
  await relay.connect();
  const oldSession=relay.sessionId;
  const oldRequest=relay.request("old-request",{});
  await relay.disconnect();
  await assert.rejects(oldRequest,{code:"DISCONNECTED"});
  await relay.connect();
  assert.notEqual(relay.sessionId,oldSession);
  const current=relay.request("new-request",{});
  assert.equal(transport.requests.length,2);
  transport.responses[0]!.resolve(response(transport.requests[0]!,{stale:true}));
  transport.responses[1]!.resolve(response(transport.requests[1]!,{current:true}));
  assert.equal(await current,JSON.stringify({current:true}));
  assert.deepEqual(transport.requests.map(request=>request.request_id),["old-request","new-request"]);
  await relay.disconnect();
});

test("reference counterpart enforces its in-flight ceiling",async()=>{
  const blocked=deferred<unknown>();
  const transport=new InMemoryRemoteRelayReference(()=>blocked.promise,1);
  const relay=client(transport,{max_in_flight:2,max_queue:0});
  await relay.connect();
  const first=relay.request("bounded-1",{});
  await new Promise(resolve=>setImmediate(resolve));
  const second=relay.request("bounded-2",{});
  await assert.rejects(second,{code:"IN_FLIGHT_LIMIT"});
  blocked.resolve({done:true});
  assert.equal(await first,JSON.stringify({done:true}));
  await relay.disconnect();
});
