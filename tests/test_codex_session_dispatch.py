import importlib.util
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEC = importlib.util.spec_from_file_location("codex_dispatch", os.path.join(ROOT, "scripts", "providers", "codex_session_dispatch.py"))
DISPATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DISPATCH)


class TestCodexSessionDispatch(unittest.TestCase):
    def test_parse_and_build_model_overrides(self):
        options = DISPATCH.parse_args(["--thread", "thread-1", "--message", "hello", "--model", "gpt-5.6-terra", "--reasoning-effort", "xhigh", "--dry-run"])
        self.assertEqual(options["reasoning_effort"], "xhigh")
        command = DISPATCH.build_command(options)
        self.assertEqual(command[-4:], ["--model", "gpt-5.6-terra", "--config", 'model_reasoning_effort="xhigh"'])

    def test_dry_run_is_not_submitted(self):
        result = DISPATCH.dispatch({"thread": "thread-1", "message": "hello", "dry_run": True})
        self.assertEqual(result["status"], "PREPARED_ONLY")
        self.assertFalse(result["submitted"])


if __name__ == "__main__":
    unittest.main()
