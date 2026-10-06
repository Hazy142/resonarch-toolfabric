# P1D — Network-authorized web fetch

P1D adds the first external-network read to the P1 Read Plane without opening any write path.

## Canonical contract correction

The P0 generator previously derived capability and side-effect semantics mechanically from risk class. That made read-only network primitives look like writes.

P1D corrects the generator source so these tools remain elevated network reads:

- `web.search`
- `web.fetch`
- `docs.resolve`
- `package.resolve`
- `vulnerability.search`

They use `network:web_read`, retain `risk_class=R2`, require network access, and declare `side_effect=none` with conditional idempotency. Because this corrects frozen capability/risk/side-effect semantics, the affected contracts are explicitly versioned as `2.0.0` rather than silently rewriting `1.0.0`. This does **not** mark the unimplemented network-read tools implemented.

`network.authorize@2.0.0` is a pure policy/broker decision with `network:authorize`, `risk_class=R0`, `side_effect=none`, and no network requirement. It cannot widen host authority.

## Host authority boundary

Network authority enters the runtime only through host-owned `NetworkReadPolicy` configuration:

- exact allowed hosts;
- expiry;
- maximum authorization/request count;
- maximum response bytes;
- explicit query-string allowance;
- `data_locality=public`.

No call argument can add a host, increase a byte/call budget, change locality, or extend policy lifetime.

A model/tool call may request `network.authorize`, but the broker only returns an internal single-use `network-auth://sha256:…` reference if the requested target already fits the host policy. The authorization is bound to task ID, normalized URL, method, policy digest and runtime state. It cannot cross tasks, URLs or methods and it cannot be replayed.

## Native HTTPS transport

The reference transport is intentionally narrow:

- HTTPS only;
- port 443 only;
- GET or HEAD only;
- no caller-supplied cookies, Authorization headers, custom headers or credentials;
- exact host allowlist;
- query strings denied unless host policy opts in;
- URL credentials and fragments denied;
- DNS is resolved before connection;
- private, loopback, link-local, documentation, benchmark, multicast and other reserved IP ranges fail closed;
- all DNS answers must be public;
- the selected validated address is pinned for the TLS connection to avoid a second DNS lookup;
- TLS SNI/certificate verification remains bound to the authorized hostname;
- response size is bounded while streaming;
- redirects are returned as metadata and are **not** followed;
- custom transports are rejected if they silently substitute/follow a different URL.

The IPv4-mapped IPv6 path decodes and re-checks the underlying IPv4 address instead of blanket-blocking all IPv4. A physical smoke caught that classifier bug before merge.

## Evidence and artifacts

`web.fetch@2.0.0` stores the exact response body in the existing content-addressed Artifact Store. Output binds:

- requested/final URL;
- HTTP status;
- content type;
- ETag / Last-Modified when present;
- redirect location when present;
- retrieval timestamp;
- byte count;
- `sha256:…` body digest;
- matching `artifact://sha256:…` reference.

Small textual bodies may additionally be returned inline. Large/raw bodies remain artifact-addressable. The artifact ref is included in the normal ToolFabric result and receipt chain.

## Workflow capability projection

The generated `research` and `audit` user-tool specs now declare `network:web_read`, and the workflow compiler preserves that requirement in the compiled workflow instead of dropping it. This is a declaration of required capability, not a grant. The host/network policy remains authoritative.

## Physical evidence

On Dell-G, the native transport fetched `https://example.com/` through an exact `example.com` host policy:

- authorization: succeeded;
- fetch: succeeded;
- HTTP 200;
- 577 bytes;
- body digest: `sha256:25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`;
- artifact ref matched the same digest;
- artifact re-read returned 577 bytes;
- fetch receipt chained to the authorization receipt;
- no redirect was followed.

This is E2 evidence for the tested host/run only, not a claim that arbitrary internet targets or every DNS/TLS environment work.

## Non-claims

P1D does not yet implement:

- `web.search`;
- `docs.resolve`;
- `package.resolve`;
- `vulnerability.search`;
- source comparison/bundling E2E;
- generic credentialed HTTP;
- proxy support;
- redirects;
- POST/PUT/PATCH/DELETE;
- private-network access;
- semantic retrieval;
- `P1_READ_PLANE_PASS`;
- any P2 mutation capability.
