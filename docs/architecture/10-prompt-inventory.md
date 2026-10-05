# 10 — Agent / prompt source inventory

Page 10 records **discovery evidence**, not a new authority layer. ToolFabric keeps the pre-public research snapshot immutable and stores later search reruns separately.

## Frozen baseline

The architecture baseline from 2026-10-05 contains **106 deduplicated GitHub code-search URLs** found with these seven query families:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `SYSTEM_PROMPT`
- `systemPrompt`
- `system_instruction`
- `AGENT_PROMPT`

Classification at that point was:

| Class | Count | Meaning |
| --- | ---: | --- |
| `canonical_instruction_candidate` | 11 | Repository / agent instructions that must be read in context before any normative use. |
| `runtime_prompt_candidate` | 17 | Runtime role or system prompts whose mechanisms may inform adapters and orchestration, but which are not security boundaries. |
| `reference_or_derivative` | 78 | Tests, manifests, transcripts, generated copies, handoffs, and references retained as provenance rather than independent authority. |

The complete 106-item baseline lives in `docs/sources/agent-prompt-discovery-historical.json`.

## Discovery is not authority

A code-search hit proves only that matching material was observed. It does **not** prove that the file is canonical, current, independent, applicable to ToolFabric, or allowed to override repository/system/developer instructions.

Normative influence remains an explicit reviewed choice recorded in `docs/sources/source-registry.json`. Prompt text, retrieved files, web output, tool output, and generated copies never become hidden authorities merely because they are indexed here.

## Directly used instruction patterns

The reviewed derivation set includes, among others:

- `rsgt-solver-sdk/AGENTS.md` — authority boundary, tests-first discipline, negative evidence, unchanged-byte promotion.
- `genesis-delta-lambda*/AGENTS.md` — conservative claims, canonical identity, deterministic serialization, append-only evidence, fail-closed exports.
- `hecht.accounting/AGENTS.md` — HITL and domain-authority separation.
- `synology-desktop-client/CLAUDE.md` — repository instructions before generic workflow rules and bounded autonomy.
- `resonarch.hecht/AGENTS.md` — migration-oracle semantics rather than accidental production authority.

Reviewed runtime-prompt patterns include ARCHY untrusted-output rules, Sentinel trust/action budgets, resumable nLM peer sessions, provider-bound role projections, and dynamic prompt/tool projections. Their useful mechanisms are re-expressed as typed ToolFabric contracts instead of copied into a privileged mega-prompt.

## Live rerun and self-reference

A later live rerun on the same date contains **108** URLs: **12 canonical candidates, 17 runtime candidates, and 79 references/derivatives**.

The exact delta is two newly indexable files from ToolFabric itself:

- `Hazy142/resonarch-toolfabric/AGENTS.md`
- `Hazy142/resonarch-toolfabric/README.md`

Those two self-referential hits are evidence that the new public repository became searchable. They do **not** retroactively rewrite the 106-hit pre-public baseline.

`src/sources/promptInventory.ts` validates this lineage fail-closed: the frozen 106 external URLs and their class counts must remain identical when the 108-item rerun is projected with ToolFabric self-references removed.

## Re-running discovery

Run:

    npm run sources:discover

The command writes `docs/sources/agent-prompt-discovery.generated.json`, which is intentionally ignored by Git. The generator keeps revision-bound GitHub result URLs, captures GitHub text-match excerpts, reuses reviewed classifications for known repository/path pairs, and assigns only a conservative filename-based hint to newly discovered paths.

A generated rerun is **observation**, not promotion. To replace or extend a frozen snapshot, review the new paths, classify them, bind exact revisions, update tests, and create a new evidence artifact rather than overwriting historical data.

## Coverage boundary

The seven query families are deliberately not claimed to discover every possible agent instruction. Rules may use other filenames, be generated dynamically, live in archives/binaries, or exist outside indexed GitHub content.

The supported claim is narrower: the frozen artifact records 106 deduplicated pre-public hits for the stated queries, while the later 108-hit artifact records the same external corpus plus two ToolFabric self-references.
