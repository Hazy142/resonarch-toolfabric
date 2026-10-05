# P1C Exact and Lexical Retrieval

Status: implemented on the P1C branch. This slice adds deterministic read-only memory retrieval to the P1 reference runtime. It does **not** claim a persistent memory database, an SQLite FTS5 backend, semantic retrieval, or `P1_READ_PLANE_PASS`.

## Scope

P1C executes two existing R0 / side-effect-none primitives:

- `memory.get`
- `memory.search_exact`

The runtime receives an immutable `memoryRecords` snapshot through `ReadPlaneOptions`. That snapshot is host-provided read state; P1C does not expose `memory.put` and does not write an index into the workspace.

Each record contains:

- stable `id`;
- `kind`;
- raw `text`;
- zero or more exact `keys` such as path, commit, call ID, or artifact ref;
- optional structured metadata.

The normalized snapshot is sorted by ID and bound to a canonical SHA-256 digest.

## Retrieval order

The architecture requires explicit reference / exact retrieval before lexical retrieval, with semantic retrieval last and optional. P1C keeps those modes visibly separate rather than silently widening a miss:

1. `memory.get` resolves one exact record ID.
2. `memory.search_exact mode=exact` matches only a case-sensitive record ID or declared key.
3. `memory.search_exact mode=lexical` performs deterministic whole-term lexical matching.
4. No semantic lookup is performed; every search result reports `semantic_used: false`.

An exact miss stays an exact miss. The runtime never auto-falls back from exact to lexical or semantic.

## Lexical semantics

Lexical mode:

- applies Unicode NFKC normalization and lowercase matching;
- tokenizes letters, numbers and path/reference punctuation;
- requires every query term as a whole token;
- gives an explicit phrase-match bonus;
- otherwise ranks by term frequency;
- resolves ties by stable record ID;
- supports an exact `kind` filter;
- caps returned results through a validated `limit`.

This is deterministic lexical retrieval, not fuzzy matching, stemming, embeddings, or model judgment.

## Snapshot integrity

Configuration fails closed for duplicate IDs, malformed records, duplicate per-record keys, oversized fields, and snapshots beyond the bounded reference-runtime limits.

Outputs are defensive copies. Mutating a returned result cannot modify later reads or the snapshot digest.

## Why this slice does not claim FTS5

The repository's local storage plan allows SQLite and lists FTS5 as an optional exact/lexical backend. The CI baseline is Node 22. On the physical development host, Node 22's built-in `node:sqlite` accepted SQLite itself but rejected `CREATE VIRTUAL TABLE ... USING fts5` with `no such module: fts5`.

P1C therefore does not hide a native dependency or claim FTS5 availability that the supported runner does not provide. The canonical retrieval behavior is implemented independently of a database product; a later storage adapter may map the same semantics onto FTS5, PostgreSQL text search, or another verified index.

## Evidence

Behavioral tests verify:

- exact ID retrieval;
- exact key retrieval and case sensitivity;
- exact misses do not become lexical hits;
- whole-term lexical matching rejects prefixes;
- deterministic phrase-first ranking;
- case-normalized lexical parity;
- invalid query/mode/limit fail closed;
- task receipt chaining remains valid for denied calls;
- returned objects cannot mutate internal snapshot state;
- snapshot digest and hit order are independent of seed order;
- explicit kind filters and result windows;
- duplicate IDs fail during runtime construction.

## Non-claims

Still open before `P1_READ_PLANE_PASS`:

- persistent local memory/control-plane storage;
- an optional verified FTS5 or equivalent indexed-storage adapter;
- research/web/docs read adapters with explicit network-read authority;
- remaining declared R0 reads;
- full read-only `research` and `audit` user-tool flows;
- the R1 `report.render` boundary for complete `inspect`;
- final complete-P1 Windows + Linux candidate validation.
