import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["RACG_DB"] = str(Path(cls.tmp.name) / "test.db")
        os.environ["RACG_MODE"] = "compile"
        os.environ["RACG_BUDGET_TOKENS"] = "220"
        os.environ["RACG_RECENT_MESSAGES"] = "2"
        os.environ["RACG_RETRIEVAL_CHUNKS"] = "2"
        os.environ["RACG_MIN_SESSION_OVERLAP"] = "2"
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        cls.g = importlib.import_module("gateway")

    @classmethod
    def tearDownClass(cls):
        try:
            import asyncio
            asyncio.run(cls.g.client.aclose())
        except Exception:
            pass
        cls.tmp.cleanup()

    def body(self, final_text="fix alpha regression now"):
        pad = " detail" * 40
        return {
            "model": "qwen3-coder-next-bedrock",
            "tools": [
                {
                    "type": "function",
                    "name": "safe_tool",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "input": [
                {"role": "developer", "content": "Never mutate protected protocol state."},
                {"role": "user", "content": "alpha architecture" + pad},
                {"role": "assistant", "content": "alpha implementation notes" + pad},
                {"role": "user", "content": "beta unrelated history" + pad},
                {"role": "assistant", "content": "beta old response" + pad},
                {
                    "type": "function_call",
                    "name": "safe_tool",
                    "call_id": "call_1",
                    "arguments": "{}",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "TOOL_RESULT_MUST_SURVIVE",
                },
                {"role": "assistant", "content": "recent assistant state"},
                {"role": "user", "content": final_text},
            ],
        }

    def test_first_turn_is_fail_open_for_unseen_history(self):
        body = self.body()
        result = self.g.compile_request(body, {"x-session-id": "unit-a"})
        self.assertEqual(result.dropped_items, 0)
        self.assertEqual(result.body["tools"], body["tools"])
        self.assertFalse(result.budget_met)

    def test_second_turn_dedupes_and_preserves_protocol(self):
        body = self.body()
        self.g.compile_request(body, {"x-session-id": "unit-b"})
        result = self.g.compile_request(
            self.body("fix alpha regression with architecture context"),
            {"x-session-id": "unit-b"},
        )

        self.assertGreater(result.dropped_items, 0)
        self.assertLess(result.compiled_tokens, result.raw_tokens)
        self.assertEqual(result.body["tools"], body["tools"])

        packed = repr(result.body["input"])
        self.assertIn("Never mutate protected protocol state.", packed)
        self.assertIn("TOOL_RESULT_MUST_SURVIVE", packed)
        self.assertIn("call_1", packed)
        self.assertIn("fix alpha regression with architecture context", packed)
        self.assertIn("alpha", packed)

    def test_overlap_resolves_same_session_without_header(self):
        body = self.body("session anchor unique")
        first = self.g.compile_request(body, {"x-session-id": "unit-c"})
        second = self.g.compile_request(body, {})
        self.assertEqual(first.session_id, second.session_id)

    def test_shared_system_prompt_does_not_merge_sessions(self):
        common = "shared developer contract " + ("same " * 100)
        body_a = {
            "input": [
                {"role": "developer", "content": common},
                {"role": "user", "content": "chat A unique request"},
                {"role": "assistant", "content": "chat A unique answer"},
            ]
        }
        body_b = {
            "input": [
                {"role": "developer", "content": common},
                {"role": "user", "content": "chat B unrelated request"},
                {"role": "assistant", "content": "chat B unrelated answer"},
            ]
        }
        first = self.g.compile_request(body_a, {})
        second = self.g.compile_request(body_b, {})
        self.assertNotEqual(first.session_id, second.session_id)
    def test_valid_function_arguments_remain_byte_identical(self):
        valid = '{"shell":"powershell","cmd":"git status"}'
        body = {
            "input": [
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "valid_call",
                    "arguments": valid,
                },
                {
                    "type": "function_call_output",
                    "call_id": "valid_call",
                    "output": "ok",
                },
                {"role": "user", "content": "continue"},
            ]
        }
        result = self.g.compile_request(body, {"x-session-id": "valid-tool"})
        self.assertEqual(result.repaired_tool_calls, 0)
        self.assertEqual(result.body["input"][0]["arguments"], valid)

    def test_malformed_historical_function_arguments_are_wrapped_losslessly(self):
        malformed = '{"shell":"powershell","cmd":"cd "D:/repo"; git status"}'
        body = {
            "input": [
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "broken_call",
                    "arguments": malformed,
                },
                {
                    "type": "function_call_output",
                    "call_id": "broken_call",
                    "output": "historical result",
                },
                {"role": "user", "content": "continue"},
            ]
        }
        result = self.g.compile_request(body, {"x-session-id": "broken-tool"})
        repaired = result.body["input"][0]["arguments"]
        decoded = json.loads(repaired)
        self.assertEqual(result.repaired_tool_calls, 1)
        self.assertEqual(decoded["_resonarch_raw_arguments"], malformed)
        self.assertEqual(result.body["input"][0]["call_id"], "broken_call")
        self.assertEqual(
            result.body["input"][1],
            body["input"][1],
        )

    def test_stats_report_savings(self):
        stats = self.g.store.stats()
        self.assertGreaterEqual(stats["requests"], 5)
        self.assertGreater(stats["raw_est_tokens"], 0)
        self.assertGreaterEqual(stats["saved_est_tokens"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
