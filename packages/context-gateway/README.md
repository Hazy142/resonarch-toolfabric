# ToolFabric Context Gateway

This package is the in-tree runtime successor of `Hazy142/resonarch-context-gateway`.
The donor repository was imported with permission on 2026-10-06.

It provides an OpenAI-compatible local inference proxy that compacts long message and
tool histories before forwarding requests upstream. The gateway remains a runtime
component; canonical authority stays in ToolFabric contracts and receipts.

## ToolFabric integration

- Closed tool-call/output pairs are content-addressed.
- Canonical references use `artifact://sha256:<64-hex>`, matching
  `src/evidence/artifacts.ts`.
- `RACG_ARTIFACT_ROOT` selects the shared artifact directory.
- Open calls remain HOT and are never compacted.
- Known closed calls may become WARM metadata references or COLD omissions.
- Retrieval can rehydrate exact historical pairs.
- The TypeScript bridge in `src/context/gatewayInterop.ts` projects verified
  ToolFabric receipts into the same compaction model.

## Run

```bash
python -m pip install -r packages/context-gateway/requirements.txt
cd packages/context-gateway
python -m unittest discover tests -v
uvicorn gateway:app --host 127.0.0.1 --port 4043
```

Environment variables retain the original `RACG_*` names for compatibility.
The standalone donor repository can remain as a compatibility mirror until callers
have migrated to this monorepo path.

## Provenance

Imported from donor revisions:
- `gateway.py`: b1416eea43c480da095d540d50e97449958a00ee
- `tool_history.py`: 4c0a0516f6d6e75b914af0d987234a12a996637f
- `tests/test_gateway.py`: 7626fc3815b19236888ebbfb3bc4341370e84356
- `tests/test_tool_history.py`: b715b2673104837d696c801ca3ce37265b379f0d

The donor README is intentionally not copied verbatim; this file documents the
ToolFabric-owned runtime boundary and migration path.
