# 04 · Standard User Tools · 20 Workflow-Compiler

## 0 · Regel

Die 20 Standard-Tools sind die **einzige Oberfläche, die ein normaler Agent zwingend kennen muss**. Sie sind keine monolithischen Backendfunktionen, sondern versionierte Workflow-Spezifikationen, die einen DAG aus Backend-Primitives kompilieren.

Jedes User-Tool besitzt:

- `intent_schema`
- `preflight`
- `required_capabilities`
- `dag_template`
- `gate_set`
- `completion_contract`
- `failure_routes`
- `default_budget`
- `evidence_policy`

## 1 · `inspect`

**Intent:** „Verstehe dieses Repo/System.“  

**Typischer DAG:** `instructions.discover → instructions.resolve → git.status → fs.list/fs.search → code.symbols → code.dependencies → test.discover → context.pack → report.render`.  

**Output:** Source-bound Repo Brief mit Authority-Grenzen, Build/Test Commands, offene Risiken und Revision. Kein Code-Write.

## 2 · `plan`

**Intent:** Aus Ziel + aktuellem Zustand einen prüfbaren Ausführungsplan erzeugen.  

**DAG:** `inspect`-Evidence → `task.decompose → task.graph → action.classify → capability.resolve → gate.evaluate(dry)`.  

**Output:** versionierter Task DAG mit Deliverables, Abhängigkeiten, Gates, Budgets, Claim-Grenzen. Für Architekturänderungen wird er eingefroren; explizite Userfreigabe gilt für den beschriebenen Scope.

## 3 · `implement`

**Intent:** freigegebenen Plan/Feature implementieren.  

**DAG:** `git.worktree → task.claim → task.dispatch/locally execute → code.edit/fs.patch → code.format → test.target → lint/typecheck → git.diff → review.dispatch → gate.evaluate → git.commit`.  

**Regel:** Implementer und Reviewer sind getrennt; Completion nur mit Diff + Tests + Review-Evidence.

## 4 · `fix`

**Intent:** bekannte Finding-/Test-/Review-Abweichung minimal reparieren.  

**DAG:** Finding bind → `source.compare/code.references → code.edit → test.target → structured.diff → scoped review → gate.evaluate`.  

**Regel:** keine opportunistischen Refactors; Fix-Diff bleibt eng.

## 5 · `debug`

**Intent:** unbekannte Fehlerursache systematisch isolieren.  

**DAG:** `env.snapshot → git.status → process/test reproducer → evidence capture → hypothesis ledger → minimal probes → source.compare → fix(optional) → reproduce again`.  

**Regel:** keine Lösung behaupten, bevor der Fehler reproduziert oder die Nicht-Reproduzierbarkeit sauber begrenzt wurde.

## 6 · `test`

**Intent:** passende Tests für aktuellen Scope ausführen.  

**DAG:** `test.discover → test.target/test.run → artifact.store → receipt.create → report.render`.  

**Output:** revisiongebundener Testreport; „PASS“ gilt nur für die ausgeführten Kriterien.

## 7 · `verify`

**Intent:** einen konkreten Claim oder Gate unabhängig prüfen.  

**DAG:** `claim.classify → evidence refs resolve → receipt.verify → rerun selected gates → gate.evaluate`.  

**Output:** `verified | rejected | not_shown | blocked` mit kleinstem Evidence-Set.

## 8 · `review`

**Intent:** Spec-Compliance + Code-/Task-Qualität prüfen.  

**DAG:** `task.handoff → git.diff artifact → instructions.resolve → review.dispatch → findings normalize → claim.classify`.  

**Regel:** Reviewer erhält Brief, Diff, Report, globale Constraints; keine versteckte komplette Session-History.

## 9 · `refactor`

**Intent:** Struktur ändern, Verhalten erhalten.  

**DAG:** Baseline tests/behavior fingerprint → dependency/symbol graph → bounded edits → same behavior gates → diff/review.  

**Regel:** beobachtbare Semantikänderung = kein Refactor, sondern neuer Feature/Migration Scope.

## 10 · `migrate`

**Intent:** API/Schema/Authority/Provider von A nach B überführen.  

**DAG:** current contract freeze → compatibility matrix → dual-path/adapter → parity tests → cutover gate → old-path quarantine/removal.  

**Regel:** kein stilles History-/Identity-Rewrite.

## 11 · `research`

**Intent:** externe/Repo-interne Evidenz sammeln.  

**DAG:** `web.search/docs.resolve/package.resolve → web.fetch → source.compare → research.bundle → claim.classify`.  

**Output:** zitierfähiges Source Bundle, Widersprüche und Wissensgrenzen.

## 12 · `benchmark`

**Intent:** Performance/Qualität vergleichbar messen.  

**DAG:** frozen baseline → env.snapshot → artifact/model/build digests → repeated runs → reject invalid runs → `benchmark.record` → structured comparison.  

**Regel:** keine synthetische Teilmetrik als End-to-End-Gewinn ausgeben; Runmatrix + Rohwerte bleiben erhalten.

## 13 · `audit`

**Intent:** Security, Secrets, Lizenz, Supply Chain oder Authority prüfen.  

**DAG:** `policy.compile → secret.scan → license.inspect → vulnerability.search → dependency graph → sandbox.boundary → receipt.verify → report`.  

**Default:** read-only. Reparaturen sind eigener `fix`-Scope.

## 14 · `release`

**Intent:** unveränderten geprüften Candidate promoten.  

**DAG:** clean status → source/artifact manifest verify → full release gates → independent review → approval.request(R3) → tag/release/promote unchanged bytes → attestation.  

**Regel:** jeder Bytewechsel nach Gate erzeugt neuen Candidate.

## 15 · `ship`

**Intent:** fertigen Branch/PR sauber übergeben oder integrieren.  

**DAG:** latest tests → review → CI status → user/authority policy → [forge.pr/update](http://forge.pr/update) → optional forge.merge via R3 → final receipt.  

**Unterschied zu release:** `ship` beendet Entwicklungsarbeit; `release` promotet ein Release-Artefakt.

## 16 · `triage`

**Intent:** Issues/Failures/Alerts priorisieren und routen.  

**DAG:** collect → classify impact/repro/authority → dedupe → evidence attach → `escalation.route`.  

**Output:** priorisierte Queue mit nächsten kleinsten Beweisschritten, keine vorschnellen Fixclaims.

## 17 · `resume`

**Intent:** langen/abgebrochenen Auftrag korrekt fortsetzen.  

**DAG:** `checkpoint.resume → ledger + receipts verify → git.status/context.diff → open calls reconcile → rebuild HOT context → continue DAG`.  

**Regel:** nicht aus Chat-Zusammenfassung raten, was angeblich erledigt war.

## 18 · `handoff`

**Intent:** Arbeit zwischen Agenten/Sessions/Providern übertragen.  

**DAG:** `task.handoff → artifact refs → instruction manifest → evidence manifest → open findings → exact next action`.  

**Output:** kleines, source-bound Handoff Package statt kopierter Gesamthistorie.

## 19 · `document`

**Intent:** Code-/Architektur-/Evidence-Stand dauerhaft dokumentieren.  

**DAG:** source facts retrieve → claim.classify → links/receipts bind → render → optional repo/notion write.  

**Regel:** Dokumentation trennt belegten Stand, Entwurf, Hypothese, offene Evidenz.

## 20 · `delegate`

**Intent:** Teilaufgaben an geeignete Worker/Modelle verteilen.  

**DAG:** `task.decompose → dependency check → model.catalog/model.route → capability resolve → task.dispatch → status → handoff/review`.  

**Regel:** Parallelität nur bei unabhängigen Write-Surfaces oder isolierten Worktrees; ein Worker darf seine Rechte nicht weiterdelegieren, außer Capability erlaubt es.

## Routing-Matrix

| User-Tool | Read | Write | Network | Reviewer | Human Gate default |
| --- | --- | --- | --- | --- | --- |
| inspect | ja | nein | optional | nein | nein |
| plan | ja | Planartefakt | optional | optional | nur Architektur/Scope |
| implement | ja | ja | optional | ja | nur Risk-Eskalation |
| fix | ja | ja | optional | scoped | nur Risk-Eskalation |
| debug | ja | optional | optional | bei Fix | nur Risk-Eskalation |
| test/verify/review | ja | Evidence | optional | verify/review selbst | nein |
| release | ja | ja | ja | ja | R3 ja |
| ship | ja | ja | ja | ja | Merge abhängig von Policy |
| audit/research/benchmark | ja | Evidence | häufig | optional | keine Mutation |

## User-Tool Compiler

Ein User-Tool wird nicht hart in einen Providerprompt geschrieben, sondern in eine deklarative Datei:

```yaml
id: implement
version: 1.0.0
inputs:
  task_contract: required
preflight:
  - instructions.discover
  - git.status
graph:
  - git.worktree
  - task.claim
  - code.edit
  - test.target
  - review.dispatch
  - gate.evaluate
completion:
  require:
    - clean_or_explained_diff
    - relevant_tests
    - review_verdict
    - receipt_chain_valid
```

Der Workflow Compiler darf Steps abhängig von Repo-Fakten hinzufügen/entfernen, aber **keine Pflichtgates still schwächen**.