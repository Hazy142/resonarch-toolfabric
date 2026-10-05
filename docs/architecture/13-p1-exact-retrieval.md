# P1C Exact and Lexical Retrieval

Status: implemented on the P1C branch. This slice adds deterministic read-only memory retrieval to the P1 reference runtime. It does **not** claim a persistent memory database, an SQLite FTS5 backend, semantic retrieval, or `P1_READ_PLANE_PASS`.

## Scope

P1C executes two existing R0 / side-effect-none primitives:

- `memory.get`
- `memory.search_exact`

The runtime receives an immutable `memoryRecords` snapshot through `ReadPlaneOptions`. That snapshot is host-provided read state; P1C does not expose `memory.put` and does not write an index into the workspace. The Context Gateway bridge can project closed WARM ToolFabric history into the same record shape, preserving call/tool/digest/artifact keys without copying raw large outputs back into HOT context.

Each record contains:

- stable `id`;
- `kind`;
- raw `text`;
- zero or more exact `keys` such as path, commit, call ID, or artifact ref;
- optional structured metadata.

The normalized snapshot is sorted by ID and bound to a canonical SHA-256 digest.

## Retrieval order

The architecture requires explicit reference / exact retrieval before lexical retrieval, with semantic retrieval last and optional. P1C keeps those modes visibly separate rather than silently widening a miss:

1. `memory.get` resolves one exact record ID or one unique declared key; ambiguous keys fail closed.
2. `memory.search_exact mode=exact` matches only a case-sensitive record ID or declared key.
3. `memory.search_exact mode=lexical` performs deterministic whole-term lexical matching through an in-memory inverted index.
4. Every retrieval path, including an explicit ID or artifact reference, requires an exact raw reload before a claim or action.
5. No semantic lookup is performed; every search result reports `semantic_used: false`.

An exact miss stays an exact miss. The runtime never auto-falls back from exact to lexical or semantic.

## Lexical semantics

Lexical mode:

- applies Unicode NFKC normalization and lowercase matching;
- tokenizes letters, numbers and path/reference punctuation;
- builds a deterministic token → record-ID inverted index at snapshot construction;
- intersects posting lists before scoring instead of scanning every record;
- requires every query term as a whole token;
- gives an explicit phrase-match bonus;
- otherwise ranks by term frequency;
- resolves ties by stable record ID;
- supports an exact `kind` filter;
- caps returned results through a validated `limit`.

This is deterministic lexical retrieval, not fuzzy matching, stemming, embeddings, or model judgment.

## Snapshot integrity

Configuration fails closed for duplicate IDs, malformed records, duplicate per-record keys, oversized fields, and snapshots beyond the bounded reference-runtime limits. The aggregate 32 MiB cap is enforced incrementally before full index construction, and lexical queries are bounded to at most 64 distinct terms.

Search outputs are candidate-only records: ID, kind, exact keys, match class, score and `record_digest`; raw text/metadata are deliberately omitted. `memory.get` performs the exact raw reload and returns the same `record_digest`, allowing the caller to bind candidate selection to the bytes/record actually consumed. Outputs are defensive copies, so mutating a returned result cannot modify later reads or the snapshot digest.

## Why this slice does not claim FTS5

The repository now also contains the Context Gateway's persistent SQLite `ToolHistoryStore`. That specialized session store opportunistically creates an FTS5 table and falls back to bounded SQL `LIKE` retrieval if FTS5 is unavailable. It is a runtime adapter for compacted tool history, not the canonical storage contract for `memory.*`.

The CI baseline for the TypeScript read plane is Node 22. On the physical development host, Node 22's built-in `node:sqlite` accepted SQLite itself but rejected `CREATE VIRTUAL TABLE ... USING fts5` with `no such module: fts5`. P1C therefore does not hide a native dependency or claim FTS5 availability in the canonical TypeScript runtime. It uses a deterministic in-memory inverted index over the immutable host snapshot.

`toolHistoryToMemoryRecords` provides the explicit interop boundary: only closed history with a result digest is projected, canonical artifact refs are revalidated, and open/incomplete calls remain outside the retrieval snapshot. This proves a path from Gateway WARM state into canonical P1 retrieval without making the Gateway database schema authoritative. P1C does **not** claim that `memory.search_exact` directly queries the Gateway SQLite file.

## Evidence

Behavioral tests verify:

- exact ID retrieval;
- exact unique-key retrieval and ambiguous-key fail-closed behavior;
- exact key search and case sensitivity;
- exact misses do not become lexical hits;
- whole-term lexical matching rejects prefixes;
- deterministic phrase-first ranking;
- case-normalized lexical parity;
- invalid query/mode/limit fail closed;
- task receipt chaining remains valid for denied calls;
- returned objects cannot mutate internal snapshot state;
- snapshot digest and hit order are independent of seed order;
- explicit kind filters and result windows;
- duplicate IDs fail during runtime construction;
- claim/action paths require exact raw reload for every retrieval path, including explicit IDs/artifact refs;
- closed Gateway WARM history projects into canonical memory records while open/incomplete calls are excluded and artifact refs are revalidated.

## Non-claims

Still open before `P1_READ_PLANE_PASS`:

- a persistent generic ToolFabric memory/control-plane store behind the canonical `memory.*` primitives;
- direct canonical binding of `memory.search_exact` to the specialized Context Gateway SQLite store; the TypeScript inverted index is rebuilt from the immutable host snapshot;
- research/web/docs read adapters with explicit network-read authority;
- remaining declared R0 reads;
- full read-only `research` and `audit` user-tool flows;
- the R1 `report.render` boundary for complete `inspect`;
- final complete-P1 Windows + Linux candidate validation.
