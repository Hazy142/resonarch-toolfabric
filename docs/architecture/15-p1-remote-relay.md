# P1E — Remote Relay Execution Bridge

P1E adds a provider-agnostic, contract-bounded Remote Relay transport client and reference counterpart (`resonarch.toolfabric.remote-relay.*/v1`) to ToolFabric without altering host authority or opening the Write Plane.

## Architectural Purpose & Boundaries

Remote Relay allows a local ToolFabric node to route typed tool execution requests to a remote host (such as a NodeOS lab instance or execution worker) over a secure, rate-bounded connection.

Key invariants:

- **Opt-in by default**: Remote relay is disabled by default (`enabled: false`) with no default hosted endpoint or fallback URL.
- **Authority Preservation**: Remote relay is purely a transport bridge. It cannot grant, widen, or escalate capabilities, bypass policy checks, or alter risk classes.
- **Session Isolation**: Every connection generates a unique `session_id`. Reconnection always establishes a fresh session and never replays unacknowledged requests.
- **Write Plane Protection**: Remote relay does not activate mutating primitives or bypass the read-plane gates.

## Contract & Envelopes

The transport uses three versioned envelope schemas:

- `REMOTE_RELAY_REQUEST_SCHEMA` (`resonarch.toolfabric.remote-relay.request/v1`)
- `REMOTE_RELAY_RESPONSE_SCHEMA` (`resonarch.toolfabric.remote-relay.response/v1`)
- `REMOTE_RELAY_LIFECYCLE_SCHEMA` (`resonarch.toolfabric.remote-relay.lifecycle/v1`)

### Request Envelope

```json
{
  "schema": "resonarch.toolfabric.remote-relay.request/v1",
  "kind": "request",
  "route_id": "route-alpha",
  "session_id": "c1f7b3...",
  "request_id": "req-001",
  "payload": { ... }
}
```

### Response Envelope

```json
{
  "schema": "resonarch.toolfabric.remote-relay.response/v1",
  "kind": "response",
  "route_id": "route-alpha",
  "session_id": "c1f7b3...",
  "request_id": "req-001",
  "ok": true,
  "payload": { ... }
}
```

Failed responses include an `error` object with standard code (`code`) and message (`message` max 256 chars):

```json
{
  "schema": "resonarch.toolfabric.remote-relay.response/v1",
  "kind": "response",
  "route_id": "route-alpha",
  "session_id": "c1f7b3...",
  "request_id": "req-001",
  "ok": false,
  "error": {
    "code": "REMOTE_ERROR",
    "message": "Execution failed on remote host"
  }
}
```

### Lifecycle Envelope

```json
{
  "schema": "resonarch.toolfabric.remote-relay.lifecycle/v1",
  "kind": "lifecycle",
  "route_id": "route-alpha",
  "session_id": "c1f7b3...",
  "state": "connected"
}
```

States include `connected`, `disconnected`, `cancelled`, and `timed_out`.

## Transport Security & Configuration

Configuration validation (`validateRemoteRelayConfig`) enforces strict security boundaries:

- **Protocols**: `https:`, `wss:`, or `http:`/`ws:` (loopback only when `allow_loopback: true` is set).
- **Credentials**: Passed via dynamic provider function (`RelayCredentialProvider`). Credentials are sanitized (disallowing line breaks and null bytes) and never embedded in URLs, query strings, or envelope bodies.
- **Resource Limits**:
  - `max_payload_bytes`: Default 64 KB, absolute maximum 1 MB.
  - `max_in_flight`: Default 8, absolute maximum 64.
  - `max_queue`: Default 32, absolute maximum 256.
  - `max_session_requests`: Maximum 4,096 unique request IDs per session.
  - `max_timeout_ms`: Maximum 120,000 ms.

## Queueing, Backpressure & Flow Control

`RemoteRelayClient` maintains deterministic flow control:

1. Requests up to `max_in_flight` are dispatched immediately via `transport.send()`.
2. Subsequent requests up to `max_queue` are placed in FIFO queue.
3. Exceeding `max_queue` fails closed immediately with `QUEUE_FULL`.
4. When any in-flight request finishes (either via success, error, cancellation, or timeout), `pump()` pops the next queued request and dispatches it immediately.
5. Correlation of `route_id`, `session_id`, and `request_id` is validated on every response envelope; mismatches reject with `CORRELATION_MISMATCH`.

## Reference Counterpart (`InMemoryRemoteRelayReference`)

The repository ships `InMemoryRemoteRelayReference` as a lightweight in-memory transport for unit testing and local development:

- Implements `RemoteRelayTransport`.
- Supports handler cancellation: passes `AbortSignal` to the handler and uses `Promise.race` to abort pending work immediately when cancelled or timed out client-side.
- Enforces an in-flight capacity limit (`maxInFlight`), throwing `IN_FLIGHT_LIMIT` when exceeded.
- Retains a bounded ring-buffer of up to 256 `lifecycleEvents`.

## Building Custom Compatible Counterparts

To implement a custom remote relay counterpart (e.g., a standalone Node.js / Python WebSocket relay server):

1. **Protocol Handshake**: Validate the connecting client's `credential`, `route_id`, and issue a unique `session_id`. Return a `connected` lifecycle notification.
2. **Envelope Validation**: Assert all incoming payloads adhere to `resonarch.toolfabric.remote-relay.request/v1`. Reject unknown schemas with `UNSUPPORTED_VERSION` and malformed json with `INVALID_ENVELOPE`.
3. **Correlation**: Preserve the client's `route_id`, `session_id`, and `request_id` in the corresponding response envelope.
4. **Cancellation**: Support signal cancellation for long-running operations. If the client disconnects or sends a cancellation signal, stop downstream execution.
5. **Limits**: Enforce max payload size (1 MB) and max in-flight requests. Return `ok: false` with appropriate error codes when limits are breached.

## Non-Claims

P1E does not claim:

- Production readiness of hosted remote endpoints.
- Automatic network failover or automatic session resumption.
- Activation of mutating write-plane capabilities.
- Direct integration with unverified third-party relay proxies.
