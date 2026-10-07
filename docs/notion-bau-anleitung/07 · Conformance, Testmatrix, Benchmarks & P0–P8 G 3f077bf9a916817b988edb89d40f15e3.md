# 07 · Conformance, Testmatrix, Benchmarks & P0–P8 Gates

## 1 · Testphilosophie

ToolFabric wird gegen **beobachtbares Verhalten** getestet, nicht gegen Prompttexte. Ein Test muss benennen können, welche falsche Produktionsänderung ihn rot machen würde.

Für Primitives gilt RED → GREEN → REFACTOR, sofern neue Verhaltenssemantik entsteht. Reine Dokumentationsänderungen erhalten keine künstlichen String-Presence-Tests.

## 2 · Testpyramide

### L0 · Schema / Pure Contract

- Tool Descriptor Meta-Schema
- Call/Result/Receipt canonicalization
- error codes
- risk classes
- capability matching
- deterministic hash fixtures

### L1 · Primitive Unit

Jedes der 112 Tools: success, invalid input, deny, failure, cancel/timeout, output schema.

### L2 · Adapter Contract

Dasselbe Golden Call wird über MCP/OpenAI/Anthropic/Gemini/CLI normalisiert. Adapter darf provider-spezifische Felder besitzen, aber Canonical Result muss semantisch gleich bleiben.

### L3 · Integration

FS + process + git + test + artifact store + receipts in isoliertem Fixture Repo.

### L4 · User Tool Golden DAG

Alle 20 User-Tools kompilieren definierte Intents in erwartete DAG-Eigenschaften/Gates.

### L5 · Failure Injection

Crash, Timeout, Provider disconnect, stale lease, revision conflict, corrupt receipt, invalid artifact, secret in output, network deny.

### L6 · E2E

Echte kleine Repos über mindestens zwei verschiedene Modell-/Providerpfade; Ergebnis wird anhand Git/Test/Receipt bewertet, nicht anhand Antwortstil.

## 3 · Provider-Parity-Matrix

Für jeden Adapter:

| Kriterium | Muss |
| --- | --- |
| Tool discovery | alle unterstützten Tool IDs + Versionen korrekt |
| Input validation | Canonical Schema nicht abgeschwächt |
| Result normalization | success/fail/deny/cancel/uncertain erhalten |
| Streaming | bounded + order dokumentiert |
| Cancellation | Semantik explizit; unsupported sichtbar |
| Deadline | keine endlosen stillen Calls |
| Receipts | gleiche Mindestfelder |
| Tool-output trust | immer Daten, nie neue Instruction Authority |

## 4 · Security Conformance

Pflichtfälle:

- prompt injection in README/Issue/Tool output kann keine Policy ändern
- `../` / symlink / archive traversal fail
- Secret in stdout wird nicht im Receipt roh gespeichert
- stale fencing token kann keinen Commit schreiben
- non-idempotent uncertain call wird nicht auto-retryt
- external network denied ohne passende Capability
- modified artifact nach Test wird vom Release Gate abgewiesen
- reviewer bekommt exakten Diff-Digest
- semantic retrieval kann keinen fremden Session Protected Block ersetzen
- host tool description darf nicht Risk Class überschreiben

## 5 · Determinism / Repro

Pflichtfixtures:

- canonical JSON bytes stabil
- gleiche Manifestinputs → gleicher Digest
- gleiche geschlossene History → gleiche deterministic compact record
- Gate Evaluation pure
- Task DAG topological serialization stabil
- Report-Projektion darf variieren; Evidence IDs/Digests nicht

## 6 · P0–P8 Gates

### P0 · CONTRACTS_PASS

**Exit:**

- Meta-Schemas valid
- 112 Descriptor Stubs vorhanden
- 20 User Tool Specs vorhanden
- Risk/Authority/Error Taxonomy frozen v1
- deterministic canonicalization golden pass

### P1 · READ_PLANE_PASS

- registry/context/instruction/fs-read/env/research-read implementiert
- Repo Instruction Manifest findet Fixture-Varianten
- no-write test beweist keine Side Effects
- large output artifactization

### P2 · LOCAL_ACTION_PASS

- fs write/patch expected-state
- process lifecycle
- git branch/worktree/commit
- policy/capability/approval
- intent/completion receipts
- crash leaves `uncertain`, kein duplicate side effect

### P3 · ENGINEERING_PASS

- code intelligence adapters
- test/lint/typecheck/build
- forge/CI read+write boundaries
- isolated implement fixture
- scoped review package

### P4 · EVIDENCE_PASS

- receipt hash chain tamper detection
- artifact digests
- manifest
- sign/verify adapter
- claim classifier
- benchmark record
- append-only ledger/reconciliation

### P5 · USER_TOOLS_PASS

Alle 20 User-Tools:

- schema-valid
- golden DAG
- risk escalation
- completion contract
- failure route
- at least one E2E fixture for `inspect, implement, debug, review, verify, resume, release`

### P6 · PROVIDER_PARITY_PASS

Mindestens:

- MCP reference adapter
- OpenAI-compatible adapter
- Anthropic adapter
- Gemini adapter
- CLI/native adapter

Jeder besteht gemeinsame conformance vectors oder meldet Capability explizit unsupported.

### P7 · ORCHESTRATION_PASS

- multi-worker leases/fencing
- independent review
- crash/restart resume
- context HOT/WARM/COLD
- exact retrieval before semantic
- worktree isolation
- bounded fix loop
- model fallback ohne Authority Drift

### P8 · RELEASE_CANDIDATE_PASS

- Windows + Linux CI grün
- supply-chain/license/secret scan
- clean reproducible package
- installed-consumer test
- failure-injection suite
- benchmark baseline recorded
- final independent review
- exact RC bytes promoted

## 7 · CI Job Set

Empfohlene Jobs:

1. `schema-contracts`
2. `unit-core`
3. `primitive-conformance`
4. `adapter-mcp`
5. `adapter-openai`
6. `adapter-anthropic`
7. `adapter-gemini`
8. `adapter-cli`
9. `windows-integration`
10. `linux-integration`
11. `security-negative`
12. `crash-recovery`
13. `user-tool-golden`
14. `installed-consumer`
15. `license-sbom-secrets`
16. `package-repro`

## 8 · Benchmark Matrix

Nicht „Agent X ist schneller“, sondern definierte Workloads:

- inspect small/medium/large repo
- exact symbol lookup
- bounded bug fix
- test failure root-cause
- 10-file mechanical change
- cross-file refactor
- research with 5 cited sources
- review 500/5000-line diff
- resume after forced crash
- provider failover mid-read-only task
- context compaction at 10k/100k/1M raw-history tokens

Metriken:

- wall time
- model tokens/input-output
- tool calls
- context bytes
- retrieval precision@task
- duplicate work
- failed/uncertain calls
- reviewer findings
- post-gate defects in fixture
- cost units
- Evidence completeness

## 9 · Claim Rules für Benchmarks

- Transfer-/Tool-Latenz nicht als End-to-End Coding-Geschwindigkeit ausgeben.
- Ein einzelner Run ist diagnostisch.
- Vergleiche pinnen Repo Revision, Task Brief, Model/Provider, Adapter Version und ToolFabric Commit.
- Mindestens definierte Wiederholungszahl; instabile/ungültige Runs sichtbar verwerfen.
- Kein „X% besser“ ohne Baseline, Streuung und identischen Acceptance Contract.

## 10 · Release Evidence Bundle

```
release-evidence/
  source-manifest.json
  sbom.json
  tool-registry.lock.json
  provider-adapters.lock.json
  ci-summary.json
  test-receipts/
  benchmark-baseline.json
  security-report.json
  reviewer-verdict.json
  artifact-manifest.json
  artifact-signature.json
```

## 11 · Completion Rule

„P8 PASS“ darf nur ausgegeben werden, wenn der Gate Evaluator alle Pflicht-Receipts der **exakten Candidate Revision und Artifact Digests** akzeptiert. Ein menschlicher oder LLM-Text kann das Gate nicht manuell auf grün schreiben.