import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from tool_history import (
    ToolHistoryStore,
    compact_tool_history,
    extract_tool_pairs,
)


def closed_pair(call_id, tool="exec_command", arguments=None, output="ok"):
    arguments = arguments or '{"cmd":"echo ok"}'
    return [
        {
            "type": "function_call",
            "name": tool,
            "call_id": call_id,
            "arguments": arguments,
        },
        {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        },
    ]


def body_with_pairs(count, *, error_at=None):
    items = []
    for i in range(count):
        output = f"tool result {i}"
        if error_at == i:
            output = f"ERROR tool result {i}: alpha regression failure"
        items.extend(
            closed_pair(
                f"call_{i}",
                arguments=f'{{"cmd":"operation-{i}"}}',
                output=output,
            )
        )
    return {"input": items}


class ToolHistoryCompactionTests(unittest.TestCase):
    def test_first_seen_pairs_fail_open(self):
        body = body_with_pairs(5)
        pairs, _ = extract_tool_pairs(body)
        result = compact_tool_history(
            body,
            known_hashes=set(),
            retrieved_hashes=set(),
            hot_pairs=1,
            warm_pairs=2,
        )
        self.assertEqual(result.pairs_seen, 5)
        self.assertEqual(result.warm_refs, 0)
        self.assertEqual(result.cold_dropped, 0)
        self.assertEqual(len(extract_tool_pairs(body)[0]), 5)
        self.assertEqual(len(pairs), 5)

    def test_known_pairs_split_hot_warm_cold(self):
        body = body_with_pairs(5)
        pairs, _ = extract_tool_pairs(body)
        known = {pair.artifact_sha for pair in pairs}
        result = compact_tool_history(
            body,
            known_hashes=known,
            retrieved_hashes=set(),
            hot_pairs=1,
            warm_pairs=2,
        )
        self.assertEqual(result.warm_refs, 2)
        self.assertEqual(result.cold_dropped, 2)
        self.assertEqual(result.retrieved_pairs, 0)

        refs = [
            item for item in body["input"]
            if isinstance(item, dict)
            and item.get("role") == "assistant"
            and str(item.get("content", "")).startswith(
                "[resonArch tool-history ref]"
            )
        ]
        self.assertEqual(len(refs), 2)

        remaining_pairs, _ = extract_tool_pairs(body)
        self.assertEqual(len(remaining_pairs), 1)
        self.assertEqual(remaining_pairs[0].call_id, "call_4")

    def test_open_call_is_always_preserved(self):
        body = body_with_pairs(4)
        body["input"].insert(
            0,
            {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "still_open",
                "arguments": '{"cmd":"long-running"}',
            },
        )
        pairs, open_indexes = extract_tool_pairs(body)
        known = {pair.artifact_sha for pair in pairs}
        self.assertEqual(len(open_indexes), 1)

        result = compact_tool_history(
            body,
            known_hashes=known,
            retrieved_hashes=set(),
            hot_pairs=1,
            warm_pairs=1,
        )
        self.assertEqual(result.open_calls, 1)
        self.assertTrue(
            any(
                item.get("type") == "function_call"
                and item.get("call_id") == "still_open"
                for item in body["input"]
                if isinstance(item, dict)
            )
        )

    def test_latest_error_pair_stays_hot_even_when_old(self):
        body = body_with_pairs(6, error_at=0)
        pairs, _ = extract_tool_pairs(body)
        known = {pair.artifact_sha for pair in pairs}
        error_sha = pairs[0].artifact_sha

        result = compact_tool_history(
            body,
            known_hashes=known,
            retrieved_hashes=set(),
            hot_pairs=1,
            warm_pairs=1,
        )
        self.assertEqual(result.latest_error_sha, error_sha)
        remaining_pairs, _ = extract_tool_pairs(body)
        remaining_ids = {pair.call_id for pair in remaining_pairs}
        self.assertIn("call_0", remaining_ids)
        self.assertIn("call_5", remaining_ids)

    def test_retrieved_cold_pair_is_rehydrated_exactly(self):
        original = body_with_pairs(6)
        body = copy.deepcopy(original)
        pairs, _ = extract_tool_pairs(body)
        known = {pair.artifact_sha for pair in pairs}
        retrieved = {pairs[0].artifact_sha}

        result = compact_tool_history(
            body,
            known_hashes=known,
            retrieved_hashes=retrieved,
            hot_pairs=1,
            warm_pairs=1,
        )
        self.assertEqual(result.retrieved_pairs, 1)

        remaining_pairs, _ = extract_tool_pairs(body)
        by_id = {pair.call_id: pair for pair in remaining_pairs}
        self.assertIn("call_0", by_id)
        self.assertEqual(
            by_id["call_0"].call_item,
            original["input"][0],
        )
        self.assertEqual(
            by_id["call_0"].output_item,
            original["input"][1],
        )

    def test_warm_ref_does_not_copy_large_output(self):
        huge = "opaque-payload-" * 5000
        body = {"input": []}
        for i in range(3):
            output = huge if i == 1 else f"result {i}"
            body["input"].extend(closed_pair(f"call_{i}", output=output))

        pairs, _ = extract_tool_pairs(body)
        known = {pair.artifact_sha for pair in pairs}
        result = compact_tool_history(
            body,
            known_hashes=known,
            retrieved_hashes=set(),
            hot_pairs=1,
            warm_pairs=1,
        )
        self.assertEqual(result.warm_refs, 1)
        packed = repr(body["input"])
        self.assertNotIn(huge, packed)
        self.assertIn(pairs[1].artifact_sha, packed)
        self.assertIn("artifact://sha256:", packed)


class ToolHistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ToolHistoryStore(Path(self.tmp.name) / "state.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_and_exact_retrieval_gate(self):
        body = {
            "input": closed_pair(
                "alpha_call",
                arguments='{"cmd":"repair ALPHA_VECTOR_REPAIR signature"}',
                output=(
                    "ALPHA_VECTOR_REPAIR completed successfully\n"
                    "Process completed with exit code 0"
                ),
            )
        }
        pairs, _ = extract_tool_pairs(body)
        self.store.remember_pairs("session-a", pairs)

        hits = self.store.retrieve(
            "session-a",
            "please revisit ALPHA_VECTOR_REPAIR signature",
            exclude=set(),
            limit=3,
        )
        self.assertEqual(hits, [pairs[0].artifact_sha])

    def test_retrieval_does_not_cross_sessions(self):
        body = {
            "input": closed_pair(
                "private_call",
                output="UNIQUE_SESSION_ONLY_RESULT success",
            )
        }
        pairs, _ = extract_tool_pairs(body)
        self.store.remember_pairs("session-a", pairs)

        hits = self.store.retrieve(
            "session-b",
            "UNIQUE_SESSION_ONLY_RESULT",
            exclude=set(),
            limit=3,
        )
        self.assertEqual(hits, [])


    def test_store_writes_toolfabric_content_addressed_artifact(self):
        body = {"input": closed_pair("artifact_call", output="artifact body")}
        pairs, _ = extract_tool_pairs(body)
        artifact_root = Path(self.tmp.name) / "artifacts"
        store = ToolHistoryStore(
            Path(self.tmp.name) / "artifact-state.db",
            artifact_root=artifact_root,
        )
        store.remember_pairs("session-a", pairs)
        pair = pairs[0]
        target = artifact_root / pair.artifact_sha
        self.assertTrue(target.exists())
        self.assertEqual(
            hashlib.sha256(target.read_bytes()).hexdigest(),
            pair.artifact_sha,
        )



if __name__ == "__main__":
    unittest.main(verbosity=2)
