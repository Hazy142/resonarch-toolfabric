# P1B Local Inspect Read Plane

Status: implemented on the P1B branch. This slice extends the real read-only execution plane but does **not** claim `P1_READ_PLANE_PASS` or a complete `inspect` user-tool PASS.

## Scope

P1B adds five R0 / side-effect-none primitives to the P1 runtime:

- `instructions.resolve`
- `code.symbols`
- `code.dependencies`
- `test.discover`
- `context.pack`

Together with P1A, ToolFabric can now execute the local read-only core of repository inspection against a real workspace.

## Instruction resolution

`instructions.resolve` accepts discovered or explicit instruction sources, validates tiers and content digests, rejects duplicate IDs, and applies the canonical precedence order. Retrieved data is preserved in the ordered result but is explicitly marked non-actionable.

A source whose content no longer matches its supplied digest fails closed with `INSTRUCTION_DIGEST_MISMATCH`.

## Symbol analysis

`code.symbols` parses JavaScript/TypeScript-family files through the TypeScript Compiler API. It reports top-level variables, functions, classes, interfaces, type aliases and enums with path, line and export state.

The implementation does not pretend to understand unsupported languages. Source-like files in Python/Rust/Go/Java/C/C++/C#/Ruby/PHP/Swift/Kotlin are returned through `unsupported_files`.

The runtime dependency on `typescript` is explicit in `dependencies`, not hidden in dev-only tooling.

## Dependency inspection

`code.dependencies` currently supports npm `package.json` manifests. It:

- never runs package-manager or lifecycle code;
- caps the manifest at 1 MiB;
- validates dependency and script value types;
- reports dependency section and version spec;
- identifies npm/pnpm/yarn/bun from local lockfiles without following symlinks.

Other ecosystems remain explicit future adapters rather than heuristic claims.

## Test discovery

`test.discover` scans the authorized workspace without following symlinks and excludes dependency/build/cache trees. It returns source test files plus declared `test` / `test:*` package scripts as data only; commands are never executed in P1. Malformed `package.json` content and non-string script values fail closed with `MANIFEST_INVALID` rather than being silently ignored or normalized as generic execution failures.

## Deterministic context packing

`context.pack` validates at most 256 items, rejects duplicate IDs, sorts by descending priority then stable ID, and includes items only while the declared byte budget remains available. Omitted IDs are retained as negative evidence. The digest is calculated over the final deterministic included set.

## Inspect boundary

The canonical `inspect.yaml` also contains `report.render`. That primitive is frozen as R1 with `side_effect=projection` and `report:write`, so P1 does not silently weaken its contract. The P1 executor continues to deny it with `P1_WRITE_FORBIDDEN`.

Therefore P1B proves the local read-only inspect **core**, not the complete user-tool workflow. Report projection requires the later R1/P2 authority path or an explicit contract revision.

## Evidence

Fixture integration tests execute real filesystem and Git operations and verify:

- discovered instructions resolve in canonical order;
- retrieved data never becomes actionable authority;
- instruction digest tampering is denied;
- TypeScript symbols are parsed by an AST, not regex;
- unsupported source languages are explicit;
- npm dependency manifests are read without executing scripts;
- malformed package JSON and non-string script values are rejected as `MANIFEST_INVALID`;
- dependency/build output trees are excluded from test discovery;
- context packing is order-independent and budget bounded;
- the composed local inspect core leaves `git status --porcelain -z` byte-identical before and after.

## Non-claims

Still open before `P1_READ_PLANE_PASS`:

- exact indexed retrieval / FTS;
- research/web/docs read adapters with explicit network-read authority;
- remaining declared R0 read primitives;
- full read-only `research` and `audit` flows;
- resolution of the R1 `report.render` boundary for complete `inspect`;
- final complete-P1 Windows + Linux candidate validation.
