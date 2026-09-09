import importlib.util
import os
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEC = importlib.util.spec_from_file_location("codex_dispatch", os.path.join(ROOT, "scripts", "providers", "codex_session_dispatch.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Result:
    def __init__(self, returncode):
        self.returncode = returncode


class CodexSessionDispatchTests(unittest.TestCase):
    def test_queue_submits_only_after_exit_zero(self):
        result = MODULE.dispatch({"thread": "thread-1", "message": "hello"}, lambda command: Result(0))
        self.assertEqual(result["status"], "SUBMITTED")
        self.assertEqual(result["command"][1:], ["queue", "--thread", "thread-1", "--message", "hello"])

    def test_resume_is_explicit(self):
        result = MODULE.dispatch({"thread": "thread-2", "message": "continue", "mode": "resume"}, lambda command: Result(0))
        self.assertEqual(result["command"][1:], ["exec", "resume", "thread-2", "continue"])

    def test_failure_is_prepared_only(self):
        result = MODULE.dispatch({"thread": "thread-3", "message": "nope"}, lambda command: Result(7))
        self.assertEqual(result["status"], "PREPARED_ONLY")
        self.assertFalse(result["submitted"])

    def test_dry_run_never_submits(self):
        result = MODULE.dispatch({"thread": "thread-4", "message": "preview", "dry_run": True})
        self.assertEqual(result["status"], "PREPARED_ONLY")
        self.assertFalse(result["submitted"])


if __name__ == "__main__":
    unittest.main()
