# -*- coding: utf-8 -*-
"""Test suite for claude_session_provider.py (Python)."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(ROOT, "scripts", "providers", "claude_session_provider.py")
SPEC = importlib.util.spec_from_file_location("claude_provider", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

VISIBLE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
NO_HOST_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
DEAD_ID = "cccccccc-3333-4333-8333-cccccccccccc"
BG_ID = "dddddddd-4444-4444-8444-dddddddddddd"
UNREGISTERED_ID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee"

VISIBLE_HOST = "local_aaaa1111-0000-4000-8000-000000000001"
STALE_HOST = "local_bbbb2222-0000-4000-8000-000000000002"


class ClaudeSessionProviderTests(unittest.TestCase):
    """Each test builds its own temp claude home with a registry fixture."""

    def setUp(self):
        self.temp_home = tempfile.mkdtemp(prefix="claude-provider-test-")
        self.registry_dir = os.path.join(self.temp_home, "sessions")
        os.makedirs(self.registry_dir)
        self.project_root = os.path.join(self.temp_home, "project")
        self.other_root = os.path.join(self.temp_home, "other-project")

        # A pid that stays alive for the duration: a keeper child held open.
        self.keeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        # A pid that is guaranteed gone: a child that already exited.
        exited = subprocess.Popen([sys.executable, "-c", ""])
        exited.wait()
        self.dead_pid = exited.pid

    def tearDown(self):
        try:
            self.keeper.kill()
            self.keeper.wait(timeout=10)
        except OSError:
            pass
        shutil.rmtree(self.temp_home, ignore_errors=True)

    def write_entry(self, pid, **fields):
        payload = {"pid": pid}
        payload.update(fields)
        with open(os.path.join(self.registry_dir, "%d.json" % pid), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)

    def write_default_fixture(self):
        self.write_entry(
            os.getpid(),
            sessionId=VISIBLE_ID,
            cwd=self.project_root,
            kind="interactive",
            entrypoint="claude-desktop-3p",
            hostSessionId=VISIBLE_HOST,
            name="visible topic session",
            status="busy",
            updatedAt=1792133480972,
        )
        self.write_entry(
            self.keeper.pid,
            sessionId=NO_HOST_ID,
            cwd=self.project_root,
            kind="interactive",
            entrypoint="claude-desktop-3p",
            name="cli session without host id",
            status="idle",
            updatedAt=1792133000000,
        )
        self.write_entry(
            self.dead_pid,
            sessionId=DEAD_ID,
            cwd=self.project_root,
            kind="interactive",
            entrypoint="claude-desktop-3p",
            hostSessionId=STALE_HOST,
            name="stale registry entry",
            status="idle",
            updatedAt=1792132000000,
        )
        self.write_entry(
            999999,
            sessionId=BG_ID,
            cwd=self.other_root,
            kind="bg",
            entrypoint="claude-desktop-3p",
            name="background job",
            status="idle",
            updatedAt=1792131000000,
        )
        with open(os.path.join(self.registry_dir, "not-a-registry-entry.key"), "w", encoding="utf-8") as handle:
            handle.write("ignored")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, SCRIPT_PATH] + list(args),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_pid_liveness(self):
        self.assertTrue(MODULE.is_pid_alive(os.getpid()))
        self.assertFalse(MODULE.is_pid_alive(self.dead_pid))
        self.assertFalse(MODULE.is_pid_alive(None))
        self.assertFalse(MODULE.is_pid_alive("not-a-pid"))

    def test_host_session_id_detection(self):
        self.assertTrue(MODULE.is_host_session_id(VISIBLE_HOST))
        self.assertFalse(MODULE.is_host_session_id(VISIBLE_ID))

    def test_registry_loader_skips_non_json(self):
        self.write_default_fixture()
        entries = MODULE.load_registry(self.temp_home)
        self.assertEqual(len(entries), 4)
        self.assertEqual(sorted(entry["session_id"] for entry in entries),
                         sorted([VISIBLE_ID, NO_HOST_ID, DEAD_ID, BG_ID]))

    def test_classification_gates(self):
        self.write_default_fixture()
        entries = {entry["session_id"]: entry for entry in MODULE.load_registry(self.temp_home)}
        self.assertEqual(MODULE.classify_entry(entries[VISIBLE_ID]),
                         {"sidebar_visible": True, "reason": "interactive_app_session"})
        self.assertEqual(MODULE.classify_entry(entries[BG_ID]),
                         {"sidebar_visible": False, "reason": "kind_bg"})
        self.assertEqual(MODULE.classify_entry(entries[NO_HOST_ID]),
                         {"sidebar_visible": False, "reason": "no_host_session_id"})
        self.assertEqual(MODULE.classify_entry(entries[DEAD_ID]),
                         {"sidebar_visible": False, "reason": "pid_dead"})
        self.assertEqual(MODULE.classify_entry(None),
                         {"sidebar_visible": False, "reason": "not_registered"})

    def test_list_default_hides_non_visible(self):
        self.write_default_fixture()
        result = MODULE.list_sessions({"claude_home": self.temp_home})
        self.assertTrue(result["sidebar_visible_only"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["sessions"][0]["session_id"], VISIBLE_ID)

    def test_list_all_reports_reason(self):
        self.write_default_fixture()
        result = MODULE.list_sessions({"claude_home": self.temp_home, "all": True})
        self.assertEqual(result["count"], 4)
        reasons = {entry["session_id"]: entry["reason"] for entry in result["sessions"]}
        self.assertEqual(reasons[VISIBLE_ID], "interactive_app_session")
        self.assertEqual(reasons[BG_ID], "kind_bg")
        self.assertEqual(reasons[NO_HOST_ID], "no_host_session_id")
        self.assertEqual(reasons[DEAD_ID], "pid_dead")
        self.assertEqual(result["sessions"][0]["session_id"], VISIBLE_ID)

    def test_list_cwd_filter(self):
        self.write_default_fixture()
        result = MODULE.list_sessions({"claude_home": self.temp_home, "all": True, "cwd": self.project_root})
        self.assertEqual(result["count"], 3)

    def test_verify_accepts_both_namespaces(self):
        self.write_default_fixture()
        by_uuid = MODULE.verify_session(VISIBLE_ID, {"claude_home": self.temp_home})
        self.assertTrue(by_uuid["sidebar_visible"])
        self.assertEqual(by_uuid["reason"], "interactive_app_session")
        self.assertEqual(by_uuid["host_session_id"], VISIBLE_HOST)

        by_host = MODULE.verify_session(VISIBLE_HOST, {"claude_home": self.temp_home})
        self.assertEqual(by_host["query_kind"], "host_session_id")
        self.assertTrue(by_host["sidebar_visible"])
        self.assertEqual(by_host["session_id"], VISIBLE_ID)

    def test_verify_rejects(self):
        self.write_default_fixture()
        options = {"claude_home": self.temp_home}
        self.assertEqual(MODULE.verify_session(BG_ID, options)["reason"], "kind_bg")
        self.assertEqual(MODULE.verify_session(NO_HOST_ID, options)["reason"], "no_host_session_id")
        self.assertEqual(MODULE.verify_session(DEAD_ID, options)["reason"], "pid_dead")

        unknown = MODULE.verify_session(UNREGISTERED_ID, options)
        self.assertFalse(unknown["found"])
        self.assertFalse(unknown["sidebar_visible"])
        self.assertEqual(unknown["reason"], "not_registered")
        self.assertEqual(MODULE.verify_session("local_missing", options)["reason"], "not_registered")

    def test_resolve_host_to_bare_uuid(self):
        self.write_default_fixture()
        options = {"claude_home": self.temp_home}
        hit = MODULE.resolve_host_session(VISIBLE_HOST, options)
        self.assertTrue(hit["resolved"])
        self.assertEqual(hit["session_id"], VISIBLE_ID)
        self.assertTrue(hit["sidebar_visible"])

        stale = MODULE.resolve_host_session(STALE_HOST, options)
        self.assertEqual(stale["session_id"], DEAD_ID)
        self.assertFalse(stale["sidebar_visible"])
        self.assertEqual(stale["reason"], "pid_dead")

        miss = MODULE.resolve_host_session("local_missing", options)
        self.assertFalse(miss["resolved"])
        self.assertIsNone(miss["session_id"])

    def test_verdict_scope_is_declared(self):
        """The verdict measures live registry presence, not sidebar membership."""
        self.write_default_fixture()
        options = {"claude_home": self.temp_home}
        self.assertEqual(MODULE.VERDICT_SCOPE, "live_registry_presence")

        visible_only = MODULE.list_sessions(options)["sessions"]
        self.assertTrue(visible_only)
        self.assertTrue(all(entry["verdict_scope"] == "live_registry_presence" for entry in visible_only))

        everything = MODULE.list_sessions({"claude_home": self.temp_home, "all": True})["sessions"]
        self.assertTrue(all(entry["verdict_scope"] == "live_registry_presence" for entry in everything))

        self.assertEqual(MODULE.verify_session(VISIBLE_ID, options)["verdict_scope"], "live_registry_presence")
        self.assertEqual(MODULE.verify_session(UNREGISTERED_ID, options)["verdict_scope"], "live_registry_presence")
        self.assertEqual(MODULE.resolve_host_session(VISIBLE_HOST, options)["verdict_scope"], "live_registry_presence")
        self.assertEqual(MODULE.resolve_host_session("local_missing", options)["verdict_scope"], "live_registry_presence")

    def test_cli_exit_codes(self):
        self.write_default_fixture()

        hit = self.run_cli("verify", "--session", VISIBLE_ID, "--claude-home", self.temp_home)
        self.assertEqual(hit.returncode, 0, hit.stderr)
        self.assertTrue(json.loads(hit.stdout)["sidebar_visible"])
        self.assertEqual(json.loads(hit.stdout)["verdict_scope"], "live_registry_presence")

        hidden = self.run_cli("verify", "--session", DEAD_ID, "--claude-home", self.temp_home)
        self.assertEqual(hidden.returncode, 1)
        self.assertEqual(json.loads(hidden.stdout)["reason"], "pid_dead")

        resolved = self.run_cli("resolve", "--host", VISIBLE_HOST, "--claude-home", self.temp_home)
        self.assertEqual(resolved.returncode, 0, resolved.stderr)
        self.assertEqual(json.loads(resolved.stdout)["session_id"], VISIBLE_ID)

        miss = self.run_cli("resolve", "--host", "local_missing", "--claude-home", self.temp_home)
        self.assertEqual(miss.returncode, 1)

        everything = self.run_cli("list", "--all", "--claude-home", self.temp_home)
        self.assertEqual(everything.returncode, 0, everything.stderr)
        self.assertEqual(json.loads(everything.stdout)["count"], 4)

        visible_only = self.run_cli("list", "--claude-home", self.temp_home)
        self.assertEqual(json.loads(visible_only.stdout)["count"], 1)

        unknown = self.run_cli("frobnicate")
        self.assertEqual(unknown.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
