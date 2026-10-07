# 10 · Agent-/Prompt-Quelleninventar · 106 GitHub-Suchtreffer

<aside>
🔎

**Discovery Snapshot · 05.10.2026.** Sieben GitHub-Code-Suchen über `Hazy142` ergaben **106 deduplizierte Treffer-URLs**. Davon wurden anhand von Pfad und Trefferinhalt **11 als kanonische Instruktionskandidaten**, **17 als Runtime-Prompt-Kandidaten** und **78 als Referenz/Derivat** klassifiziert. Diese Klassifikation ist Discovery-Metadatum, keine automatische Normativitätsentscheidung.

</aside>

## 1 · Suchumfang

Verwendete Suchmuster:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `SYSTEM_PROMPT`
- `systemPrompt`
- `system_instruction`
- `AGENT_PROMPT`

**Wichtig:** Ein GitHub-Code-Suchtreffer kann eine echte Instruktionsdatei, einen Runtime-Prompt, einen Test, ein Manifest, ein Gesprächstranskript, einen generierten Paket-Klon oder nur eine Referenz auf `AGENTS.md` sein. ToolFabric trennt deshalb **Discovery** von **Authority**.

## 2 · Klassen

| Klasse | Treffer | Behandlung |
| --- | --- | --- |
| canonical_instruction_candidate | 11 | Repo-/Agent-Regelwerk; vollständig lesen, Scope/Precedence bestimmen, Digest binden. |
| runtime_prompt_candidate | 17 | Rollenspezifischer System-/Agentprompt; Mechanismen extrahieren, aber Prompt nicht zur Sicherheitsboundary erklären. |
| reference_or_derivative | 78 | Tests, Kopien, Manifeste, Transkripte, Handoff-Dateien und Referenzen; als Discovery-/Provenienzbeleg behalten, nicht doppelt als unabhängige Regel zählen. |

## 3 · Kanonische Instruktionsquellen mit direktem Einfluss

Die folgenden Quellen wurden für die Bauakte tatsächlich inhaltlich gelesen und wirken normativ auf ToolFabric:

- [rsgt-solver-sdk · AGENTS.md](https://github.com/Hazy142/rsgt-solver-sdk/blob/bb086d7105a755bb4eae3c123527221c7b706a13/AGENTS.md) — Authority Boundary, tests-first, negative Evidence, immutable promotion.
- [genesis-delta-lambda · AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda/blob/aefca96fdbc04eff1be0c3934bc3c37fb81c6217/AGENTS.md) — conservative claims, sanitized export, append-only amendments.
- [genesis-delta-lambda-n · AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda-n/blob/bec1ac3d4befd596514bc4e50a5292aebadf1d74/AGENTS.md) — canonical identity/ancestry, immutable refs, fail-closed public export.
- [genesis-delta-lambda-n-kindergarten · AGENTS.md](https://github.com/Hazy142/genesis-delta-lambda-n-kindergarten/blob/7281ac781225cd2c3e0c5e4fd16ecb7ef796dfc3/AGENTS.md) — getrennte Authorities, deterministic serialization, CPU reference, fail closed.
- [hecht.accounting · AGENTS.md](https://github.com/Hazy142/hecht.accounting/blob/e36ec32ba64c4b9370632bc611245ea7e326fe48/AGENTS.md) — HITL, swappable adapters, Domain-Authority nicht duplizieren.
- [synology-desktop-client · CLAUDE.md](https://github.com/Hazy142/synology-desktop-client/blob/8db8c4d8fb85337676d8abb4c694dd8d39ee4919/CLAUDE.md) — Repo-Instruktionen zuerst, bounded autonomy, alternative Tools statt Stall, Authority für PR-Aktionen.
- [resonarch.hecht · AGENTS.md](https://github.com/Hazy142/resonarch.hecht/blob/3e4a367376fbf20548a0cad17d3b5d21a4aaddb9/AGENTS.md) — Legacy/Migration Oracle statt neuer Produktionsauthority.

Zusätzlich gefundene kanonische oder handoff-nahe Regeln in `rsgt-engine`, `rsgt-genesis`, `rsgt-world-model`, FiberField-Transportpaketen und weiteren Repos werden über das Rohregister nachvollziehbar gehalten.

## 4 · Runtime-Prompt-Quellen mit direktem Einfluss

- [resonarch-ARCHY · src/agent.cjs](https://github.com/Hazy142/resonarch-ARCHY/blob/2ea8272670393160c52521805f2cb892bed577fc/src/agent.cjs) — Tool-/Web-/Dateioutput ist untrusted data; Execution nur claimen, wenn Tool bestätigt; konkrete Fakten per Tools.
- [sentinel-agent · prompts.py](https://github.com/Hazy142/sentinel-agent/blob/a5d1bdb6a961471ebe96b8fe69a736c2303254d5/src/sentinel/llm/prompts.py) — Trust Tiers, Action Taxonomy, hard budgets, sufficiency, abstention, concurrency/idempotency.
- [nLM-Peer-Agent · src/agent.ts](https://github.com/Hazy142/nLM-Peer-Agent/blob/0f8124005251021073ab9a3e0ddc41cf7e0af333/src/agent.ts) — Context-gebundener Systemprompt und resumable sessions.
- [flstudio-ai-agent · claude.py](https://github.com/Hazy142/flstudio-ai-agent/blob/3248a11d68ce00a4ee4f3cffaac45a95640e3e35/dawmind/llm/claude.py) — getrennte Planner-/Tool-Rolle; Domainprompt als austauschbares Role Profile.
- [Quanten_Lab · AUTONOMOUS-AGENT-SYSTEM-PROMPT.md](https://github.com/Hazy142/Quanten_Lab/blob/ef1da8873dc40a827f5e5d4e8f85382fc539ecf3/.agent/jules-orchestrierung/AUTONOMOUS-AGENT-SYSTEM-PROMPT.md) — älteres Orchestrator-/Monitoring-Muster; als historische Referenz, nicht als heutige Sicherheitsauthority.
- [VSCode Perplexity Agent · PerplexityClient.ts](https://github.com/Hazy142/VSCode_Extension-integrated-Perplexity-Agent/blob/83c490b64a0911d3843be14d2989b876363dc300/src/services/PerplexityClient.ts) — dynamische Tool-Prompt-Projektion; zeigt, warum Tool-Contract und Prompt-Projektion getrennt sein müssen.
- [nether-bridge · Slack Assistant](https://github.com/Hazy142/nether-bridge/blob/eb266ce1cdeda73a4579c50519a163fe6da5c1b3/apps/slack-assistant/src/llm.ts) — providergebundene Rollenprojektion, nicht Core-Semantik.

## 5 · Derivative Quellen sind trotzdem wertvoll

Die 78 derivativen Treffer zeigen wiederkehrende Mechanismen:

- `AGENT.md` verweist bewusst auf ein kanonisches `AGENTS.md`, damit zwei Regelwerke nicht divergieren.
- Handoff-Pakete kombinieren Instruktionen, Projektzustand, Manifeste und SHA256SUMS.
- Tests referenzieren Agent-Regeln und beweisen dadurch, welche Regeln tatsächlich in Gate-/Releasepfade eingebunden sind.
- Gesprächs-/Designartefakte unterscheiden bereits **Skills/AGENTS = Arbeitsweise**, **MCP = Tools/Daten**, **A2A = Delegation** und **AG-UI = Frontendkommunikation**.
- DevFlow ergänzt vorhandene AGENTS-Regeln idempotent statt sie zu ersetzen.

Diese Muster fließen in `instructions.discover`, `instructions.resolve`, Handoff Packages, Registry/Adapter-Trennung und die P0–P8-Gates ein.

## 6 · Raw Discovery Artifact

Das vollständige, deduplizierte Trefferregister enthält URL, Repository, Pfad, Discovery Query, Excerpt und Klassifikation für alle 106 Ergebnisse:

[toolfabric-agent-prompt-discovery-2026-10-05.json](toolfabric-agent-prompt-discovery-2026-10-05.json)

toolfabric-agent-prompt-discovery-2026-10-05.json

## 7 · Coverage-Grenze

**Nicht behaupten:** Dass diese sieben Suchstrings semantisch jede denkbare Agentenregel in allen Repositories erfassen. Dateien können andere Namen verwenden, in Binär-/Archivformaten liegen oder nur dynamisch erzeugt werden.

**Belegt:** 106 deduplizierte GitHub-Code-Suchtreffer für die angegebenen Queryfamilien wurden am 05.10.2026 inventarisiert; die für ToolFabric zentralen kanonischen Instruktionen und Runtime-Prompts wurden separat vollständig bzw. gezielt gelesen. Der lokale Dell-G-Baum wurde ergänzend untersucht, aber ein rekursiver Vollscan über den sehr großen Arbeitsbaum wurde wegen Laufzeit/Toolinggrenze nicht fälschlich als vollständig ausgegeben.