# 02 · Canonical Tool Contract, Risk, Capabilities & Provider Adapter

## 1 · Kanonischer Tool Descriptor

Jedes Backend-Tool wird intern in demselben Contract beschrieben. Provider-Formate sind Projektionen.

```json
{
  "schema": "resonarch.toolfabric.tool/v1",
  "id": "fs.read",
  "version": "1.0.0",
  "title": "Read file",
  "summary": "Reads bytes/text inside an authorized workspace scope.",
  "input_schema": {"type":"object","required":["path"],"properties":{"path":{"type":"string"}}},
  "output_schema": {"type":"object","required":["artifact"],"properties":{"artifact":{"type":"string"}}},
  "capabilities": ["fs:read"],
  "authority_scope": ["workspace"],
  "risk_class": "R0",
  "side_effect": "none",
  "idempotency": "pure",
  "network": "forbidden",
  "receipt": "required",
  "default_timeout_ms": 30000,
  "max_output_bytes": 1048576
}
```

**Pflichtfelder:** stabile ID, semantische Version, I/O-Schema, Capabilities, Authority-Scope, Risk, Side-Effect-Klasse, Idempotenz, Netzwerkpolicy, Receipt-Policy und Limits.

## 2 · Canonical Call Envelope

```json
{
  "schema": "resonarch.toolfabric.call/v1",
  "call_id": "uuid",
  "task_id": "uuid",
  "trace_id": "uuid",
  "host_context": {
    "host": "archy-or-null",
    "project_id": "uuid-or-null",
    "work_order_id": "uuid-or-null",
    "base_revision_id": "archy-revision-or-null",
    "action_id": "uuid-or-null",
    "actor_id": "session/agent/user-or-null"
  },
  "tool": {"id":"fs.patch","version":"1.0.0"},
  "arguments": {},
  "scope": {
    "workspace_id": "uuid",
    "repo": "owner/name",
    "worktree": "absolute-or-logical-ref"
  },
  "expected_state": {
    "source_revision": "sha-or-null",
    "artifact_digest": "sha256-or-null"
  },
  "approval_ref": null,
  "idempotency_key": "stable-key-or-null",
  "deadline": "RFC3339"
}
```

## 3 · Canonical Result Envelope

```json
{
  "schema": "resonarch.toolfabric.result/v1",
  "call_id": "uuid",
  "status": "succeeded",
  "output": {},
  "artifacts": [],
  "diagnostics": [],
  "timing": {"started_at":"...","finished_at":"..."},
  "receipt_ref": "receipt://...",
  "error": null
}
```

Zulässige Status: `succeeded | failed | denied | cancelled | partial | uncertain`.

`uncertain` ist zwingend, wenn nicht beweisbar ist, ob ein externer Side Effect committed wurde.

## 4 · Receipt v1

```json
{
  "schema": "resonarch.toolfabric.receipt/v1",
  "receipt_id": "uuid",
  "trace_id": "uuid",
  "task_id": "uuid",
  "call_id": "uuid",
  "tool_id": "process.start",
  "tool_version": "1.0.0",
  "implementation_digest": "sha256:...",
  "provider_adapter": "mcp@1",
  "request_digest": "sha256:...",
  "result_digest": "sha256:...",
  "source_revision": "git-sha-or-null",
  "workspace_fingerprint": "sha256:...",
  "approval_ref": null,
  "side_effect": "process",
  "status": "succeeded",
  "exit_code": 0,
  "artifact_refs": [],
  "previous_receipt_hash": "sha256:...",
  "receipt_hash": "sha256:..."
}
```

Raw Secrets gehören **nie** in Receipts. Große stdout/stderr-Inhalte werden als verschlüsselte/zugriffsgesteuerte Artefakte gespeichert; das Receipt enthält Bytezahl + Digest + Referenz.

## 5 · Error Taxonomy

| Codefamilie | Bedeutung | Default |
| --- | --- | --- |
| INVALID_* | Schema/Argument/State nicht gültig | fail closed |
| DENIED_* | Policy/Capability/Authority verweigert | kein Retry |
| CONFLICT_* | Revision/Lease/Expected State kollidiert | re-read + replan |
| TRANSIENT_* | temporäres Transport-/Providerproblem | bounded retry |
| EXECUTION_* | Tool lief und scheiterte | Evidence erhalten |
| UNCERTAIN_* | Side Effect nicht eindeutig rekonstruierbar | kein auto retry |
| UNSUPPORTED_* | Adapter kann Semantik nicht liefern | Capability fallback |

## 6 · Risk Classes

- **R0 · Observe:** pure/read-only, keine Secrets, keine Kosten. Automatisch.
- **R1 · Reversible local:** Worktree-/Temp-Datei-/lokale Prozessänderung innerhalb explizitem Scope. Automatisch, wenn Task autorisiert.
- **R2 · External/repo write:** Push, Issue/PR-Write, externe API-Mutation, Paketinstallation, kostenpflichtiger Call. Policy + vorhandene Taskfreigabe.
- **R3 · Irreversible/high-impact:** Merge, Release, produktive Datenmutation, Löschung außerhalb isoliertem Workspace. Explizites Human-/Authority-Gate.
- **R4 · Secret/privileged/critical:** Credential-Offenlegung, Admin-/Root-/Produktionsauthority, Sicherheitsgrenzen. Default deny; nur eng definierte Capability + explizite Freigabe.

## 7 · Capability Model

Capabilities sind atomar und deny-by-default, z. B.:

`fs:read`, `fs:write`, `process:spawn`, `network:web_read`, `network:external_write`, `git:commit`, `git:push`, `forge:pr_write`, `forge:merge`, `secret:reference`, `release:promote`.

Eine Capability enthält:

- Scope/Resource Selector
- erlaubte Operationen
- Gültigkeitszeitraum
- maximale Calls/Bytes/Kosten
- Risk Ceiling
- delegierbar ja/nein
- Approval Source
- Revocation Token

Ein Agent kann Capabilities **benutzen**, nicht selbst erhöhen.

## 8 · Authority Contract

```json
{
  "authority_domain": "repo.release",
  "owner": "human-or-authority-service",
  "may_propose": ["planner","reviewer"],
  "may_execute": ["release-operator"],
  "required_gates": ["tests","review","artifact_digest"],
  "promotion_rule": "unchanged-bytes-only"
}
```

Authority-Domains sind projektdefiniert. ToolFabric liefert Mechanik, nicht fachliche Wahrheit. **Im ARCHY-Hostbetrieb umfasst das ausdrücklich keine globale Project-/WorkOrder-/Revision-/Branch-/Merge-/Revert-Authority; diese wird nur über `host_context` referenziert.**

## 9 · Provider Adapter Interface

Jeder Adapter implementiert logisch:

- `capabilities()`
- `health()`
- `project_tool_descriptor(canonical)`
- `normalize_tool_call(provider_call)`
- `invoke(canonical_call)`
- `stream(call_id)`
- `cancel(call_id)`
- `normalize_result(provider_result)`
- `resume(session_ref)`

**Die kanonische Tool-ID bleibt gleich.** Provider-Namen sind nur Mapping.

### MCP

Canonical Descriptor → MCP tool schema. **Zielbaseline: MCP `2026-07-28`** hinter versioniertem Adapter; Legacy-Kompatibilität separat. MCP server-side validation bleibt verbindlich; Promptbeschreibung allein reicht nicht. `server/discover`/Tool-Discovery wird in die kanonische Registry projiziert, Cache-Hinweise (`ttlMs`, `cacheScope`) dürfen Discovery-Kosten senken, aber niemals Capability-/Approval-State ersetzen. `Mcp-Method`/`Mcp-Name` können frühes Routing/Rate-Limit/Policy-Vorselektion speisen; finale Authorization prüft den vollständigen kanonischen Call. **MCP bleibt Transport/Interoperabilität:** Tools werden auf Canonical Calls normalisiert; langlebige MCP Tasks nur als `external_handle` an lokale Task/Call-IDs und – falls vorhanden – ARCHY `work_order_id/action_id/revision_id` gebunden; MRTR/input-required als gebundene Input-/Approval-Anforderung nach oben gereicht; Resources sind versionierte Projektionen, Skills Ausführungsrezepte und Apps UI-Projektionen. Versionierte resonArch-Extensions dürfen Trace-/Revision-Metadaten transportieren, müssen aber ohne Extension-Support auf normale Call-/Receipt-Bindings zurückfallen. Keine MCP-Primitive und kein Auth-Handshake wird zur globalen State- oder Domain-Authority.

### OpenAI-compatible

Canonical Descriptor → function/tool schema. Responses-/Chat-Completions-Unterschiede liegen im Adapter. Session-/Context-IDs werden nicht in Tool-Semantik eingebaut.

### Anthropic

Canonical Descriptor → `tool_use` / `tool_result`. Systemprompt ist kein Security Boundary; Authority wird außerhalb des Modells geprüft.

### Gemini

Canonical Descriptor → Function Declarations / Function Responses. Provider-eigene Safety-/Systeminstruction bleibt Adapter-/Host-Layer.

### CLI / JSON-RPC / Native

Canonical Call als JSON auf stdio/socket/pipe. Exitcode allein wird in ein Result übersetzt, aber nicht als fachlicher PASS interpretiert.

## 10 · Provider Parity Rule

Ein Adapter gilt nur als `conformant`, wenn:

1. Input-Schema gleich streng ist,
2. Output normalisiert werden kann,
3. denied/failed/uncertain unterscheidbar bleiben,
4. Cancellation und Deadline semantisch dokumentiert sind,
5. Side Effects dieselbe Receipt-Mindestmenge erzeugen,
6. fehlende Fähigkeiten explizit `UNSUPPORTED` melden,
7. kein Provider-Fallback heimlich Risk/Authority erhöht.

## 11 · Versionierung

- Tool-ID bleibt stabil, solange Bedeutung kompatibel bleibt.
- neue optionale Felder: MINOR.
- neue Pflichtfelder oder geänderte Semantik: MAJOR.
- Provider Adapter hat eigene Version.
- Receipt-Schema hat eigene Version.
- User-Tool Workflow verweist auf Tool-Version-Ranges und pinnt für Releases konkrete Lockfiles.

## 12 · Deterministische Serialisierung

Hashes basieren nicht auf Sprach-/Struct-Speicherlayout. Kanonische JSON-Serialisierung:

- UTF-8
- sortierte Objektkeys
- definierte Number-/Decimal-Policy
- keine NaN/Infinity
- normalisierte Pfade/Zeiten nur gemäß Contract
- keine impliziten Defaults im Hash; Defaults werden materialisiert