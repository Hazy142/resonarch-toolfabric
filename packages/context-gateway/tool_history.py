from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


_ERROR_RE = re.compile(
    r"(?i)\b(error|exception|traceback|fatal|failed|failure|panic)\b"
)
_SUCCESS_RE = re.compile(
    r"(?i)\b(pass(?:ed)?|success(?:ful|fully)?|succeeded|\bok\b)\b"
)
_EXIT_RE = re.compile(
    r"(?i)(?:exit(?:\s+code)?|returncode|process\s+exit|status)\s*[=:]?\s*(-?\d+)"
)
_SHA_RE = re.compile(r"(?i)\b[0-9a-f]{7,40}\b")
_WIN_PATH_RE = re.compile(r"""(?i)\b[A-Z]:[\\/][^\s"'<>|]+""")
_UNIX_PATH_RE = re.compile(r"""(?<!\w)/(?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+""")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_./:\\-]{3,}")

_STOPWORDS = {
    "the", "and", "for", "with", "this", "that", "use", "using", "from",
    "into", "then", "than", "you", "your", "please", "now", "just",
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
    "einem", "einer", "und", "oder", "mit", "von", "für", "auf", "aus",
    "jetzt", "bitte", "mach", "machen", "noch", "wieder", "weiter",
}


@dataclass(frozen=True)
class ToolPair:
    call_index: int
    output_index: int
    call_id: str
    tool_name: str
    arguments_text: str
    output_text: str
    call_item: dict[str, Any]
    output_item: dict[str, Any]
    artifact_sha: str
    status: str
    exit_code: int | None
    paths: tuple[str, ...]
    git_shas: tuple[str, ...]
    signals: tuple[str, ...]

    @property
    def searchable_text(self) -> str:
        metadata = " ".join(
            [
                self.tool_name,
                self.call_id,
                self.status,
                *self.paths,
                *self.git_shas,
                *self.signals,
            ]
        )
        return f"{metadata}\n{self.arguments_text}\n{self.output_text}"

    def metadata(self) -> dict[str, Any]:
        return {
            "artifact_sha": self.artifact_sha,
            "artifact_ref": artifact_ref(self.artifact_sha),
            "call_id": self.call_id,
            "tool": self.tool_name,
            "status": self.status,
            "exit_code": self.exit_code,
            "paths": list(self.paths),
            "git_shas": list(self.git_shas),
            "signals": list(self.signals),
            "output_chars": len(self.output_text),
            "arguments_sha256": hashlib.sha256(
                self.arguments_text.encode("utf-8", errors="replace")
            ).hexdigest(),
        }


@dataclass(frozen=True)
class ToolCompaction:
    warm_refs: int
    cold_dropped: int
    retrieved_pairs: int
    open_calls: int
    pairs_seen: int
    latest_error_sha: str | None


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _artifact_payload(
    call_item: dict[str, Any],
    output_item: dict[str, Any],
) -> bytes:
    return json.dumps(
        {"call": call_item, "output": output_item},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _artifact_hash(call_item: dict[str, Any], output_item: dict[str, Any]) -> str:
    return hashlib.sha256(_artifact_payload(call_item, output_item)).hexdigest()


def artifact_ref(sha: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ValueError("INVALID_ARTIFACT_SHA")
    return f"artifact://sha256:{sha}"


def _dedupe_limit(values: list[str], limit: int) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        cleaned = value.strip().rstrip(".,;:)]}")
        if cleaned and cleaned not in result:
            result.append(cleaned)
        if len(result) >= limit:
            break
    return tuple(result)


def _derive_metadata(arguments: str, output: str) -> tuple[
    str, int | None, tuple[str, ...], tuple[str, ...], tuple[str, ...]
]:
    combined = f"{arguments}\n{output}"
    exit_code: int | None = None
    match = _EXIT_RE.search(combined)
    if match:
        try:
            exit_code = int(match.group(1))
        except ValueError:
            exit_code = None

    if (exit_code is not None and exit_code != 0) or _ERROR_RE.search(output):
        status = "error"
    elif exit_code == 0 or _SUCCESS_RE.search(output):
        status = "success"
    else:
        status = "unknown"

    paths = _dedupe_limit(
        _WIN_PATH_RE.findall(combined) + _UNIX_PATH_RE.findall(combined),
        8,
    )
    git_shas = _dedupe_limit(_SHA_RE.findall(combined), 6)

    signal_lines: list[str] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _ERROR_RE.search(line) or _SUCCESS_RE.search(line) or _EXIT_RE.search(line):
            signal_lines.append(line[:240])
        if len(signal_lines) >= 4:
            break

    return status, exit_code, paths, git_shas, tuple(signal_lines)


def extract_tool_pairs(body: dict[str, Any]) -> tuple[list[ToolPair], set[int]]:
    source = body.get("input")
    if not isinstance(source, list):
        return [], set()

    calls: dict[str, tuple[int, dict[str, Any]]] = {}
    paired_call_ids: set[str] = set()
    pairs: list[ToolPair] = []

    for index, item in enumerate(source):
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        call_id = item.get("call_id")
        if item_type == "function_call" and isinstance(call_id, str) and call_id:
            calls.setdefault(call_id, (index, item))
            continue

        if item_type != "function_call_output" or not isinstance(call_id, str):
            continue
        if call_id in paired_call_ids or call_id not in calls:
            continue

        call_index, call_item = calls[call_id]
        if call_index >= index:
            continue

        arguments = _stringify(call_item.get("arguments", ""))
        output = _stringify(item.get("output", ""))
        status, exit_code, paths, git_shas, signals = _derive_metadata(
            arguments, output
        )
        pair = ToolPair(
            call_index=call_index,
            output_index=index,
            call_id=call_id,
            tool_name=str(call_item.get("name") or "unknown"),
            arguments_text=arguments,
            output_text=output,
            call_item=call_item,
            output_item=item,
            artifact_sha=_artifact_hash(call_item, item),
            status=status,
            exit_code=exit_code,
            paths=paths,
            git_shas=git_shas,
            signals=signals,
        )
        pairs.append(pair)
        paired_call_ids.add(call_id)

    pairs.sort(key=lambda pair: pair.call_index)
    open_indexes = {
        index
        for call_id, (index, _item) in calls.items()
        if call_id not in paired_call_ids
    }
    return pairs, open_indexes


def query_tokens(query: str) -> list[str]:
    result: list[str] = []
    for token in _TOKEN_RE.findall(query):
        normalized = token.strip("./:\\-").lower()
        if len(normalized) < 3 or normalized in _STOPWORDS:
            continue
        if normalized not in result:
            result.append(normalized)
        if len(result) >= 20:
            break
    return result


def warm_reference(pair: ToolPair) -> dict[str, Any]:
    payload = pair.metadata()
    payload["tier"] = "warm"
    return {
        "role": "assistant",
        "content": (
            "[resonArch tool-history ref] "
            + json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        ),
    }


def compact_tool_history(
    body: dict[str, Any],
    *,
    known_hashes: set[str],
    retrieved_hashes: set[str],
    hot_pairs: int,
    warm_pairs: int,
) -> ToolCompaction:
    source = body.get("input")
    if not isinstance(source, list):
        return ToolCompaction(0, 0, 0, 0, 0, None)

    pairs, open_indexes = extract_tool_pairs(body)
    if not pairs:
        return ToolCompaction(0, 0, 0, len(open_indexes), 0, None)

    latest_error_sha: str | None = None
    for pair in reversed(pairs):
        if pair.status == "error":
            latest_error_sha = pair.artifact_sha
            break

    hot_start = max(0, len(pairs) - max(0, hot_pairs))
    hot_hashes = {pair.artifact_sha for pair in pairs[hot_start:]}

    warm_end = hot_start
    warm_start = max(0, warm_end - max(0, warm_pairs))
    warm_candidate_hashes = {
        pair.artifact_sha for pair in pairs[warm_start:warm_end]
    }

    replacements: dict[int, dict[str, Any]] = {}
    removals: set[int] = set()
    warm_count = 0
    cold_count = 0
    retrieved_count = 0

    for pair in pairs:
        sha = pair.artifact_sha

        # Never compact a pair before it has been observed in an earlier request.
        if sha not in known_hashes:
            continue

        if sha in hot_hashes or sha == latest_error_sha:
            continue

        if sha in retrieved_hashes:
            retrieved_count += 1
            continue

        if sha in warm_candidate_hashes:
            replacements[pair.call_index] = warm_reference(pair)
            removals.add(pair.output_index)
            warm_count += 1
            continue

        # COLD: full pair remains only in the local content-addressed store.
        removals.add(pair.call_index)
        removals.add(pair.output_index)
        cold_count += 1

    if replacements or removals:
        body["input"] = [
            replacements.get(index, item)
            for index, item in enumerate(source)
            if index not in removals or index in replacements
        ]

    return ToolCompaction(
        warm_refs=warm_count,
        cold_dropped=cold_count,
        retrieved_pairs=retrieved_count,
        open_calls=len(open_indexes),
        pairs_seen=len(pairs),
        latest_error_sha=latest_error_sha,
    )

class ToolHistoryStore:
    def __init__(
        self,
        path: Path,
        *,
        artifact_root: Path | None = None,
    ) -> None:
        self.path = path
        self.artifact_root = artifact_root
        if self.artifact_root is not None:
            self.artifact_root.mkdir(parents=True, exist_ok=True)
        self.fts = True
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS tool_artifacts (
                    artifact_sha TEXT PRIMARY KEY,
                    call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    call_json TEXT NOT NULL,
                    output_json TEXT NOT NULL,
                    arguments_text TEXT NOT NULL,
                    output_text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    search_text TEXT NOT NULL,
                    first_seen REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session_tool_artifacts (
                    session_id TEXT NOT NULL,
                    artifact_sha TEXT NOT NULL,
                    first_seen REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    seen_count INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (session_id, artifact_sha)
                );
                CREATE INDEX IF NOT EXISTS idx_session_tool_last
                    ON session_tool_artifacts(session_id, last_seen DESC);
                CREATE TABLE IF NOT EXISTS tool_request_stats (
                    request_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    seen_at REAL NOT NULL,
                    pairs_seen INTEGER NOT NULL,
                    warm_refs INTEGER NOT NULL,
                    cold_dropped INTEGER NOT NULL,
                    retrieved_pairs INTEGER NOT NULL,
                    open_calls INTEGER NOT NULL,
                    saved_est_tokens INTEGER NOT NULL
                );
                """
            )
            try:
                db.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS tool_artifacts_fts "
                    "USING fts5(artifact_sha UNINDEXED, search_text)"
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

    def _store_artifact(self, pair: ToolPair) -> None:
        if self.artifact_root is None:
            return
        payload = _artifact_payload(pair.call_item, pair.output_item)
        digest = hashlib.sha256(payload).hexdigest()
        if digest != pair.artifact_sha:
            raise RuntimeError("ARTIFACT_DIGEST_MISMATCH")
        target = self.artifact_root / digest
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise RuntimeError("ARTIFACT_DIGEST_MISMATCH")
            return
        temporary = self.artifact_root / f".{digest}.{time.time_ns()}.tmp"
        temporary.write_bytes(payload)
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise RuntimeError("ARTIFACT_DIGEST_MISMATCH")

    def known_hashes(
        self,
        session_id: str,
        hashes: Iterable[str],
    ) -> set[str]:
        values = list(dict.fromkeys(hashes))
        if not values:
            return set()
        marks = ",".join("?" for _ in values)
        with self.connect() as db:
            rows = db.execute(
                f"SELECT artifact_sha FROM session_tool_artifacts "
                f"WHERE session_id=? AND artifact_sha IN ({marks})",
                [session_id, *values],
            ).fetchall()
        return {str(row["artifact_sha"]) for row in rows}

    def remember_pairs(self, session_id: str, pairs: list[ToolPair]) -> None:
        if not pairs:
            return
        now = time.time()
        with self.connect() as db:
            for pair in pairs:
                self._store_artifact(pair)
                metadata_json = json.dumps(
                    pair.metadata(),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                inserted = db.execute(
                    """
                    INSERT OR IGNORE INTO tool_artifacts
                    (artifact_sha, call_id, tool_name, call_json, output_json,
                     arguments_text, output_text, status, metadata_json,
                     search_text, first_seen)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        pair.artifact_sha,
                        pair.call_id,
                        pair.tool_name,
                        json.dumps(
                            pair.call_item,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        json.dumps(
                            pair.output_item,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        pair.arguments_text,
                        pair.output_text,
                        pair.status,
                        metadata_json,
                        pair.searchable_text,
                        now,
                    ),
                ).rowcount
                if inserted and self.fts:
                    db.execute(
                        "INSERT INTO tool_artifacts_fts(artifact_sha, search_text) "
                        "VALUES (?, ?)",
                        (pair.artifact_sha, pair.searchable_text),
                    )
                db.execute(
                    """
                    INSERT INTO session_tool_artifacts
                    (session_id, artifact_sha, first_seen, last_seen, seen_count)
                    VALUES (?, ?, ?, ?, 1)
                    ON CONFLICT(session_id, artifact_sha) DO UPDATE SET
                        last_seen=excluded.last_seen,
                        seen_count=session_tool_artifacts.seen_count+1
                    """,
                    (session_id, pair.artifact_sha, now, now),
                )
            db.commit()

    def retrieve(
        self,
        session_id: str,
        query: str,
        *,
        exclude: set[str],
        limit: int,
    ) -> list[str]:
        if limit <= 0:
            return []
        tokens = query_tokens(query)
        if not tokens:
            return []

        rows: list[sqlite3.Row] = []
        with self.connect() as db:
            if self.fts:
                expression = " OR ".join(
                    '"' + token.replace('"', '""') + '"' for token in tokens
                )
                try:
                    rows = db.execute(
                        """
                        SELECT ta.artifact_sha,
                               bm25(tool_artifacts_fts) AS score,
                               sta.last_seen
                        FROM tool_artifacts_fts
                        JOIN tool_artifacts ta
                          ON ta.artifact_sha=tool_artifacts_fts.artifact_sha
                        JOIN session_tool_artifacts sta
                          ON sta.artifact_sha=ta.artifact_sha
                        WHERE tool_artifacts_fts MATCH ?
                          AND sta.session_id=?
                        ORDER BY score ASC, sta.last_seen DESC
                        LIMIT ?
                        """,
                        (expression, session_id, max(limit * 5, limit)),
                    ).fetchall()
                except sqlite3.OperationalError:
                    rows = []

            if not rows:
                like_terms = tokens[:6]
                clauses = " OR ".join("ta.search_text LIKE ?" for _ in like_terms)
                if clauses:
                    params: list[Any] = [session_id]
                    params.extend(f"%{term}%" for term in like_terms)
                    params.append(max(limit * 5, limit))
                    rows = db.execute(
                        f"""
                        SELECT ta.artifact_sha, 0.0 AS score, sta.last_seen
                        FROM session_tool_artifacts sta
                        JOIN tool_artifacts ta
                          ON ta.artifact_sha=sta.artifact_sha
                        WHERE sta.session_id=?
                          AND ({clauses})
                        ORDER BY sta.last_seen DESC
                        LIMIT ?
                        """,
                        params,
                    ).fetchall()

        result: list[str] = []
        for row in rows:
            sha = str(row["artifact_sha"])
            if sha in exclude or sha in result:
                continue
            result.append(sha)
            if len(result) >= limit:
                break
        return result

    def record_request(
        self,
        *,
        request_id: str,
        session_id: str,
        compaction: ToolCompaction,
        saved_est_tokens: int,
    ) -> None:
        with self.connect() as db:
            db.execute(
                """
                INSERT OR REPLACE INTO tool_request_stats
                (request_id, session_id, seen_at, pairs_seen, warm_refs,
                 cold_dropped, retrieved_pairs, open_calls, saved_est_tokens)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    session_id,
                    time.time(),
                    compaction.pairs_seen,
                    compaction.warm_refs,
                    compaction.cold_dropped,
                    compaction.retrieved_pairs,
                    compaction.open_calls,
                    max(0, saved_est_tokens),
                ),
            )
            db.commit()

    def stats(self) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) AS requests,
                       COALESCE(SUM(pairs_seen),0) AS pairs_seen,
                       COALESCE(SUM(warm_refs),0) AS warm_refs,
                       COALESCE(SUM(cold_dropped),0) AS cold_dropped,
                       COALESCE(SUM(retrieved_pairs),0) AS retrieved_pairs,
                       COALESCE(SUM(open_calls),0) AS open_calls,
                       COALESCE(SUM(saved_est_tokens),0) AS saved_est_tokens
                FROM tool_request_stats
                """
            ).fetchone()
            artifact_count = db.execute(
                "SELECT COUNT(*) AS n FROM tool_artifacts"
            ).fetchone()["n"]
            sessions = db.execute(
                "SELECT COUNT(DISTINCT session_id) AS n "
                "FROM session_tool_artifacts"
            ).fetchone()["n"]
        return {
            "tool_requests": int(row["requests"]),
            "tool_artifacts": int(artifact_count),
            "tool_sessions": int(sessions),
            "tool_pairs_seen": int(row["pairs_seen"]),
            "tool_warm_refs": int(row["warm_refs"]),
            "tool_cold_dropped": int(row["cold_dropped"]),
            "tool_retrieved_pairs": int(row["retrieved_pairs"]),
            "tool_open_calls": int(row["open_calls"]),
            "tool_saved_est_tokens": int(row["saved_est_tokens"]),
        }

