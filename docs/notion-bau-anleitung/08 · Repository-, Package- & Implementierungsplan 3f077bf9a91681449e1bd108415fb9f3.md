# 08 · Repository-, Package- & Implementierungsplan

## 1 · Referenz-Implementierung

**Empfehlung:** TypeScript/Node als Reference Runtime, weil vorhandene ARCHY-/MCP-/Connector-Arbeit dort bereits anschließt. Die **Contracts bleiben sprachneutral** als JSON Schema/OpenAPI-ähnliche Dokumente.

Optional native Sidecars (Rust/C/C++) sind für Performance/OS-Sandbox zulässig, besitzen aber keine abweichende Tool-Semantik.

## 2 · Monorepo

```
resonarch-toolfabric/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ pnpm-workspace.yaml
├─ contracts/
│  ├─ meta/
│  ├─ calls/
│  ├─ results/
│  ├─ receipts/
│  ├─ capabilities/
│  ├─ authority/
│  └─ tools/
│     ├─ registry/
│     ├─ context/
│     ├─ fs/
│     ├─ process/
│     ├─ git/
│     ├─ forge/
│     ├─ code/
│     ├─ verify/
│     ├─ research/
│     ├─ tasks/
│     ├─ memory/
│     ├─ security/
│     ├─ evidence/
│     └─ artifacts/
├─ user-tools/
│  ├─ inspect.yaml
│  ├─ plan.yaml
│  ├─ implement.yaml
│  └─ ... 20 total
├─ packages/
│  ├─ core/
│  ├─ registry/
│  ├─ policy/
│  ├─ scheduler/
│  ├─ context/
│  ├─ memory/
│  ├─ evidence/
│  ├─ artifact-store/
│  ├─ workspace/
│  ├─ adapters/
│  │  ├─ mcp/
│  │  ├─ openai/
│  │  ├─ anthropic/
│  │  ├─ gemini/
│  │  └─ cli/
│  ├─ providers/
│  ├─ cli/
│  ├─ mcp-server/
│  └─ sdk/
├─ conformance/
│  ├─ vectors/
│  ├─ fixture-repos/
│  ├─ provider-parity/
│  ├─ failure-injection/
│  └─ user-tool-golden/
├─ tests/
├─ benchmarks/
├─ docs/
│  ├─ architecture/
│  ├─ contracts/
│  ├─ threat-model/
│  └─ evidence/
└─ evidence/
```

## 3 · Package Boundaries

### `@resonarch/toolfabric-contracts`

Nur Schemas, IDs, Versionen, canonical serialization fixtures. Keine Provider SDK dependency.

### `@resonarch/toolfabric-core`

DAG, states, error types, pure gate evaluator.

### `@resonarch/toolfabric-policy`

Capabilities, authority, approvals, risk classification. Kein LLM.

### `@resonarch/toolfabric-evidence`

Receipts, hash chain, manifests, artifact digests, optional signer interface.

### `@resonarch/toolfabric-runtime`

Scheduler, leases, durable store, call lifecycle.

### `@resonarch/toolfabric-adapter-*`

Ausschließlich Projektion/Normalization zum jeweiligen Host/Provider.

### `@resonarch/toolfabric-mcp`

Expose Backend Registry als MCP Server; MCP ist Delivery-Mechanismus, nicht Produktsemantik.

### `@resonarch/toolfabric-cli`

`toolfabric inspect|plan|implement|...` für lokale Nutzung/Tests.

## 4 · Storage v0

Lokale Referenz:

- SQLite WAL für Task/Call/Lease/Ledger
- content-addressed Filesystem Store für Artifacts
- JSONL Receipt Chain pro Task + DB Index
- optional FTS5 für exact/lexical retrieval
- optional Vector Adapter erst **hinter** exact retrieval

Später:

- Postgres für verteilte **ToolFabric Execution Control Plane**; globale ARCHY Revision-/WorkOrder-State bleibt separat host-owned
- S3/Object Store für große Artifacts
- S3 Vectors/pgvector/anderer Index als austauschbarer Semantic Adapter

## 5 · P0 · Contract Freeze

Deliverables:

- 112 Descriptor JSONs
- 20 User Tool YAMLs
- `tool.schema.json`, `call.schema.json`, `result.schema.json`, `receipt.schema.json`
- error codes
- risk classes
- capability grammar
- authority contract
- deterministic serializer + golden fixtures
- `REGISTRY.md`
- `THREAT-MODEL.md`

**Gate:** `P0_CONTRACTS_PASS`.

## 6 · P1 · Read Plane

Implementieren:

- A, B, C-read, D-read, I-read, K-read Kernprimitives
- instruction discovery
- repo inspection
- web/docs research adapters
- content-addressed Artifact Store
- FTS exact retrieval

Erster User-Tool PASS: `inspect`, `research`, read-only `audit`.

## 7 · P2 · Local Action Plane

Implementieren:

- fs.write/patch/move
- process lifecycle
- git branch/worktree/commit/rebase/merge lokal
- policy/capability/approval
- intent/completion receipt
- expected-state conflict handling

Erster echter Fixture Flow: User gibt „ändere Funktion X“ → isolierter Worktree → Patch → Test → Receipt.

## 8 · P3 · Engineering Plane

Implementieren:

- Code intelligence
- test/lint/typecheck/build
- forge/CI
- task brief/report/review package
- `implement`, `fix`, `debug`, `test`, `review`

GitHub ist erster Forge Adapter; Interface muss GitLab/Gitea/Forgejo später zulassen.

## 9 · P4 · Evidence Plane

Implementieren:

- manifest
- receipt chain verify
- signer interface
- benchmark records
- claim classifier
- open-intent reconciliation
- `verify`

Diese Phase muss existieren **bevor** ToolFabric eigene starke Reliability-Claims macht.

## 10 · P5 · User Tool Compiler

Alle 20 Workflow Specs:

- compile to DAG
- policy/risk expansion
- provider-independent
- golden DAG tests
- dynamic optional steps nur über deklarierte predicates

Beispiel:

`implement` fügt `typecheck.run` nur hinzu, wenn `test.discover`/Repo Contract einen Typecheck kennt; es erfindet keinen Command.

## 11 · P6 · Provider Adapter

Reihenfolge:

1. MCP `2026-07-28` Baseline + expliziter Legacy-Compatibility-Adapter
2. OpenAI-compatible
3. Anthropic
4. Gemini
5. CLI/native JSON-RPC

Für MCP zusätzlich verpflichtend: stateless request compatibility; `server/discover`/progressive capability projection; `Mcp-Method`/`Mcp-Name` routing metadata; Tasks als external handles; MRTR/input-required propagation; Resources/Skills/Apps projection semantics; cache metadata; versionierte Extension-Fallbacks; Auth-/Issuer-Validation ohne Authority-Eskalation. Jeder Adapter bekommt dieselben conformance vectors. Zusätzliche Provider sind neue Adapter, keine Forks des Core.

## 12 · P7 · Multi-Agent

- worker registry
- leases/fencing
- dispatch/resume
- independent review
- model router
- parallel read/research
- isolated parallel writes
- crash recovery
- HOT/WARM/COLD
- semantic retrieval optional

Integration mit ARCHY erfolgt hier als **Strategic Control Plane + Agentic Revision Graph Host**. ToolFabric konsumiert einen delegierten WorkOrder-/Action-/Revision-Scope und liefert Execution-Results/Receipts zurück; es dupliziert weder ARCHYs globale Timeline noch WorkOrder-/Session-/Branch-/Merge-/Revert-Authority.

## 13 · P8 · Package/Promotion

Outputs:

- npm packages
- standalone MCP server
- CLI
- SDK
- provider plugins
- locked registry bundle
- signed release evidence

Release wird aus bereits geprüften Bytes gebaut/promotet, nicht nachträglich neu kompiliert.

## 14 · [AGENTS.md](http://AGENTS.md) für das neue Repo

Muss mindestens festlegen:

1. ToolFabric ist Contract-/Execution-Layer, keine Domain-Authority.
2. Kein Provider-spezifischer Contract im Core.
3. Keine Tool-ID ohne Schema + tests + risk/authority.
4. No raw secret logging.
5. Mutating calls brauchen expected state soweit sinnvoll.
6. `uncertain` niemals in `failed` oder `success` raten.
7. Negative evidence behalten.
8. User Tool Änderungen benötigen Golden DAG Update.
9. Adapter dürfen Core Semantik nicht abschwächen.
10. Release: unchanged bytes.
11. Jede Completion mit relevanten Gates.
12. One focused vertical slice per PR.

## 15 · Erster Implementierungssprint

**Sprint 0A – 112 Stubs + Validator**

- Descriptor files generieren
- Meta-Schema
- Registry Loader
- duplicate ID/version detection
- snapshot digest

**Sprint 0B – Receipt Kernel**

- canonical serialization
- hash chain
- intent/completion API
- verify command

**Sprint 0C – inspect**

- instructions
- git status
- fs read/search
- test discovery
- repo report

**Sprint 0D – MCP expose**

- Registry als MCP Tools
- canonical ↔ MCP mapping
- ARCHY Host-Context/Trace-Binding in Call + Receipt
- MCP Task IDs ausschließlich als external execution handles
- Resources als versionierte Projektionen; MRTR/Input-Requests als gebundene Host-Events
- conformance fixture inkl. stateless/reconnect + handle correlation

Danach erst Writes.

## 16 · Definition of Done für eine Primitive

Eine Primitive ist erst `implemented`, wenn:

- Descriptor + schemas committed
- Reference implementation
- success + negative + deny tests
- receipt
- timeout/cancel
- docs
- conformance vector
- adapter mapping oder explicit unsupported
- no secret/raw-large-output regression
- risk/authority reviewed

## 17 · Definition of Done für ein User-Tool

- Intent schema
- Workflow spec
- Golden DAG
- required capabilities
- default budgets
- gate set
- failure routes
- at least one realistic fixture
- Completion Contract
- Evidence Projection
- provider-independent E2E pass

## 18 · Nicht-Ziele v0.1

- kein eigener allgemeiner LLM-Provider
- kein Ersatz für ARCHY
- keine Domainformeln/ERP-/Physik-Authority
- keine Browser-Automation als Sicherheitsprimitive
- keine Behauptung „exactly once“ über Systeme ohne Idempotency/Transaction Support
- kein freies Langzeitgedächtnis ohne expliziten Memory Contract
- kein Prompt-Marktplatz als Kernprodukt

## 19 · Implementierungsstatus · P1A Read Execution Core · 05.10.2026

<aside>
🟢

**Implementiert, aber noch kein `P1_READ_PLANE_PASS`.** Der erste reale Execution-Slice wurde über [PR #11](https://github.com/Hazy142/resonarch-toolfabric/pull/11) gemerged; geprüfter PR-Head `c483473d3ef3d7c3630352bfb522184707f4d113`, Main-Merge `ebc6ee08ca15b2ccaa966639b213164b1adfebc1`.

</aside>

**Reale Ausführung:** `registry.list`, `registry.describe`, `instructions.discover`, `fs.read`, `fs.read_many`, `fs.list`, `fs.stat`, `fs.search`, `git.status`, `git.log`, `git.diff`, `env.snapshot`, `command.which`.

**P1-Sicherheitsgrenze:** Workspace-Root-Sandbox; absolute/`..`/Symlink-Escapes fail-closed; mutierende Descriptoren werden vor Dispatch mit `P1_WRITE_FORBIDDEN` abgewiesen. Git läuft über das echte Binary per `execFile` ohne Shell; optionale Locks/fsmonitor sowie externe Diff-/Textconv-Pfade sind deaktiviert. Host-`GIT_DIR`/`GIT_WORK_TREE`- und verwandte Redirect-Variablen werden entfernt; Parent-Repo-Discovery wird durch `GIT_CEILING_DIRECTORIES` begrenzt.

**Evidence auf exaktem Head:** lokaler Vollgate `45/45` Tests; Registry `112 / 14`; `20` User-Tool-Workflow-Specs; physischer Smoke gegen das echte ToolFabric-Working-Tree: `fs.read` succeeded, `git.status` succeeded, `env.snapshot` redacted `AWS_SECRET_ACCESS_KEY`, `fs.patch` denied/`P1_WRITE_FORBIDDEN`, Workspace-lokaler Artifact-Root denied/`ARTIFACT_STORE_SCOPE` ohne Verzeichnisanlage, Git-Status vor/nach Ausführung bytegleich.

**Artifactization:** große kanonische Outputs werden außerhalb des Workspaces content-addressed gespeichert; Artifact-Roots werden vor Ausführung sowohl lexikalisch als auch über existierende Symlink-Ancestors gegen den Workspace geprüft; Artifact-Refs sind strikt `artifact://sha256:<64 hex>`; Store-Commit erfolgt temp → sync → rename.

**Offen bis P1 PASS:** Research-/Docs-Read-Adapter, Exact/FTS Retrieval, restliche P1-Read-Primitives und read-only E2E für `inspect`/`research`/`audit`. P1A selbst ist auf Windows+Linux CI-grün; ein vollständiger P1-Candidate existiert noch nicht.

**P2 bleibt gesperrt:** `fs.write/patch/move`, Process-Lifecycle sowie Git-Branch/Worktree/Commit/Rebase/Merge werden erst nach expected-state + Policy/Capability/Approval + Intent/Completion/Uncertain-Reconciliation freigeschaltet.

## 20 · Implementierungsstatus · P1B Local Inspect Read · 06.10.2026

<aside>
🟢

**Gemerged und auf Windows + Linux CI verifiziert, aber weiterhin kein `P1_READ_PLANE_PASS`.** [PR #12 · P1B: execute local inspect read primitives](https://github.com/Hazy142/resonarch-toolfabric/pull/12) wurde auf `main` gemerged. Geprüfter PR-Head: `b465fdeac78c467f96b8162e338cbc1da20148e9`; Merge-Commit: `1d6cc0c6e2bfe1c226cdb867b599a0396224e837`.

</aside>

**Neu real ausführbar:** `instructions.resolve`, `code.symbols`, `code.dependencies`, `test.discover` und `context.pack`. Zusammen mit P1A existiert damit ein realer read-only Local-Inspect-Core über Registry, Instructions, Filesystem, Git, Environment, JS/TS-Codeanalyse, Dependency-/Test-Discovery und deterministisches Context Packing.

**Fail-closed-Hardening:** ungültiges `package.json` sowie nicht-stringige Scriptwerte werden von `test.discover` als `MANIFEST_INVALID` abgewiesen. Der Fix entstand aus zwei vorab roten Regressionstests; zuvor wurde kaputtes JSON als generischer `EXECUTION_FAILED` klassifiziert und ein numerisches `test`-Script still ignoriert.

**Receipt-Chain-Hardening:** der zusammengesetzte achtstufige Inspect-Fixture-Flow deckte auf, dass der Reference Runtime zuvor jeder Receipt erneut auf `sha256:GENESIS` zeigte. Der Runtime-Tail wird jetzt pro `task_id` fortgeschrieben; mehrere Calls desselben Tasks bilden eine durch `verifyChain` geprüfte Hash-Kette, während getrennte Tasks keinen Tail voneinander erben. Der Tail ist weiterhin In-Memory-Reference-State und **kein** Claim auf durable Crash-Recovery oder einen vollständigen P4-Ledger.

**Evidence auf exaktem PR-Head:** Dell-G Direct Gate **55/55 Tests PASS**; Registry **112 Descriptoren / 14 Familien**; **20/20** User-Tool-Workflow-Specs; `git diff --check` clean. GitHub CI auf demselben Head: **Ubuntu PASS** und **Windows PASS**, jeweils einschließlich `npm run check` und Generated-Tree-Cleanliness. Es existieren keine offenen Review-Threads; Copilot konnte wegen Quota keinen inhaltlichen Review liefern.

**Inspect-Grenze:** `inspect.yaml` enthält weiterhin `report.render`. Diese Primitive bleibt R1 / `side_effect=projection` und wird im P1-Executor korrekt mit `P1_WRITE_FORBIDDEN` blockiert. Deshalb ist der lokale read-only Inspect-Core nachgewiesen, nicht der vollständige `inspect`-User-Tool-PASS.

**Offen bis P1 PASS:** Exact/FTS Retrieval, Research-/Docs-/Web-Read-Adapter mit expliziter Network-Read-Authority, restliche deklarierte R0-Reads, vollständige read-only `research`-/`audit`-E2E-Flows sowie der abschließende komplette P1-Candidate auf Windows + Linux.

## 21 · Implementierungsstatus · P1C Exact Retrieval · 06.10.2026

<aside>
🟢

**Gemerged und auf Windows + Linux CI verifiziert, aber weiterhin kein `P1_READ_PLANE_PASS`.** [PR #14 · P1C: execute exact and lexical memory retrieval](https://github.com/Hazy142/resonarch-toolfabric/pull/14) lieferte die Retrieval-Engine und wurde auf `main` als `efb6b3798af0615031447f7d512ca8c3510702b7` gemerged (PR-Head `df55d23bff618c5ef36d5a960523e824cf517ed3`). Der nachgelagerte normative Audit wurde durch [PR #15 · P1C follow-up: align raw reload and snapshot byte bounds](https://github.com/Hazy142/resonarch-toolfabric/pull/15) geschlossen; geprüfter Follow-up-Head `6346112b534995408a101324de819171cbd9f7a4`, finaler Main-Merge `9013cffb3433f0560c3672eba72f23662066ec73`.

</aside>

**Neu real ausführbar:** `memory.get` und `memory.search_exact` sind in die P1-Read-Plane eingebunden. `memory.get` lädt exakt per Record-ID oder eindeutigem deklariertem Key; mehrdeutige Keys brechen mit `MEMORY_KEY_AMBIGUOUS` fail-closed ab. Die Suchprimitive trennt exakten, case-sensitiven ID-/Key-Lookup von deterministischer lexikalischer Suche.

**Retrieval-Grenze:** Die lexikalische Suche verwendet einen deterministischen In-Memory-Inverted-Index über einen unveränderlichen Host-Snapshot. Search liefert nur Candidate-Metadaten plus `record_digest`; Raw-Text und Metadata werden erst über den exakten `memory.get`-Reload geladen. Entsprechend Seite 05, Retrieval Order Schritt 6, benötigt **jeder** Retrieval-Pfad vor Claim oder Action eine exakte Raw-Nachladung – ausdrücklich auch eine explizite ID oder Artifact-Ref. Exact-Misses werden niemals still auf lexical oder semantic erweitert.

**Context-Gateway-Kopplung:** Geschlossene WARM-Tool-History kann über die gemeinsame ToolFabric-Grenze in kanonische Memory-Records projiziert werden. Call-ID, Tool-ID, Request-/Result-Digests und kanonische `artifact://sha256:…`-Refs werden als Retrieval-Keys erhalten; offene oder unvollständige Calls werden nicht indexiert und Artifact-Refs an der Projektionsgrenze erneut validiert. Damit ist die zuvor gemergte Gateway-Runtime jetzt nicht nur artifact-kompatibel, sondern an den kanonischen Exact-Retrieval-Pfad gekoppelt.

**Ressourcen-/Fail-closed-Hardening:** max. 10.000 Records, 32 MiB kanonischer aggregierter Snapshot mit inkrementeller Prüfung vor vollständigem Indexaufbau, 1 MiB Text pro Record, max. 64 Keys pro Record und max. 64 distinkte Query-Terme. Der Follow-up #15 zählt die JSON-Array-Klammern und Trenn-Kommas bytegenau in diese 32-MiB-Grenze ein. Duplicate IDs, ungültige Records und übergroße Snapshots werden vor Serving abgewiesen.

**FTS5-Grenze:** Der lokale Node-22-Runner unterstützt SQLite, aber sein eingebautes `node:sqlite` stellte physisch kein FTS5-Modul bereit (`no such module: fts5`). P1C behauptet deshalb keinen SQLite-FTS5-Backend-PASS. Der kanonische Reference Runtime verwendet den deterministischen In-Memory-Index; ein persistenter FTS5/Postgres-/anderer Adapter kann später dieselbe Retrieval-Semantik implementieren.

**Evidence nach Engine-Merge + Norm-Follow-up:** lokaler Vollgate auf dem finalen Follow-up-Inhalt **72/72 TypeScript-Tests PASS**; Registry **112 Descriptoren / 14 Familien**; **20/20** User-Tool-Workflow-Specs; die unveränderte Context-Gateway-Python-Suite **16/16 PASS**. Für PR #15 liefen auf exakt `6346112b534995408a101324de819171cbd9f7a4` alle vier GitHub-Jobs grün: `check` auf Ubuntu + Windows sowie `gateway` auf Ubuntu + Windows, inklusive Generated-tree-Cleanliness. Es gab keine offenen Review-Threads; Copilot lieferte wegen Quota keinen inhaltlichen Review.

**Nicht nachgewiesen / weiterhin offen bis P1 PASS:** persistente generische Memory-/Control-Plane-Datenbank hinter `memory.*`, semantisches Retrieval, Research-/Docs-/Web-Read-Adapter mit expliziter Network-Read-Authority, restliche deklarierte R0-Reads, vollständige read-only `research`-/`audit`-E2E-Flows, die `report.render`-Grenze für das vollständige `inspect`-User-Tool sowie ein abschließender vollständiger P1-Candidate auf Windows + Linux.

**P2 bleibt gesperrt.** Der nächste Bauabschnitt nach dieser Anleitung ist P1D: Research-/Docs-/Web-Read mit expliziter Netzwerk-Autorisierung und zitier-/digestgebundener Quellenaufnahme.

## 22 · Implementierungsstatus · P1D Network-authorized Web Fetch · 06.10.2026

<aside>
🟢

**Gemerged und auf Windows + Linux CI verifiziert, aber weiterhin kein `P1_READ_PLANE_PASS`.** [PR #16 · P1D: add network-authorized content-addressed web fetch](https://github.com/Hazy142/resonarch-toolfabric/pull/16) wurde auf `main` gemerged. Geprüfter PR-Head: `ca808566f1a52777a134693fba538aacdba285a7`; Squash-Merge: `faf9dbda8e14e60514502b2a3c18295a1aaaadb5`.

</aside>

**Neu real ausführbar:** `network.authorize@2.0.0` und `web.fetch@2.0.0`. Damit existiert erstmals ein physisch ausgeführter externer Network-Read-Pfad innerhalb der P1-Read-Plane, ohne einen P2-Schreibpfad zu öffnen.

**Normative Contract-Korrektur:** Der ursprüngliche P0-Generator hatte erhöhte Netzwerk-Risikoklasse fälschlich mechanisch in Write-Capabilities und externe Side Effects übersetzt. Die Generatorquelle ist korrigiert. `web.search`, `web.fetch`, `docs.resolve`, `package.resolve` und `vulnerability.search` verwenden jetzt `network:web_read`, bleiben wegen Network-Egress R2, benötigen `network=required`, haben aber `side_effect=none` und conditional idempotency. `network.authorize` verwendet `network:authorize`, R0, `side_effect=none`, `network=forbidden`. Weil dies eingefrorene Semantik ändert, wurden diese sechs Contracts ausdrücklich auf **2.0.0** versioniert statt `1.0.0` still umzudeuten. Von diesen sechs Primitives implementiert dieser Slice ausschließlich `network.authorize@2` und `web.fetch@2`.

**Authority-Grenze:** Netzwerkautorität kommt ausschließlich aus einer host-owned `NetworkReadPolicy`: exakte erlaubte Hosts, Ablaufzeit, Request-/Authorization-Budget, maximale Response-Bytes, Query-Allowance und `data_locality=public`. Tool-/Model-Argumente können diese Authority nicht erweitern. Eine erfolgreiche `network.authorize`-Entscheidung erzeugt eine runtime-interne, single-use `network-auth://sha256:…`-Ref, gebunden an `task_id`, normalisierte URL, GET/HEAD-Methode und Policy-Digest. Cross-Task-, Cross-URL-, Cross-Method- und Replay-Versuche failen geschlossen.

**Reference Transport / SSRF:** HTTPS-only, Port 443, GET/HEAD, keine caller-provided Cookies/Authorization-Headers/Credentials, keine URL-Credentials, kein stilles Redirect-Following. DNS wird vor Connect aufgelöst; alle A/AAAA-Ergebnisse müssen öffentlich sein. Der validierte Ziel-Address wird für die TLS-Verbindung gepinnt, während SNI/Zertifikatsprüfung auf dem autorisierten Hostnamen bleibt. Private, Loopback-, Link-local-, Dokumentations-, Benchmark-, Multicast- und andere reservierte Bereiche werden abgewiesen. Ein physischer Smoke deckte dabei vor Merge einen IPv4-mapped-IPv6-Klassifizierungsfehler auf; der Fix hat eigene Regressionstests.

**Evidence-/Artifact-Bindung:** Der exakte Response-Body wird unabhängig von Inline-Text content-addressed in den bestehenden Artifact Store geschrieben. Output und Receipt binden URL, Status, Content-Type, ETag/Last-Modified soweit vorhanden, Redirect-Metadaten, Retrieval-Zeit, Bytezahl, `sha256:…` und die passende `artifact://sha256:…`-Ref. Custom Transports werden abgewiesen, wenn sie die autorisierte URL still ersetzen oder einem Redirect folgen.

**Workflow-Capability-Projektion:** Die generierten `research`- und `audit`-Specs deklarieren jetzt `network:web_read`; `compileWorkflow()` bewahrt diese `required_capabilities` im kompilierten Workflow, statt sie zu verlieren. Dies ist eine Capability-Anforderung, keine Grant-Authority.

**Physischer Native-HTTPS-E2-Smoke auf Dell-G:** exakte Host-Policy `example.com` → Authorization **succeeded** → Fetch **succeeded** → HTTP **200** → **577 Bytes** → Body-Digest `sha256:25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484` → identische `artifact://sha256:25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484` → Artifact-Re-Read ebenfalls 577 Bytes → Fetch-Receipt korrekt an Authorization-Receipt gekettet → kein Redirect gefolgt. Das ist E2-Evidence für diesen exakten Host/Run, kein Claim auf beliebige Netzumgebungen.

**Gates auf exakt `ca808566f1a52777a134693fba538aacdba285a7`:** post-commit `npm run check` **PASS**; **83/83 TypeScript-Tests PASS**; P1D-Target-Suite **10/10 PASS**; Registry **112 Descriptoren / 14 Familien**; **20/20** User-Tool-Workflow-Specs; unveränderte Context-Gateway-Python-Suite **16/16 PASS**; Generated Tree nach Regeneration byte-clean. GitHub CI: `check` **Ubuntu PASS + Windows PASS** und `gateway` **Ubuntu PASS + Windows PASS**. Branch war vor Merge 0 Commits hinter `main`; keine offenen Review-Findings, Copilot-Review lediglich wegen Quota nicht verfügbar.

**Nicht nachgewiesen / weiterhin offen:** `web.search`, `docs.resolve`, `package.resolve`, `vulnerability.search`, credentialed Generic HTTP, Proxy-Support, Redirect-Following, Private-Network-Egress, vollständige `source.compare`-/`research.bundle`-Kette, read-only `research`-/`audit`-E2E, vollständiger P1-Candidate sowie Production Readiness.

**P2 bleibt gesperrt.** Der nächste fokussierte Bauabschnitt ist der Network-Research-Discovery-Slice: zunächst `web.search@2` hinter derselben Network-Authority, danach Docs/Package/Vulnerability-Resolver und erst anschließend die vollständige source-bound `research`-/`audit`-E2E-Kette.

## 23 · Architekturentscheidung · Open Source und optionaler Hosted Relay

Entscheidung vom 7. Oktober 2026. Status: beschlossenes Zielbild; Implementierung und öffentliche Service-Freigabe sind noch nicht nachgewiesen.

ToolFabric bleibt unabhängig von einem bestimmten Hosting-Anbieter oder Relay-Service nutzbar. Lokaler Betrieb und die Anbindung eigener kompatibler Gateways müssen ohne ResonArch-Konto oder ResonArch-Infrastruktur möglich bleiben.

### Öffentliche Repository-Grenze

- Das öffentliche Repository `Hazy142/resonarch-toolfabric` enthält Contracts, lokale Runtime, MCP-Server, generische Relay-Anbindung, versionierte öffentliche Protokollbeschreibung sowie lokale Referenzgegenstelle und Conformance-Tests.
- Kein hartcodierter IONOS-Endpunkt, kein erforderlicher Hosted-Account, kein automatischer Verbindungsaufbau zum Hosted-Service und keine private API als Voraussetzung für eigene Gateways.
- Relay-Anmeldung darf lokale Workspace-Rechte nicht erweitern. Lokale Read-only-Grenzen bleiben bestehen, bis die vorgesehenen Write-Gates bestanden sind.

### Privater Hosted-Service

- Der konkrete IONOS-Relay, Deployment, Website/Portal, Konten, Geräte-Pairing, Zugangsausgabe, Quoten, Abuse-Schutz und Betriebssteuerung gehören in ein separates privates Repository. Dessen Anlage oder Deployment ist durch diesen Entscheid nicht ausgeführt.
- Produktionsschlüssel gehören in Secret-Management, nicht in Git. Der bestehende Context Gateway bleibt fachlich getrennt: Kontext-/Tool-History-Kompaktierung ist nicht Remote-Verbindungsrouting.
- Der Hosted Relay ist ein ausdrücklich gewählter Komfortdienst. Der Verlust eines Testplatzes oder ein Service-Ausfall darf lokalen Betrieb nicht verhindern.

### Testzugang und Kapazität

- Eine Website ermöglicht Warteliste, benchmarkabhängig begrenzte Testplätze, Geräteverwaltung und widerrufbaren MCP-Zugang ohne eigene öffentliche Server-Infrastruktur. Der lokale PC und die Anwendung müssen laufen.
- Website-Konto, Geräte-Credential und MCP-Client-Zugang bleiben getrennt. Bearer-Zugänge sind nur für getestete kompatible Clients vorgesehen; breitere Authentifizierung erfolgt über einen separat geprüften OAuth-Ablauf.
- Zulassung und Limits werden serverseitig durchgesetzt: Konten, Geräte, aktive Verbindungen, parallele Aufrufe, Byte-Budgets, Größenlimits und begrenzte Warteschlangen. Nutzerzahlen werden erst aus gemessenen Lastprofilen mit Betriebsreserve abgeleitet.
- TLS-Terminierung kann Inhalte für den Relay sichtbar machen; keine unbelegte Ende-zu-Ende-Vertraulichkeit behaupten. Keine Tokens oder Request-/Response-Inhalte in Betriebslogs.

### Nächster fokussierter Implementierungsschritt

Im öffentlichen Repository zunächst Relay-Contracts und lokale Conformance-Referenz implementieren: explizite Konfiguration, Protokollversionierung, Request-/Response-Korrelation, Cancel/Timeout, Offline/Reconnect, Größenlimits und sichere Route-Bindung. Keine Hosted-Infrastruktur und keine Produktionsfreigabe in diesem Slice. Danach echter MCP-Server, Desktop-Onboarding und gebündelter Windows-Release als gesonderte, getestete Slices.

README und öffentliche Architektur-Dokumentation müssen implementiert, getestet und geplant klar unterscheiden. Ein optionaler Hosted-Service kann dokumentiert werden, aber erst mit einem real existierenden Link als verfügbar beworben werden.