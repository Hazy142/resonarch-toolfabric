from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from tool_history import (
    ToolCompaction,
    ToolHistoryStore,
    compact_tool_history,
    extract_tool_pairs,
)

ROOT = Path(__file__).resolve().parent
UPSTREAM = os.getenv("RACG_UPSTREAM", "http://127.0.0.1:4042").rstrip("/")
DB_PATH = Path(os.getenv("RACG_DB", str(ROOT / "state" / "context.db")))
ARTIFACT_ROOT = Path(os.getenv("RACG_ARTIFACT_ROOT", str(ROOT / "state" / "artifacts")))
MODE = os.getenv("RACG_MODE", "compile").lower()
BUDGET_TOKENS = int(os.getenv("RACG_BUDGET_TOKENS", "40000"))
RECENT_MESSAGES = int(os.getenv("RACG_RECENT_MESSAGES", "8"))
RETRIEVAL_CHUNKS = int(os.getenv("RACG_RETRIEVAL_CHUNKS", "12"))
MIN_OVERLAP = int(os.getenv("RACG_MIN_SESSION_OVERLAP", "3"))
REQUEST_TIMEOUT = float(os.getenv("RACG_UPSTREAM_TIMEOUT", "600"))
TOOL_HOT_PAIRS = int(os.getenv("RACG_TOOL_HOT_PAIRS", "4"))
TOOL_WARM_PAIRS = int(os.getenv("RACG_TOOL_WARM_PAIRS", "8"))
TOOL_RETRIEVAL_PAIRS = int(os.getenv("RACG_TOOL_RETRIEVAL_PAIRS", "6"))

TEXT_TYPES = {"input_text", "output_text", "text"}
MESSAGE_ROLES = {"system", "developer", "user", "assistant"}
PROTECTED_ROLES = {"system", "developer"}
SESSION_HEADERS = (
    "x-codex-session-id",
    "x-openai-conversation-id",
    "x-session-id",
    "x-thread-id",
)
SESSION_METADATA_KEYS = (
    "session_id",
    "conversation_id",
    "thread_id",
    "codex_thread_id",
)

app = FastAPI(title="resonArch ToolFabric Context Gateway", version="0.2.0-toolfabric")


@dataclass(frozen=True)
class ChunkRef:
    item_index: int
    block_index: int
    role: str
    kind: str
    text: str
    sha256: str


@dataclass
class CompileResult:
    body: dict[str, Any]
    session_id: str
    request_id: str
    raw_tokens: int
    compiled_tokens: int
    dropped_items: int
    retrieved_hashes: list[str]
    budget_met: bool
    mode: str
    repaired_tool_calls: int


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.fts = True
        with self.connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS chunks (
                    sha256 TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    chars INTEGER NOT NULL,
                    first_seen REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session_chunks (
                    session_id TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    first_seen REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    seen_count INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (session_id, sha256)
                );
                CREATE INDEX IF NOT EXISTS idx_session_chunks_last
                    ON session_chunks(session_id, last_seen DESC);
                CREATE TABLE IF NOT EXISTS response_map (
                    response_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    seen_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS requests (
                    request_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    seen_at REAL NOT NULL,
                    mode TEXT NOT NULL,
                    raw_tokens INTEGER NOT NULL,
                    compiled_tokens INTEGER NOT NULL,
                    dropped_items INTEGER NOT NULL,
                    retrieved_chunks INTEGER NOT NULL,
                    budget_met INTEGER NOT NULL,
                    repaired_tool_calls INTEGER NOT NULL DEFAULT 0
                );
                """
            )
            columns = {
                row["name"] for row in db.execute("PRAGMA table_info(requests)").fetchall()
            }
            if "repaired_tool_calls" not in columns:
                db.execute(
                    "ALTER TABLE requests ADD COLUMN repaired_tool_calls "
                    "INTEGER NOT NULL DEFAULT 0"
                )
            try:
                db.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts "
                    "USING fts5(sha256 UNINDEXED, text)"
                )
            except sqlite3.OperationalError:
                self.fts = False

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def known_hashes(self, session_id: str, hashes: Iterable[str]) -> set[str]:
        values = list(dict.fromkeys(hashes))
        if not values:
            return set()
        marks = ",".join("?" for _ in values)
        with self.connect() as db:
            rows = db.execute(
                f"SELECT sha256 FROM session_chunks "
                f"WHERE session_id=? AND sha256 IN ({marks})",
                [session_id, *values],
            ).fetchall()
        return {str(row["sha256"]) for row in rows}

    def resolve_session(
        self,
        body: dict[str, Any],
        headers: dict[str, str],
        hashes: list[str],
    ) -> str:
        for name in SESSION_HEADERS:
            value = headers.get(name)
            if value:
                return "header:" + value[:160]

        metadata = body.get("metadata")
        if isinstance(metadata, dict):
            for key in SESSION_METADATA_KEYS:
                value = metadata.get(key)
                if isinstance(value, str) and value:
                    return "meta:" + value[:160]

        previous = body.get("previous_response_id")
        if isinstance(previous, str) and previous:
            with self.connect() as db:
                row = db.execute(
                    "SELECT session_id FROM response_map WHERE response_id=?",
                    (previous,),
                ).fetchone()
            if row:
                return str(row["session_id"])

        unique = list(dict.fromkeys(hashes))
        if unique:
            marks = ",".join("?" for _ in unique)
            with self.connect() as db:
                row = db.execute(
                    f"""
                    SELECT session_id, COUNT(*) AS overlap
                    FROM session_chunks
                    WHERE sha256 IN ({marks})
                    GROUP BY session_id
                    ORDER BY overlap DESC, MAX(last_seen) DESC
                    LIMIT 1
                    """,
                    unique,
                ).fetchone()
            if row and int(row["overlap"]) >= MIN_OVERLAP:
                return str(row["session_id"])

        return "local:" + uuid.uuid4().hex

    def remember_chunks(self, session_id: str, chunks: list[ChunkRef]) -> None:
        now = time.time()
        if not chunks:
            return
        with self.connect() as db:
            for c in chunks:
                inserted = db.execute(
                    """
                    INSERT OR IGNORE INTO chunks
                    (sha256, role, kind, text, chars, first_seen)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (c.sha256, c.role, c.kind, c.text, len(c.text), now),
                ).rowcount
                if inserted and self.fts:
                    db.execute(
                        "INSERT INTO chunks_fts(sha256, text) VALUES (?, ?)",
                        (c.sha256, c.text),
                    )
                db.execute(
                    """
                    INSERT INTO session_chunks
                    (session_id, sha256, first_seen, last_seen, seen_count)
                    VALUES (?, ?, ?, ?, 1)
                    ON CONFLICT(session_id, sha256) DO UPDATE SET
                        last_seen=excluded.last_seen,
                        seen_count=session_chunks.seen_count+1
                    """,
                    (session_id, c.sha256, now, now),
                )
            db.commit()

    def map_response(self, response_id: str, session_id: str) -> None:
        if not response_id:
            return
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO response_map(response_id, session_id, seen_at)
                VALUES (?, ?, ?)
                ON CONFLICT(response_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    seen_at=excluded.seen_at
                """,
                (response_id, session_id, time.time()),
            )
            db.commit()

    def retrieve(
        self,
        session_id: str,
        query: str,
        exclude: set[str],
        limit: int,
    ) -> list[str]:
        tokens = [
            t for t in re.findall(r"[A-Za-z0-9_./:-]{3,}", query)
            if t.lower() not in {"the", "and", "for", "with", "this", "that", "use"}
        ][:16]
        rows: list[sqlite3.Row] = []
        with self.connect() as db:
            if self.fts and tokens:
                expression = " OR ".join('"' + t.replace('"', '""') + '"' for t in tokens)
                try:
                    rows = db.execute(
                        """
                        SELECT c.sha256, bm25(chunks_fts) AS score, sc.last_seen
                        FROM chunks_fts
                        JOIN chunks c ON c.sha256=chunks_fts.sha256
                        JOIN session_chunks sc ON sc.sha256=c.sha256
                        WHERE chunks_fts MATCH ?
                          AND sc.session_id=?
                          AND c.role IN ('user','assistant')
                        ORDER BY score ASC, sc.last_seen DESC
                        LIMIT ?
                        """,
                        (expression, session_id, limit * 3),
                    ).fetchall()
                except sqlite3.OperationalError:
                    rows = []

            if not rows:
                rows = db.execute(
                    """
                    SELECT c.sha256, 0.0 AS score, sc.last_seen
                    FROM session_chunks sc
                    JOIN chunks c ON c.sha256=sc.sha256
                    WHERE sc.session_id=?
                      AND c.role IN ('user','assistant')
                    ORDER BY sc.last_seen DESC
                    LIMIT ?
                    """,
                    (session_id, limit * 3),
                ).fetchall()

        result: list[str] = []
        for row in rows:
            sha = str(row["sha256"])
            if sha in exclude or sha in result:
                continue
            result.append(sha)
            if len(result) >= limit:
                break
        return result

    def record(self, result: CompileResult) -> None:
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO requests
                (request_id, session_id, seen_at, mode, raw_tokens,
                 compiled_tokens, dropped_items, retrieved_chunks, budget_met,
                 repaired_tool_calls)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result.request_id,
                    result.session_id,
                    time.time(),
                    result.mode,
                    result.raw_tokens,
                    result.compiled_tokens,
                    result.dropped_items,
                    len(result.retrieved_hashes),
                    1 if result.budget_met else 0,
                    result.repaired_tool_calls,
                ),
            )
            db.commit()

    def stats(self) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) AS requests,
                       COALESCE(SUM(raw_tokens),0) AS raw_tokens,
                       COALESCE(SUM(compiled_tokens),0) AS compiled_tokens,
                       COALESCE(SUM(dropped_items),0) AS dropped_items,
                       COALESCE(SUM(retrieved_chunks),0) AS retrieved_chunks,
                       COALESCE(SUM(repaired_tool_calls),0) AS repaired_tool_calls,
                       COALESCE(SUM(CASE WHEN budget_met=0 THEN 1 ELSE 0 END),0)
                           AS budget_misses
                FROM requests
                """
            ).fetchone()
            sessions = db.execute(
                "SELECT COUNT(DISTINCT session_id) AS n FROM requests"
            ).fetchone()["n"]
            chunks = db.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
        raw = int(row["raw_tokens"])
        compiled = int(row["compiled_tokens"])
        return {
            "requests": int(row["requests"]),
            "sessions": int(sessions),
            "unique_chunks": int(chunks),
            "raw_est_tokens": raw,
            "compiled_est_tokens": compiled,
            "saved_est_tokens": max(0, raw - compiled),
            "saved_pct": round((1 - compiled / raw) * 100, 2) if raw else 0.0,
            "dropped_items": int(row["dropped_items"]),
            "retrieved_chunks": int(row["retrieved_chunks"]),
            "repaired_tool_calls": int(row["repaired_tool_calls"]),
            "budget_misses": int(row["budget_misses"]),
            "mode": MODE,
            "budget_tokens": BUDGET_TOKENS,
            "upstream": UPSTREAM,
        }


store = Store(DB_PATH)
tool_store = ToolHistoryStore(DB_PATH, artifact_root=ARTIFACT_ROOT)
client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT)


def normalize_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def chunk_hash(role: str, kind: str, text: str) -> str:
    payload = f"{role}\0{kind}\0{normalize_text(text)}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def extract_chunks(body: dict[str, Any]) -> list[ChunkRef]:
    source = body.get("input")
    if isinstance(source, str):
        return [
            ChunkRef(
                item_index=0,
                block_index=0,
                role="user",
                kind="input_text",
                text=source,
                sha256=chunk_hash("user", "input_text", source),
            )
        ]
    if not isinstance(source, list):
        return []

    result: list[ChunkRef] = []
    for i, item in enumerate(source):
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in MESSAGE_ROLES:
            continue
        content = item.get("content")
        if isinstance(content, str):
            result.append(
                ChunkRef(
                    i, 0, role, "text", content,
                    chunk_hash(role, "text", content),
                )
            )
        elif isinstance(content, list):
            for j, block in enumerate(content):
                if not isinstance(block, dict):
                    continue
                kind = str(block.get("type") or "text")
                text = block.get("text")
                if kind in TEXT_TYPES and isinstance(text, str):
                    result.append(
                        ChunkRef(
                            i, j, role, kind, text,
                            chunk_hash(role, kind, text),
                        )
                    )
    return result


def estimate_tokens(body: dict[str, Any]) -> int:
    packed = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return max(1, math.ceil(len(packed) / 4))


def latest_user_query(body: dict[str, Any]) -> str:
    chunks = extract_chunks(body)
    parts = [c.text for c in chunks if c.role == "user"]
    return parts[-1] if parts else ""


def repair_malformed_function_arguments(body: dict[str, Any]) -> int:
    """Make malformed historical function-call arguments representable to Bedrock.

    Valid JSON is never modified. Invalid argument strings are preserved verbatim
    inside a valid JSON object so LiteLLM can translate historical tool use.
    """
    source = body.get("input")
    if not isinstance(source, list):
        return 0

    repaired = 0
    for item in source:
        if not isinstance(item, dict) or item.get("type") != "function_call":
            continue
        arguments = item.get("arguments")
        if not isinstance(arguments, str):
            continue
        try:
            json.loads(arguments)
        except json.JSONDecodeError:
            item["arguments"] = json.dumps(
                {"_resonarch_raw_arguments": arguments},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            repaired += 1
    return repaired


def compile_request(
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> CompileResult:
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    request_id = "rcg_" + uuid.uuid4().hex
    chunks = extract_chunks(body)
    hashes = [c.sha256 for c in chunks]
    # Session overlap must never be inferred from shared system/developer prompts.
    # Only conversational history may associate an otherwise anonymous request.
    conversation_hashes = [
        c.sha256 for c in chunks if c.role in {"user", "assistant"}
    ]
    session_id = store.resolve_session(body, headers, conversation_hashes)
    known_before = store.known_hashes(session_id, hashes)

    original_tool_pairs, original_open_calls = extract_tool_pairs(body)
    tool_known_before = tool_store.known_hashes(
        session_id,
        [pair.artifact_sha for pair in original_tool_pairs],
    )

    raw_tokens = estimate_tokens(body)
    compiled = copy.deepcopy(body)
    dropped = 0
    retrieved: list[str] = []
    tool_retrieved: list[str] = []
    tool_compaction = ToolCompaction(
        warm_refs=0,
        cold_dropped=0,
        retrieved_pairs=0,
        open_calls=len(original_open_calls),
        pairs_seen=len(original_tool_pairs),
        latest_error_sha=None,
    )
    tool_saved_est_tokens = 0

    if MODE == "compile" and raw_tokens > BUDGET_TOKENS:
        source = compiled.get("input")
        if isinstance(source, list):
            item_chunks: dict[int, list[ChunkRef]] = {}
            roles: dict[int, str] = {}
            for c in chunks:
                item_chunks.setdefault(c.item_index, []).append(c)
                roles[c.item_index] = c.role

            message_indexes = [
                i for i in sorted(item_chunks)
                if roles.get(i) in {"user", "assistant"}
            ]
            recent = set(message_indexes[-RECENT_MESSAGES:])
            protected_hashes = {
                c.sha256
                for c in chunks
                if c.item_index in recent or c.role in PROTECTED_ROLES
            }
            retrieved = store.retrieve(
                session_id=session_id,
                query=latest_user_query(body),
                exclude=protected_hashes,
                limit=RETRIEVAL_CHUNKS,
            )
            retrieved_set = set(retrieved)

            keep_indexes: set[int] = set()
            for i, item in enumerate(source):
                if not isinstance(item, dict):
                    keep_indexes.add(i)
                    continue
                role = item.get("role")
                if role in PROTECTED_ROLES:
                    keep_indexes.add(i)
                    continue
                if role not in {"user", "assistant"}:
                    # Function calls, tool outputs, images, and unknown protocol
                    # items stay byte/structure-preserved in P0.
                    keep_indexes.add(i)
                    continue
                if i in recent:
                    keep_indexes.add(i)
                    continue

                refs = item_chunks.get(i, [])
                if not refs:
                    keep_indexes.add(i)
                    continue

                all_known = all(c.sha256 in known_before for c in refs)
                relevant = any(c.sha256 in retrieved_set for c in refs)
                if (not all_known) or relevant:
                    keep_indexes.add(i)

            if len(keep_indexes) < len(source):
                compiled["input"] = [
                    item for i, item in enumerate(source) if i in keep_indexes
                ]
                dropped = len(source) - len(compiled["input"])

        tool_retrieved = tool_store.retrieve(
            session_id,
            latest_user_query(body),
            exclude=set(),
            limit=TOOL_RETRIEVAL_PAIRS,
        )
        before_tool_tokens = estimate_tokens(compiled)
        tool_compaction = compact_tool_history(
            compiled,
            known_hashes=tool_known_before,
            retrieved_hashes=set(tool_retrieved),
            hot_pairs=TOOL_HOT_PAIRS,
            warm_pairs=TOOL_WARM_PAIRS,
        )
        after_tool_tokens = estimate_tokens(compiled)
        tool_saved_est_tokens = max(0, before_tool_tokens - after_tool_tokens)

    repaired_tool_calls = (
        repair_malformed_function_arguments(compiled) if MODE == "compile" else 0
    )
    compiled_tokens = estimate_tokens(compiled)
    effective_mode = MODE
    if MODE == "observe":
        compiled = copy.deepcopy(body)
        compiled_tokens = raw_tokens
        dropped = 0
        retrieved = []
        effective_mode = "observe"
        repaired_tool_calls = 0
        tool_retrieved = []
        tool_compaction = ToolCompaction(
            warm_refs=0,
            cold_dropped=0,
            retrieved_pairs=0,
            open_calls=len(original_open_calls),
            pairs_seen=len(original_tool_pairs),
            latest_error_sha=None,
        )
        tool_saved_est_tokens = 0

    result = CompileResult(
        body=compiled,
        session_id=session_id,
        request_id=request_id,
        raw_tokens=raw_tokens,
        compiled_tokens=compiled_tokens,
        dropped_items=dropped,
        retrieved_hashes=retrieved,
        budget_met=compiled_tokens <= BUDGET_TOKENS,
        mode=effective_mode,
        repaired_tool_calls=repaired_tool_calls,
    )

    # Persist only after compilation so "known_before" truly means an earlier turn.
    store.remember_chunks(session_id, chunks)
    tool_store.remember_pairs(session_id, original_tool_pairs)
    store.record(result)
    tool_store.record_request(
        request_id=request_id,
        session_id=session_id,
        compaction=tool_compaction,
        saved_est_tokens=tool_saved_est_tokens,
    )
    return result


def filtered_request_headers(request: Request) -> dict[str, str]:
    blocked = {"host", "content-length", "connection", "transfer-encoding"}
    return {
        k: v for k, v in request.headers.items()
        if k.lower() not in blocked
    }


def filtered_response_headers(headers: httpx.Headers) -> dict[str, str]:
    blocked = {
        "content-length", "content-encoding", "transfer-encoding",
        "connection", "keep-alive",
    }
    return {
        k: v for k, v in headers.items()
        if k.lower() not in blocked
    }


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "version": app.version,
        "mode": MODE,
        "upstream": UPSTREAM,
        "db": str(DB_PATH),
        "artifact_root": str(ARTIFACT_ROOT),
    }


@app.get("/debug/stats")
async def debug_stats() -> dict[str, Any]:
    result = store.stats()
    result.update(tool_store.stats())
    result.update(
        {
            "tool_hot_pairs": TOOL_HOT_PAIRS,
            "tool_warm_pairs": TOOL_WARM_PAIRS,
            "tool_retrieval_pairs": TOOL_RETRIEVAL_PAIRS,
        }
    )
    return result


@app.api_route(
    "/{path:path}",
    methods=["POST", "PUT", "PATCH", "DELETE", "GET", "OPTIONS"],
)
async def proxy(path: str, request: Request) -> Response:
    if request.method == "POST" and request.url.path == "/v1/responses":
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "JSON object required"}, status_code=400)

        result = compile_request(body, dict(request.headers))
        payload = result.body
        is_stream = bool(payload.get("stream"))
        url = UPSTREAM + request.url.path
        headers = filtered_request_headers(request)
        headers["content-type"] = "application/json"
        headers["x-resonarch-context-session"] = result.session_id
        headers["x-resonarch-context-request"] = result.request_id

        if is_stream:
            upstream = await client.send(
                client.build_request(
                    "POST", url, headers=headers, json=payload
                ),
                stream=True,
            )
            response_headers = filtered_response_headers(upstream.headers)
            response_headers["x-resonarch-context-raw-tokens"] = str(result.raw_tokens)
            response_headers["x-resonarch-context-compiled-tokens"] = str(
                result.compiled_tokens
            )

            async def stream_body():
                carry = ""
                mapped = False
                try:
                    async for data in upstream.aiter_bytes():
                        if not mapped:
                            text = carry + data.decode("utf-8", errors="ignore")
                            match = re.search(r'"id"\s*:\s*"(resp_[^"]+)"', text)
                            if match:
                                store.map_response(match.group(1), result.session_id)
                                mapped = True
                            carry = text[-1024:]
                        yield data
                finally:
                    await upstream.aclose()

            return StreamingResponse(
                stream_body(),
                status_code=upstream.status_code,
                headers=response_headers,
                media_type=upstream.headers.get(
                    "content-type", "text/event-stream"
                ),
            )

        upstream = await client.post(url, headers=headers, json=payload)
        response_headers = filtered_response_headers(upstream.headers)
        response_headers["x-resonarch-context-raw-tokens"] = str(result.raw_tokens)
        response_headers["x-resonarch-context-compiled-tokens"] = str(
            result.compiled_tokens
        )
        try:
            data = upstream.json()
        except Exception:
            return Response(
                content=upstream.content,
                status_code=upstream.status_code,
                headers=response_headers,
            )
        if isinstance(data, dict):
            response_id = data.get("id")
            if isinstance(response_id, str):
                store.map_response(response_id, result.session_id)
        return JSONResponse(
            content=data,
            status_code=upstream.status_code,
            headers=response_headers,
        )

    body = await request.body()
    url = UPSTREAM + request.url.path
    upstream = await client.request(
        request.method,
        url,
        headers=filtered_request_headers(request),
        content=body,
        params=request.query_params,
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=filtered_response_headers(upstream.headers),
    )
