import importlib.util
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SPEC = importlib.util.spec_from_file_location("provider", os.path.join(ROOT, "scripts", "providers", "codex_session_provider.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Result:
    returncode = 0


class ProviderTests(unittest.TestCase):
    def test_desktop_precedes_sdk(self):
        result = MODULE.submit({"thread": "t", "prompt": "p"}, {"desktop": lambda _: {"submitted": True}, "sdk": lambda _: {"submitted": True}}, cli=False)
        self.assertEqual(result["transport"], "desktop")

    def test_adapter_must_confirm(self):
        result = MODULE.submit({"thread": "t", "message": "p"}, {"api": lambda _: {"submitted": False}}, cli=False)
        self.assertEqual(result["status"], "PREPARED_ONLY")

    def test_cli_fallback(self):
        result = MODULE.submit({"thread": "t", "message": "p"}, {}, run_cli=lambda _: Result())
        self.assertEqual(result["status"], "SUBMITTED")

    def test_missing_thread_is_prepared(self):
        self.assertEqual(MODULE.submit({"message": "p"}, {}, cli=False)["status"], "PREPARED_ONLY")


if __name__ == "__main__":
    unittest.main()
