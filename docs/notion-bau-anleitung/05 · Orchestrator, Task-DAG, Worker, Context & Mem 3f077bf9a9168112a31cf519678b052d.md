# 05 · Orchestrator, Task-DAG, Worker, Context & Memory

## 1 · Execution Control Plane

ToolFabric besitzt eine **modellunabhängige Capability-/Execution-Control-Plane**. Ein LLM darf lokale Ausführungspläne und nächste Aktionen vorschlagen; Call-State, Leases, Receipts, Budgets und operationale Capability-/Authority-Entscheidungen werden außerhalb des Modells gehalten. **Diese Control Plane ist ausdrücklich nicht die globale Agentic State Authority.** Wird ToolFabric von ARCHY gehostet, bleiben WorkOrder-/Projektzustand, Session-Timeline, Agentic Revision Graph, Branch/Merge/Revert und strategische Worker-Entscheidungen ARCHY-owned.

Minimaler persistenter Execution-State:

- `tasks`
- `task_nodes`
- `dependencies`
- `workers`
- `leases`
- `tool_calls`
- `receipts`
- `artifacts`
- `approvals`
- `instruction_manifests`
- `context_manifests`
- `ledger_entries`
- `claims`
- `benchmarks`
- `host_bindings` für project/work_order/revision/action/trace
- `external_handles` für MCP Tasks, Provider Threads, PIDs, CI Runs usw.

SQLite ist für den lokalen Single-Host-Referenzruntime zulässig; verteilte Execution Planes können PostgreSQL nutzen. Die ToolFabric-Semantik liegt in Contracts, nicht im DB-Produkt; die globale ARCHY-Semantik liegt im Agentic Revision Graph.

## 2 · Task Node Contract

```json
{
  "node_id": "uuid",
  "task_id": "uuid",
  "host_context": {
    "project_id": "uuid-or-null",
    "work_order_id": "uuid-or-null",
    "base_revision_id": "archy-revision-or-null",
    "action_id": "uuid-or-null",
    "trace_id": "uuid-or-null"
  },
  "kind": "implement|test|review|research|gate|release",
  "objective": "bounded natural-language objective",
  "inputs": ["artifact://..."],
  "depends_on": ["uuid"],
  "write_surfaces": ["repo:path-prefix"],
  "required_capabilities": ["fs:write","process:spawn"],
  "required_gates": ["target-tests","scoped-review"],
  "budget": {"tokens":50000,"wall_seconds":3600,"cost_units":100},
  "state": "ready"
}
```

**write_surfaces** sind entscheidend für Parallelität. Zwei Nodes dürfen nur parallel schreiben, wenn ihre Surfaces isoliert sind oder separate Worktrees/Repos existieren.

## 3 · Scheduler-Regeln

1. Topologische DAG-Reihenfolge bleibt bindend.
2. Read-only Nodes können parallel laufen, solange Rate-/Context-Budgets reichen.
3. Write Nodes auf gleichem Worktree sind standardmäßig seriell.
4. Parallele Implementer benötigen getrennte Worktrees oder explizit disjunkte Write-Surfaces.
5. Review folgt auf einen eingefrorenen Diff/Artifact Digest.
6. Ein Gate konsumiert Evidence; es darf die Evidence nicht selbst erzeugen, wenn Unabhängigkeit verlangt wird.
7. Blocked Nodes eskalieren nach Ursache, nicht durch blindes Wiederholen.
8. Worker-Auswahl ist austauschbar; lokale Task Identity bleibt stabil.
9. In ARCHY-Integration wird vor mutierenden Nodes die gebundene `base_revision_id`/expected state gegen den Host-Context geprüft; ToolFabric erzeugt nicht selbständig einen neuen globalen ARCHY-Branch.

## 4 · Leases, Fencing und Crash Recovery

`task.claim` erzeugt:

- `lease_id`
- `lease_generation`
- `fencing_token`
- `worker_id`
- `expires_at`

Jeder mutierende Tool-Call trägt den aktuellen Fencing Token. Nach Lease-Ablauf darf ein alter Worker keinen neuen Side Effect committen.

**Crash zwischen Side Effect und Receipt:** Call wird `uncertain`. Reconciliation prüft externe Zielsysteme anhand Idempotency Key, expected revision, Artifact Digest oder provider-spezifischem Transaction Ref. Kein automatischer Retry, solange der vorherige Effekt nicht geklärt ist.

## 5 · Worker Model

Worker sind austauschbare Ausführungsressourcen:

- local deterministic utility worker
- native coding agent
- hosted LLM tool-use agent
- browser/chat companion
- researcher/search worker
- reviewer
- verifier
- release operator

Ein Worker registriert:

`capabilities`, `provider`, `model`, `context_limit`, `tool_support`, `cost_profile`, `latency_profile`, `trust_profile`, `workspace_access`, `max_risk`.

## 6 · Model Routing

`model.route` optimiert nicht nur „bestes Modell“, sondern Constraint Satisfaction.

**Hard constraints:**

- benötigte Tools
- Context-Größe
- Datenlokalität
- max Risk
- Offline/Cloud Policy
- Bild-/Audio-/Code-Fähigkeit
- Kostenlimit
- Provider Availability

**Soft score:**

`score = capability_fit + reliability + domain_fit + context_fit - cost_penalty - latency_penalty`.

Ein teures Modell wird nicht für mechanische Transkription verwendet, wenn ein günstiger Worker den Contract erfüllt. Review/Architektur/unklare Fehler können bewusst auf stärkere Modelle geroutet werden.

## 7 · Handoff Package

Ein Handoff enthält **keine komplette Chat-History**, sondern:

```
handoff/
  task-brief.md
  instruction-manifest.json
  context-manifest.json
  source-manifest.json
  evidence-manifest.json
  open-findings.json
  review-package.diff
  artifact-refs.json
  next-action.json
```

Task Brief ist Single Source of Requirements. Exakte Zahlen, Magic Strings, Schemas und Acceptance Commands werden dort einmal festgeschrieben und nicht in mehreren Prompts dupliziert.

## 8 · Implementer Report Contract

Status genau:

- `DONE`
- `DONE_WITH_CONCERNS`
- `NEEDS_CONTEXT`
- `BLOCKED`

Report enthält:

- Commits / Diff Ref
- Dateien geändert
- Tests: Command + Exit + Receipt Refs
- neue/änderte Contracts
- offene Concerns
- Scope Deviations
- Evidence refs
- keine bloße Aussage „alles funktioniert“

## 9 · Review Package

Reviewer erhält:

1. Task Brief
2. Implementer Report
3. vollständigen Diff/Artifact
4. globale bindende Constraints
5. relevante Testreceipts
6. explizite Reviewfrage

Reviewer liefert getrennt:

- **Spec compliance:** PASS / FAIL / CANNOT_VERIFY
- **Task quality:** approved / findings
- Findings: `critical | important | minor | question`
- Evidence refs / file+line where possible

Implementer-Selbstreview ersetzt diesen Gate nicht.

## 10 · Fix Loop

- Runden 1–3: ursprünglichen Implementer wieder aufnehmen, Findings unverändert mitgeben.
- Runden 4–5: frischer, stärkerer Worker bei weiterhin offenem Problem.
- Jede Runde: kleiner Fix → covering tests → scoped re-review.
- Nach maximal fünf Runden: Coordinator adjudiziert sichtbar; jede Ruling-Zeile geht ins Ledger.
- Kein stilles Fallenlassen von Findings.
- Minor Findings können deferred werden, bleiben aber im finalen Review-Paket sichtbar.

## 11 · Context Architecture · HOT / WARM / COLD

### HOT

Aktueller User-Auftrag, geschützte Instruktionen, aktiver Plan/DAG, offene Tool Calls, aktuelle Diffs/Findings, unmittelbar benötigte Quellen.

**Nie frei zusammenfassen:** offene Calls, System-/Developer-/Repo-Verträge, aktuelle Approval-/Lease-State.

### WARM

Geschlossene Tasks/Tool Calls als **deterministisch strukturelle Extraktion**:

- call id
- tool id
- status
- args digest
- result digest
- artifact refs
- relevante kurze status-/finding-Felder

Keine freie LLM-Zusammenfassung als alleinige Wahrheit.

### COLD

Unveränderte Raw Tool Results, Logs, Diffs, große Research-Dokumente, alte Messages, Build-Artefakte im content-addressed Store.

## 12 · Retrieval Order

1. explizite ID/Artifact Ref
2. exact key / path / commit / call-id
3. FTS/lexikalisch
4. strukturelle Filter (task, tool, state, date)
5. semantischer Index **optional als sekundärer Kandidatengenerator**
6. exakte Raw-Nachladung vor Claim/Action

Semantic Retrieval darf niemals alleine beweisen, was tatsächlich ausgeführt wurde.

## 13 · Session Identity

System-/Developer-Inhalte werden nicht per Textähnlichkeit als Session-Identität verwendet. Session-Key basiert auf expliziten IDs/Header/Host-Context; Overlap-Heuristiken sind höchstens ein schwacher Fallback und dürfen Chats nicht verschmelzen.

## 14 · History Compaction

`history.compact` darf nur geschlossene Segmente komprimieren:

- alter User/Assistant-Fluss nach Retrieval-Indexierung
- vollständig geschlossene Tool Call + Tool Result Paare
- alte Research-Blöcke mit Artifact Ref

Es darf nicht entfernen:

- offene Tool Calls
- uncommitted approvals
- current task contract
- active instructions
- unresolved findings
- lease/fencing state
- latest revision/diff identity

## 15 · Durable Resume

`resume` macht:

1. Execution Task + checkpoint + Host-Binding laden
2. Receipt chain verifizieren
3. Repo/Workspace aktuelle Revision sowie extern beobachtbare Handles erfassen
4. in ARCHY-Modus gebundene `base_revision_id`/WorkOrder-Head gegen Host prüfen
5. `context.diff` gegen gespeicherten Zustand
6. offene Intents / `uncertain` Calls reconciliieren
7. Execution-DAG ready nodes neu berechnen
8. HOT Context neu packen
9. erst dann Worker fortsetzen

Ein ToolFabric-Resume darf **keinen globalen ARCHY-Revert, Merge oder Branch implizit auslösen**; dafür wird ein Result/Conflict an ARCHY zurückgegeben.

## 16 · Budget Semantik

Budgets sind **keine Wahrheitsauthority**. Sie steuern nur Ressourcen:

- token budget
- tool-call count
- wall time
- max parallel workers
- network requests
- monetary budget
- artifact bytes
- review rounds

Wenn Budget erschöpft ist, endet ein Task `blocked_budget` oder wird explizit eskaliert; ToolFabric erfindet keinen Completion-Claim, nur weil das Budget endet.

## 17 · ARCHY Embedding Contract · 07.10.2026

<aside>
🔗

**Normative Grenze:** ARCHY besitzt den kanonischen Agentic Revision Graph und die globale WorkOrder-/Session-/Timeline-Authority. ToolFabric besitzt ausschließlich die konkrete Capability-/Execution-Semantik innerhalb eines delegierten Scopes.

</aside>

- **Ingress:** ARCHY übergibt mindestens project_id, work_order_id, base_revision_id, action_id/trace_id, erlaubte Capabilities, expected state und Budgets soweit vorhanden.
- **Execution:** ToolFabric darf daraus lokale Task-Nodes, Leases und Provider-/MCP-Aufrufe erzeugen. Diese IDs bleiben untergeordnete Handles.
- **MCP Tasks:** werden als external_handle an ToolFabric-Task und ARCHY-Action gebunden; ihr Status ersetzt weder WorkOrder-State noch Revision-State.
- **MRTR/Elicitation:** ToolFabric reicht input/approval-required mit Call-/Action-Bindung an ARCHY hoch. Die eigentliche Owner-/Authority-Entscheidung wird hostseitig protokolliert; erst danach wird der externe Call fortgesetzt.
- **Result:** ToolFabric liefert kanonisches Result + Receipt + Effects/Artifacts + Reversibility-Klasse zurück. Erst ARCHY entscheidet, ob und wie daraus eine neue Revision, ein Branch-Head, Merge oder Revert entsteht.
- **Resources/Skills/Apps:** ToolFabric kann MCP Resources, Skills und Apps exponieren, aber ARCHY-State wird nur als versionierte Projektion referenziert. Eine MCP-App oder ein Adapter darf keine konkurrierende globale History führen.
- **Providerwechsel:** darf Tool-/Execution-Semantik und Host-Bindings nicht verändern; Provider-/Session-spezifische IDs werden nie als kanonische WorkOrder-/Revision-ID wiederverwendet.