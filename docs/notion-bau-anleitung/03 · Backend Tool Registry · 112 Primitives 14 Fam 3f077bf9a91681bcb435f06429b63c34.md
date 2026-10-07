# 03 · Backend Tool Registry · 112 Primitives / 14 Familien

## 0 · Registry-Regel

**Exakt 112 Backend-Primitives = 14 Familien × 8 Tools.** Ein Primitive tut möglichst genau eine Sache. Komplexe User-Workflows entstehen durch DAG-Komposition, nicht durch immer größere „God tools“.

Jeder Eintrag besitzt mindestens: Tool-ID, Zweck, Default-Risk, Side-Effect-Klasse und Receipt-Pflicht. Die endgültigen JSON-Schemas liegen später unter `contracts/tools/<family>/<tool>.schema.json`.

## A · Registry & Capability · 8

1. **`registry.list`** — alle verfügbaren Tool-IDs/Versionen/Adapter listen. R0, read.
2. **`registry.describe`** — vollständigen kanonischen Descriptor eines Tools liefern. R0.
3. **`capability.snapshot`** — aktuelle erteilte Capabilities samt Scope/Expiry als unveränderlichen Snapshot liefern. R0.
4. **`capability.resolve`** — prüfen, welche Capability einen geplanten Call deckt; keine Rechteerhöhung. R0.
5. **`provider.list`** — registrierte Modell-/Tool-/Transportprovider und Adapter auflisten. R0.
6. **`provider.health`** — Health/Latency/Feature-Probe ohne Arbeits-Side-Effect. R0.
7. **`model.catalog`** — verfügbare Modelle als Capability/Cost/Context/Tool-use-Metadaten normalisieren. R0.
8. **`model.route`** — anhand deklarierter Anforderungen einen Worker/Model-Kandidaten auswählen und Routing-Receipt erzeugen. R0.

## B · Context & Instruction · 8

1. **`instructions.discover`** — relevante Repo-/Pfad-/Agent-Instruktionen finden und hashen. R0.
2. **`instructions.resolve`** — Precedence/Geltungsbereich auflösen, Konflikte explizit melden. R0.
3. **`policy.compile`** — Task-, Repo-, Capability- und Host-Regeln in ausführbare Policy normalisieren. R0.
4. **`context.capture`** — expliziten Task-/Repo-/Sessionzustand erfassen. R0.
5. **`context.canonicalize`** — Kontextblöcke deduplizieren/normalisieren ohne semantische Freiform-Zusammenfassung. R0.
6. **`context.budget`** — Token/Byte/Latency-Budget auf Layer verteilen. R0.
7. **`context.pack`** — providerneutrales Context Package aus geschützten + abgeleiteten Blöcken bauen. R0.
8. **`context.diff`** — zwei Context Manifests strukturell vergleichen; Drift sichtbar machen. R0.

## C · Filesystem & Workspace · 8

1. **`fs.list`** — Verzeichnis/Folder innerhalb Scope auflisten. R0.
2. **`fs.stat`** — Metadaten, Typ, Größe, Revision/Digest soweit möglich. R0.
3. **`fs.read`** — Datei/Range lesen; Binärdaten als Artifact Ref. R0.
4. **`fs.read_many`** — mehrere bekannte Dateien in einem gebundenen Call lesen. R0.
5. **`fs.write`** — neue Datei oder vollständige kontrollierte Ersetzung mit expected-state. R1.
6. **`fs.patch`** — minimalen Patch mit Preimage/Expected Digest anwenden. R1.
7. **`fs.move`** — atomar verschieben/umbenennen innerhalb Scope. R1.
8. **`fs.search`** — Dateinamen oder Inhalte mit begrenztem Suchbudget durchsuchen. R0.

## D · Process & Environment · 8

1. **`process.start`** — Prozess/Command unter Scope, Env-Policy und Deadline starten. R1/R2.
2. **`process.output`** — stdout/stderr inkrementell lesen, große Ausgabe artifactisieren. R0.
3. **`process.input`** — Input an erlaubte interaktive Session senden. R1.
4. **`process.stop`** — eigene/geleaste Session kontrolliert beenden. R1.
5. **`process.list`** — sichtbare/geleaste Prozesse inventarisieren. R0.
6. **`env.snapshot`** — OS, Runtime, Toolchains, relevante env-Namen ohne Secretwerte fingerprinten. R0.
7. **`command.which`** — ausführbare Tools und Versionen auflösen. R0.
8. **`port.probe`** — lokalen/autorisierten Endpoint auf Erreichbarkeit und Protokollgrunddaten prüfen. R0/R2 bei extern.

## E · Git & Worktree · 8

1. **`git.status`** — Arbeitsbaum/Branch/Upstream/dirty state. R0.
2. **`git.diff`** — revision- oder worktree-gebundenen Diff als Artifact + Stat. R0.
3. **`git.log`** — bounded commit history / refs. R0.
4. **`git.branch`** — Branch anlegen/umschalten nach Policy. R1.
5. **`git.worktree`** — isolierten Worktree create/list/remove mit Provenienz. R1.
6. **`git.commit`** — expliziten staged/declared change set committen; commit SHA receipten. R1.
7. **`git.rebase`** — kontrollierten Rebase mit conflict-state/abort contract. R1/R2.
8. **`git.merge`** — lokalen Branch-Merge ausführen; kein Forge-Merge. R1/R2.

## F · Forge & CI · 8

1. **`forge.repo`** — Repository-Metadaten/Berechtigungen/Default Branch lesen. R0.
2. **`forge.issue`** — Issue suchen/lesen/erstellen/aktualisieren über action-Feld. Read R0, write R2.
3. **`forge.pr`** — PR lesen/erstellen/metadaten ändern; Merge separat. Read R0, write R2.
4. **`forge.review`** — Reviewthreads/Kommentare/Review-Abgabe nach Capability. R0/R2.
5. **`forge.merge`** — serverseitigen PR-Merge mit expected head SHA. R3.
6. **`ci.status`** — Check-/Workflowstatus revisiongebunden lesen. R0.
7. **`ci.logs`** — Job/Step-Logs bounded laden und artifactisieren. R0.
8. **`ci.rerun`** — erlaubten Job/failed run neu starten. R2.

## G · Code Intelligence & Change · 8

1. **`code.symbols`** — Symbolindex/Outline für Scope erzeugen. R0.
2. **`code.search`** — semantisch/lexikalisch nach Funktionen, Typen, Fehlermeldungen suchen. R0.
3. **`code.references`** — Definition/References/Call sites providerneutral auflösen. R0.
4. **`code.dependencies`** — Import-/Package-/Module-Abhängigkeiten als Graph liefern. R0.
5. **`code.ast_query`** — sprachspezifische AST/CST Queries über normalisierte Schnittstelle. R0.
6. **`code.edit`** — strukturierte symbol-/range-basierte Änderung mit Preimage. R1.
7. **`code.format`** — projektdefinierten Formatter auf definierten Scope anwenden. R1.
8. **`code.diagnostics`** — LSP/compiler/static diagnostics normalisieren. R0.

## H · Test, Build & Verification · 8

1. **`test.discover`** — vorhandene Testframeworks, Commands, Target-Mapping aus Repo-Fakten ermitteln. R0.
2. **`test.run`** — definierte Testsuite revisiongebunden ausführen. R1.
3. **`test.target`** — kleinste relevante Testmenge für Diff/Module bestimmen und ausführen. R1.
4. **`test.coverage`** — Coverage-Artefakt generieren/normalisieren; kein Qualitätsclaim allein. R1.
5. **`lint.run`** — deklarierte Linter ausführen. R1.
6. **`typecheck.run`** — deklarierte Type-/Compilechecks ausführen. R1.
7. **`build.run`** — reproduzierbaren Build ausführen, Artifact Digests erfassen. R1/R2.
8. **`gate.evaluate`** — mehrere Evidence-Receipts gegen explizites Gate-Kriterium auswerten. R0; ändert nur Gate-State.

## I · Research & Dependency · 8

1. **`web.search`** — öffentliche Recherche mit Query/Recency/Domain Scope. R0/R2 network.
2. **`web.fetch`** — konkrete Quelle laden, Metadaten + Digest + Retrievalzeit erfassen. R0/R2.
3. **`docs.resolve`** — offizielle Doku für Package/API/Version finden und priorisieren. R0/R2.
4. **`package.resolve`** — Versionen, Lockfile, Registry-Metadaten, Checksums auflösen. R0/R2.
5. **`license.inspect`** — Lizenz/SPDX/Notice/Source-Herkunft analysieren. R0.
6. **`vulnerability.search`** — bekannte Advisories/CVEs für konkrete Versionen recherchieren. R0/R2.
7. **`source.compare`** — mehrere Quellen/Revisionen mit Provenienz und Widersprüchen vergleichen. R0.
8. **`research.bundle`** — zitiertes, dedupliziertes Research Packet für Worker/Reviewer erzeugen. R0.

## J · Task Graph & Orchestration · 8

1. **`task.decompose`** — delegierten Task/WorkOrder-Scope in atomare **Execution-Deliverables** zerlegen. R0. Unter ARCHY entsteht daraus kein neuer globaler WorkOrder- oder Revision-Graph.
2. **`task.graph`** — lokalen Execution-DAG validieren, Topologie/Budgets/Gates festschreiben. R0. Ein ARCHY Revision-DAG bleibt host-owned.
3. **`task.claim`** — Worker-Lease mit Generation/Fencing Token erwerben/erneuern. R1.
4. **`task.dispatch`** — gebundenes Brief/Context Package an Worker senden. R1/R2.
5. **`task.status`** — Worker-/Task-/DAG-Zustand lesen und normalisieren. R0.
6. **`task.handoff`** — Brief, Evidence, offene Findings und exakte Artifact Refs paketieren. R0.
7. **`review.dispatch`** — unabhängigen/scoped Reviewer mit Review Package starten. R1/R2.
8. **`escalation.route`** — Blocker nach Ursache auf Mensch, stärkeres Modell, anderen Provider oder Planrevision routen. R0/R2.

## K · Session, Memory & Retrieval · 8

1. **`session.state`** — ToolFabric-/Provider-seitige Execution-Session-Projektion lesen/schreiben gemäß expected revision. R0/R1. **Im ARCHY-Modus ist dies ausdrücklich nicht die kanonische Conversation-/Timeline-Wahrheit;** ARCHY Session-/Revision-IDs werden nur gebunden.
2. **`ledger.append`** — append-only **Execution**-Task-/Ruling-/Progress-Eintrag erzeugen. R1. ARCHY kann diesen via Receipt/Event-Ref in seinen Agentic Revision Graph übernehmen; der ToolFabric-Ledger ersetzt ihn nicht.
3. **`memory.put`** — explizit freigegebenen langlebigen Knowledge Record speichern. R1.
4. **`memory.get`** — Record per ID/Key exakt laden. R0.
5. **`memory.search_exact`** — FTS/lexikalische/exakte Retrieval-Pfade. R0.
6. **`memory.search_semantic`** — optionalen semantischen Index als sekundären Retrievalpfad abfragen. R0.
7. **`history.compact`** — ausschließlich geschlossene Tool-/History-Segmente strukturell komprimieren; Protected/Open State bleibt vollständig. R1.
8. **`checkpoint.resume`** — Execution Task/Session aus durable checkpoint + receipts wieder aufnehmen und Drift prüfen. R1. Unter ARCHY muss zusätzlich die gebundene WorkOrder-/base_revision-Authority bestätigt werden; kein impliziter globaler Branch/Merge/Revert.

## L · Security, Policy & Approval · 8

1. **`policy.check`** — konkreten Call gegen kompilierte Policy entscheiden. R0.
2. **`capability.request`** — benötigte Capability als Anfrage formulieren; keine Selbstgewährung. R0.
3. **`approval.request`** — Human-/Authority-Gate mit exaktem Scope/Risk/Expiry anfordern. R0.
4. **`secret.scan`** — Text/Diff/Artifact auf Secret-Muster und bekannte Credentialformen prüfen. R0.
5. **`secret.redact`** — Ausgabe deterministisch redigieren und Redaction Receipt erzeugen. R1 auf Projektion, nicht Original.
6. **`network.authorize`** — Ziel/Method/Domain gegen Netzwerkpolicy prüfen und kurzlebige Erlaubnis ausstellen. R0.
7. **`action.classify`** — geplante Aktion in Side-Effect/Risk/Irreversibility/Cost einordnen. R0.
8. **`sandbox.boundary`** — tatsächliche OS-/Container-/Worktree-Isolationsgrenze beschreiben/verifizieren. R0.

## M · Evidence, Provenance & Claims · 8

1. **`hash.compute`** — kanonischen Digest von Bytes/Manifest/Record berechnen. R0.
2. **`manifest.create`** — Source-/Artifact-/Environment-Manifest aus expliziten Inputs erstellen. R0.
3. **`receipt.create`** — Tool-/Intent-/Completion-Receipt erzeugen und ketten. R1.
4. **`receipt.verify`** — Receipt-Kette, Digests und Referenzen prüfen. R0.
5. **`attestation.sign`** — freigegebene Attestation mit konfiguriertem Key-Service signieren. R2/R4.
6. **`attestation.verify`** — Signatur/Identity/Scope/Expiry verifizieren. R0.
7. **`benchmark.record`** — reproduzierbare Run-Matrix, Umgebung, Rohwerte, Summary und Rejects registrieren. R1.
8. **`claim.classify`** — Text/Result in observed/executed/verified/hypothesis/future bzw. supported/not_shown etc. einordnen und Evidence Links erzwingen. R0.

## N · Artifact & Data Interchange · 8

1. **`json.validate`** — JSON Parse + optional canonicalization. R0.
2. **`schema.validate`** — JSON Schema/contract validation mit exakten Fehlerpfaden. R0.
3. **`structured.diff`** — JSON/YAML/manifest/tabellarische Records semantisch vergleichen. R0.
4. **`archive.pack`** — deklarierte Files deterministisch archivieren; Manifest + Digest. R1.
5. **`archive.unpack`** — Archive sicher in isolierten Scope extrahieren; traversal/symlink checks. R1.
6. **`artifact.store`** — Artifact content-addressed ablegen und Ref liefern. R1/R2.
7. **`artifact.fetch`** — Artifact per immutable Ref/Digest laden. R0.
8. **`report.render`** — Evidence/Results in Markdown/HTML/PDF/JSON-Projektion rendern; Projektion erzeugt keine neue Authority. R1.

## 113 gibt es absichtlich nicht

Neue Fähigkeiten werden zuerst darauf geprüft, ob sie **Komposition bestehender Primitives** sind. Ein neues Primitive ist nur zulässig, wenn eine neue atomare Side-Effect-, Authority- oder Observability-Semantik entsteht. Registry-Wachstum benötigt Contract Review.

## Tool-Descriptor-Mindesttests

Für jedes der 112 Tools:

1. gültiger Descriptor gegen Meta-Schema,
2. ungültiger Input fail-closed,
3. Output gegen Schema,
4. Policy deny path,
5. Receipt erzeugt/verifiziert,
6. Timeout/cancel path,
7. Provider-Adapter-Parität soweit unterstützt,
8. Secret-/Large-output-Verhalten,
9. Idempotency/uncertain semantics falls Side Effect,
10. Golden fixture für mindestens einen success und einen failure path.