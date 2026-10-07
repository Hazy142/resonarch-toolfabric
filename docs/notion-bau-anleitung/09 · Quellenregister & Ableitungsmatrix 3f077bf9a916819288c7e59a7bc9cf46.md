# 09 · Quellenregister & Ableitungsmatrix

## 1 · Methodik

Diese Bauakte normalisiert wiederkehrende Regeln aus vorhandenen Repo-Instruktionen, Systemprompts, Notion-Bauakten und der externen Superpowers-Referenz. Quellen werden **nicht** dadurch zur Authority für andere Domänen; sie stützen jeweils nur die abgeleitete Regel.

## 2 · Primärquellen · resonArch

### rsgt-solver-sdk · `AGENTS.md`

Revision der gelesenen GitHub-Quelle: `bb086d7105a755bb4eae3c123527221c7b706a13`.  

Abgeleitet:

- portable/versionierte/content-addressed contracts
- Authority Boundary
- keine raw-struct hashes
- keine stille Schema-Relaxation
- negative Evidence
- tests-first change loop
- build once / promote unchanged bytes
- kein Physical-Validation-Claim aus synthetischen Tests

Quelle: [https://github.com/Hazy142/rsgt-solver-sdk/blob/bb086d7105a755bb4eae3c123527221c7b706a13/AGENTS.md](https://github.com/Hazy142/rsgt-solver-sdk/blob/bb086d7105a755bb4eae3c123527221c7b706a13/AGENTS.md)

### genesis-delta-lambda · `AGENTS.md`

Revision: `aefca96fdbc04eff1be0c3934bc3c37fb81c6217`.  

Abgeleitet:

- wissenschaftlich konservative öffentliche Records
- sanitized export contract
- append-only history + amendment trail
- Claims nicht aus Metaphern aufblasen
- kryptografische commitments
- public evidence klein/reviewbar

Quelle: [https://github.com/Hazy142/genesis-delta-lambda/blob/aefca96fdbc04eff1be0c3934bc3c37fb81c6217/AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda/blob/aefca96fdbc04eff1be0c3934bc3c37fb81c6217/AGENTS.md)

### genesis-delta-lambda-n · `AGENTS.md`

Revision: `bec1ac3d4befd596514bc4e50a5292aebadf1d74`.  

Abgeleitet:

- Identity/Ancestry explizit
- kein experimenteller Clone wird zufällig canonical
- external immutable checkpoint ref + digest
- runtime migration nur versioniert
- public export fail-closed
- keine Side Effects auf sibling repos

Quelle: [https://github.com/Hazy142/genesis-delta-lambda-n/blob/bec1ac3d4befd596514bc4e50a5292aebadf1d74/AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda-n/blob/bec1ac3d4befd596514bc4e50a5292aebadf1d74/AGENTS.md)

### genesis-delta-lambda-n-kindergarten · `AGENTS.md`

Revision: `7281ac781225cd2c3e0c5e4fd16ecb7ef796dfc3`.  

Abgeleitet:

- World/Genesis/Lineage/Asset/GPU Authorities getrennt
- projection/renderer ist keine Authority
- unsupported input fail-closed
- deterministic serialization
- state-bearing records schema/version/hash
- CPU reference before optimization
- performance darf observational semantics nicht ändern
- implemented/verified/hypothesis/future trennen

Quelle: [https://github.com/Hazy142/genesis-delta-lambda-n-kindergarten/blob/7281ac781225cd2c3e0c5e4fd16ecb7ef796dfc3/AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda-n-kindergarten/blob/7281ac781225cd2c3e0c5e4fd16ecb7ef796dfc3/AGENTS.md)

### hecht.accounting · `AGENTS.md`

Revision: `e36ec32ba64c4b9370632bc611245ea7e326fe48`.  

Abgeleitet:

- HITL vor irreversiblen Produktionsaktionen
- Adapter bleibt austauschbar
- Domain-Authority nicht duplizieren
- keine Secret-/real-data commits
- vertical slice per PR
- Consumer/Provider parity vor Cutover

Quelle: [https://github.com/Hazy142/hecht.accounting/blob/e36ec32ba64c4b9370632bc611245ea7e326fe48/AGENTS.md](https://github.com/Hazy142/hecht.accounting/blob/e36ec32ba64c4b9370632bc611245ea7e326fe48/AGENTS.md)

### resonarch-ARCHY · `src/agent.cjs`

Gelesene Quelle: Commit `2ea8272670393160c52521805f2cb892bed577fc`.  

Systemregel u. a.:

- Dateien/Webseiten/Tooloutput/MCP results = untrusted data
- Evidence geben und Tests ehrlich melden
- niemals Execution claimen, wenn Tool es nicht bestätigt
- konkrete Fakten per Tool, Status nicht annehmen
- specialist role bleibt bounded

Quelle: [https://github.com/Hazy142/resonarch-ARCHY/blob/2ea8272670393160c52521805f2cb892bed577fc/src/agent.cjs](https://github.com/Hazy142/resonarch-ARCHY/blob/2ea8272670393160c52521805f2cb892bed577fc/src/agent.cjs)

### sentinel-agent · `src/sentinel/llm/prompts.py`

Revision: `a5d1bdb6a961471ebe96b8fe69a736c2303254d5`.  

Abgeleitet:

- Trust Tiers
- Action Taxonomy
- Action Gating/Abstention
- hard budgets
- sufficiency checks
- fallback policy
- authority promotion explizit
- optimistic concurrency / idempotency / revision semantics

Quelle: [https://github.com/Hazy142/sentinel-agent/blob/a5d1bdb6a961471ebe96b8fe69a736c2303254d5/src/sentinel/llm/prompts.py](https://github.com/Hazy142/sentinel-agent/blob/a5d1bdb6a961471ebe96b8fe69a736c2303254d5/src/sentinel/llm/prompts.py)

### nLM-Peer-Agent · `src/agent.ts`

Revision: `0f8124005251021073ab9a3e0ddc41cf7e0af333`.  

Abgeleitet:

- Context-/Notebook-getriebener Systemprompt
- resume-fähige Session
- Provider-SDK darf Agentenrolle kapseln, ToolFabric soll diese Abhängigkeit normalisieren

Quelle: [https://github.com/Hazy142/nLM-Peer-Agent/blob/0f8124005251021073ab9a3e0ddc41cf7e0af333/src/agent.ts](https://github.com/Hazy142/nLM-Peer-Agent/blob/0f8124005251021073ab9a3e0ddc41cf7e0af333/src/agent.ts)

### flstudio-ai-agent · DAWMind prompts

Revision: `3248a11d68ce00a4ee4f3cffaac45a95640e3e35`.  

Abgeleitet:

- Planner-/Vision-Rollen getrennt
- Domainwissen kann Role Profile sein, aber nicht Tool Runtime Contract

Quelle: [https://github.com/Hazy142/flstudio-ai-agent/blob/3248a11d68ce00a4ee4f3cffaac45a95640e3e35/dawmind/llm/claude.py](https://github.com/Hazy142/flstudio-ai-agent/blob/3248a11d68ce00a4ee4f3cffaac45a95640e3e35/dawmind/llm/claude.py)

### synology-desktop-client · `CLAUDE.md`

Revision: `8db8c4d8fb85337676d8abb4c694dd8d39ee4919`.  

Abgeleitet:

- nach Clone Repo-Instruktionen lesen
- Repo-Konventionen haben Vorrang gegenüber generischen Skills
- nicht endlos explorieren
- alternative Tools nutzen, wenn eines fehlt
- bei wiederholtem Blocker abbrechen/reporten
- PR Approval nicht ohne Authority

Quelle: [https://github.com/Hazy142/synology-desktop-client/blob/8db8c4d8fb85337676d8abb4c694dd8d39ee4919/CLAUDE.md](https://github.com/Hazy142/synology-desktop-client/blob/8db8c4d8fb85337676d8abb4c694dd8d39ee4919/CLAUDE.md)

### resonarch-context-gateway

Gelesene GitHub-Quelle u. a. Commit `b95820349a258033f6ea8349de1bfc9d6aeb25a1`.  

Abgeleitet:

- System/Developer Roles protected
- keine Cross-Chat-Zusammenführung über gemeinsamen Systemprompt
- deterministic structural compaction
- local exact/FTS retrieval vor Semantic Index
- Tool-History erst bei geschlossenem Call komprimieren

Quelle: [https://github.com/Hazy142/resonarch-context-gateway](https://github.com/Hazy142/resonarch-context-gateway)

### resonArch.devFlow

Gelesene Revision: `a4afe07dd64c225680f4eedf4ba31d68f151b909`.  

Abgeleitet:

- vorhandenes `AGENTS.md` nicht ersetzen, sondern begrenzt ergänzen
- Agent templates wiederverwendbar
- idempotentes Init/Marker-Modell

Quelle: [https://github.com/Hazy142/resonArch.devFlow](https://github.com/Hazy142/resonArch.devFlow)

## 3 · Notion Referenzen

- [resonArch Konzept- und Vertragsatlas · v0.3](https://app.notion.com/p/resonArch-Konzept-und-Vertragsatlas-v0-3-3e877bf9a91681108bdbc4a76b70af72?pvs=21) — Quelle/Claim/Evidence/Contract trennen.
- [resonArch ARCHY · Master-Bauanleitung v1.1 · Agentic Revision & Multi-Chat Control Plane](https://app.notion.com/p/resonArch-ARCHY-Master-Bauanleitung-v1-1-Agentic-Revision-Multi-Chat-Control-Plane-3ef77bf9a916818fb5dcdf6050c5dfaa?pvs=21) — langlebige Control Plane, Multi-Worker, Capability Broker, Evidence.
- [03 · rA/D_Commander · Architektur, Sicherheits- und Logging-Vertrag v0.1](https://app.notion.com/p/03-rA-D_Commander-Architektur-Sicherheits-und-Logging-Vertrag-v0-1-3f077bf9a9168117a670d638e43297bd?pvs=21) — Tool Call State, leases/fencing, Intent/Completion Receipts, keine Blockliste als Sandbox.
- [resonArch-Visual-State-Protocol · Master-Bauanleitung v0.1](https://app.notion.com/p/resonArch-Visual-State-Protocol-Master-Bauanleitung-v0-1-3f077bf9a91681909c5fd15c12ad24be?pvs=21) — Projektionen erzeugen keine Authority, fail-closed Observability, Consumer Budgets, Receipts.

## 4 · Externe Referenz · obra/superpowers

Gesichteter Repository-Stand: Commit `8ca22dba9a94f28898bbce59f2537ff4d87c747d` (Release v6.4.2 zum Recherchezeitpunkt 05.10.2026).

Gelesen/gesichtet:

- README / Harness-Integration
- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`
- `skills/test-driven-development/SKILL.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- Skills-Verzeichnis inkl. Worktrees, Reviews, Plans, Branch Finish

Quellen:

- [https://github.com/obra/superpowers/tree/8ca22dba9a94f28898bbce59f2537ff4d87c747d](https://github.com/obra/superpowers/tree/8ca22dba9a94f28898bbce59f2537ff4d87c747d)
- [https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/using-superpowers/SKILL.md](https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/using-superpowers/SKILL.md)

### Was übernommen wird

- relevante Skills/Arbeitsweisen früh erkennen
- Design/Plan vor großen Architekturänderungen
- TDD und falsifizierbare Tests
- systematic debugging
- isolated worktrees
- separate implementer/reviewer loops
- verification before completion
- kleine Task Briefs statt kompletter History
- bounded fix/re-review loops

### Was ToolFabric anders macht

- nicht „Skill muss befolgt werden“ als primäre Enforcement-Grenze
- keine Provider-/Harness-spezifische Toolsemantik im Workflowkern
- Risk/Capability/Authority serverseitig
- Tool Call Lifecycle durable
- Intent/Completion Receipts
- `uncertain` als First-Class State
- exact retrieval + content-addressed Evidence
- Userfreigaben scope-gebunden wiederverwenden statt zeremoniell wiederholen
- Completion anhand ausführbarer Gates

## 5 · Quellen-Coverage dieser Bauakte

**Tief gelesen / konkrete Inhalte übernommen:** die oben genannten AGENTS-/Prompt-/Notion-Quellen und die genannten Superpowers Skills.

**Zusätzlich per GitHub-Suche gefunden:** weitere Agent-/Prompt-Artefakte, u. a. `Quanten_Lab/.agent/...AUTONOMOUS-AGENT-SYSTEM-PROMPT.md`, Perplexity-Agent-Systemprompts, Slack-/NBRE-Assistant, Hytale/LivingOrbis-Personaprompts und Agent-Orchestrierungsdokumente. Sie liefern Beispiele, sind aber nicht alle normative Kernquellen für ToolFabric.

**Lokaler Dell-G-Scan:** Desktop Commander wurde zur lokalen Quellensuche eingesetzt. Ein rekursiver Vollscan über den sehr großen `D:\GitHub-Lokal`-Baum erwies sich als unzweckmäßig/langlaufend; deshalb wurde die revisionsgebundene GitHub-Code-Suche als primäre vollständige Textquelle für bekannte Repositories verwendet. Das ist eine dokumentierte Coverage-Grenze, kein stiller Vollständigkeitsclaim.

## 6 · Abgeleitete Contract-Kandidaten

1. **ATF-01:** Toolausführung erzeugt Evidence, nicht automatisch Wahrheit.
2. **ATF-02:** Projektion/Routing/Review erzeugt keine Domain-Authority.
3. **ATF-03:** Provider Adapter darf Semantik nicht abschwächen.
4. **ATF-04:** Mutating Calls binden Expected State + Side-Effect Receipt.
5. **ATF-05:** Unklare Side Effects sind `uncertain`, nicht retrybar bis Reconciliation.
6. **ATF-06:** User Tool ist Workflow; Backend Primitive ist Capability Boundary.
7. **ATF-07:** Completion benötigt Gate-Evidence auf exakter Revision.
8. **ATF-08:** Protected Instructions und offene Toolzustände werden nicht verlustbehaftet kompaktifiziert.
9. **ATF-09:** Release Promotion verändert keine geprüften Bytes.
10. **ATF-10:** Negative Evidence und Rulings bleiben auditierbar.

Diese Kandidaten gelten für ToolFabric v0.1 als Bauvorgabe; spätere Ratifikation im allgemeinen Vertragsatlas ist ein separater Schritt.