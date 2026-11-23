import unittest
import os
import shutil
import tempfile
import json
import sys
import subprocess
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from scripts.new_topic_session import (
    parse_memory_doc,
    create_topic_memory_doc,
    provision_single_doc,
    provision_all_missing,
    spawn_root_conversation,
)
from scripts import new_topic_session as session_module


class TestNewTopicSessionSkill(unittest.TestCase):

    def setUp(self):
        self.tmp_ws = tempfile.mkdtemp(prefix="task_loop_new_session_py_test_")
        self.tmp_memory_dir = os.path.join(self.tmp_ws, "docs", "memory")
        os.makedirs(self.tmp_memory_dir, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp_ws, ignore_errors=True)

    def test_parse_memory_doc(self):
        sample_doc = os.path.join(self.tmp_memory_dir, "sample_topic.md")
        with open(sample_doc, "w", encoding="utf-8") as f:
            f.write("""# [专题受控记忆] 样本功能专题 (sample_topic)
* 物理白名单: src/sample/**/*, tests/test_sample/**/*
""")
        meta = parse_memory_doc(sample_doc, self.tmp_ws)
        self.assertEqual(meta["module_key"], "sample_topic")
        self.assertEqual(meta["title"], "[sample_topic专题] 核心功能维护 & 记忆沉淀")
        self.assertIn("src/sample/**/*", meta["allowlist"])

    def test_create_topic_memory_doc(self):
        created = create_topic_memory_doc("brand_new", "Brand New Topic", {"ws_root": self.tmp_ws})
        self.assertTrue(os.path.exists(created["doc_path"]))
        with open(created["doc_path"], "r", encoding="utf-8") as f:
            content = f.read()
            self.assertIn("# [专题受控记忆] Brand New Topic (brand_new)", content)

    def test_provision_single_doc_dry_run(self):
        sample_doc = os.path.join(self.tmp_memory_dir, "sample_topic.md")
        with open(sample_doc, "w", encoding="utf-8") as f:
            f.write("# Sample")
        res = provision_single_doc(sample_doc, self.tmp_ws, {"dry_run": True})
        self.assertEqual(res["status"], "DRY_RUN")
        self.assertEqual(res["module_key"], "sample_topic")

    def test_provision_all_missing_dry_run(self):
        doc1 = os.path.join(self.tmp_memory_dir, "doc1.md")
        doc2 = os.path.join(self.tmp_memory_dir, "doc2.md")
        with open(doc1, "w", encoding="utf-8") as f:
            f.write("# Doc 1")
        with open(doc2, "w", encoding="utf-8") as f:
            f.write("# Doc 2")
        res = provision_all_missing(self.tmp_ws, {"dry_run": True})
        self.assertEqual(res["count"], 2)

    def test_survey_memory_docs_status(self):
        from scripts.new_topic_session import survey_memory_docs_status
        doc1 = os.path.join(self.tmp_memory_dir, "doc1.md")
        with open(doc1, "w", encoding="utf-8") as f:
            f.write("# Doc 1")
        survey = survey_memory_docs_status(self.tmp_ws)
        self.assertEqual(len(survey["all_docs"]), 1)
        self.assertEqual(len(survey["missing"]), 1)
        self.assertEqual(len(survey["aligned"]), 0)

    def test_codex_spawn_emits_template_only(self):
        previous = os.environ.get("CODEX_THREAD_ID")
        os.environ["CODEX_THREAD_ID"] = "codex-test-thread"
        try:
            res = spawn_root_conversation("[测试专题] x", "初始化", self.tmp_ws)
            self.assertEqual(res.get("status"), "PENDING_CREATION")
            self.assertEqual(res.get("host_action"), "create_thread")
        finally:
            if previous is None:
                os.environ.pop("CODEX_THREAD_ID", None)
            else:
                os.environ["CODEX_THREAD_ID"] = previous

    def initialize_memory(self):
        framework = Path(__file__).resolve().parent.parent / "skills/project-memory/scripts/runtime/framework.js"
        subprocess.run([
            "node", "-e", "require(process.argv[1]).initialize(process.argv[2], {})",
            str(framework), self.tmp_ws,
        ], check=True, capture_output=True)

    def snapshot(self):
        return {str(file.relative_to(self.tmp_ws)): file.read_bytes()
                for file in Path(self.tmp_ws).rglob("*") if file.is_file()}

    def test_codex_ready_project_provisions_and_indexes_before_binding(self):
        self.initialize_memory()
        title = "[专题 A] Windows 路径 & 中文标题"
        with patch.object(session_module, "spawn_root_conversation", return_value={"status": "PENDING_CREATION"}):
            result = session_module.create_topic_and_session("topic_a", title, self.tmp_ws, {"vendor": "codex"})
        self.assertEqual(result["status"], "PENDING_CREATION")
        doc = Path(self.tmp_memory_dir) / "topic_a.md"
        self.assertIn("project-memory:features:start", doc.read_text(encoding="utf-8"))
        self.assertIn("memory/topic_a.md", (Path(self.tmp_ws) / "docs/MEMORY.md").read_text(encoding="utf-8"))
        self.assertFalse((Path(self.tmp_ws) / ".agents/task-loop").exists())

    def test_existing_binding_does_not_recreate_missing_document(self):
        self.initialize_memory()
        session_module.bind_current_session("bound", "[专题] 功能 & 事实", "formal-test-id", self.tmp_ws,
                                            {"vendor": "codex", "id_kind": "threadId"})
        (Path(self.tmp_memory_dir) / "bound.md").unlink()
        before = self.snapshot()
        with patch.object(session_module, "spawn_root_conversation") as spawn:
            result = session_module.create_topic_and_session("bound", "Changed", self.tmp_ws, {"vendor": "codex"})
        self.assertEqual(result["status"], "EXISTS")
        spawn.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_codex_force_preserves_existing_documents(self):
        for ready in (False, True):
            with self.subTest(ready=ready):
                if ready:
                    self.initialize_memory()
                doc = Path(self.tmp_memory_dir) / "existing.md"
                doc.write_text("# [既有专题] 功能 & 事实\n原有正文\n", encoding="utf-8")
                before = self.snapshot()
                session_module.create_topic_memory_doc("existing", "Replacement",
                                                       {"ws_root": self.tmp_ws, "vendor": "codex", "force": True})
                with patch.object(session_module, "spawn_root_conversation", return_value={"status": "PENDING_CREATION"}):
                    result = session_module.create_topic_and_session("existing", "Replacement", self.tmp_ws,
                                                                    {"vendor": "codex", "force": True})
                self.assertEqual(result["status"], "PENDING_CREATION")
                self.assertEqual(self.snapshot(), before)
                session_module.bind_current_session("existing", "Replacement", "formal-test-id", self.tmp_ws,
                                                    {"vendor": "codex", "id_kind": "threadId", "force": True})
                self.assertEqual(doc.read_text(encoding="utf-8"), "# [既有专题] 功能 & 事实\n原有正文\n")

    def test_unmigrated_project_uses_legacy_template_without_migration(self):
        index = Path(self.tmp_ws) / "docs/MEMORY.md"
        index.write_text("# 原有主记忆\n业务事实\n", encoding="utf-8")
        created = create_topic_memory_doc("legacy", "Legacy", {"ws_root": self.tmp_ws, "vendor": "codex"})
        self.assertTrue(Path(created["doc_path"]).read_text(encoding="utf-8").startswith("# [专题受控记忆]"))
        self.assertEqual(index.read_text(encoding="utf-8"), "# 原有主记忆\n业务事实\n")
        self.assertFalse((Path(self.tmp_ws) / "AGENTS.md").exists())

    def test_other_vendor_retains_legacy_template_on_ready_project(self):
        self.initialize_memory()
        index = Path(self.tmp_ws) / "docs/MEMORY.md"
        before = index.read_bytes()
        created = create_topic_memory_doc("other", "Other", {"ws_root": self.tmp_ws, "vendor": "antigravity"})
        self.assertTrue(Path(created["doc_path"]).read_text(encoding="utf-8").startswith("# [专题受控记忆]"))
        self.assertEqual(index.read_bytes(), before)

    def test_previews_and_client_id_rejection_do_not_write(self):
        self.initialize_memory()
        before = self.snapshot()
        with patch.object(session_module, "uses_managed_topic_memory") as managed, \
                patch.object(session_module, "spawn_root_conversation") as spawn:
            session_module.create_topic_and_session("preview", "Preview", self.tmp_ws,
                                                    {"vendor": "codex", "dry_run": True, "force": True})
            session_module.bind_current_session("preview", "Preview", "formal-id", self.tmp_ws,
                                                {"vendor": "codex", "dry_run": True, "id_kind": "threadId"})
            with self.assertRaisesRegex(ValueError, "正式 threadId"):
                session_module.bind_current_session("preview", "Preview", "client-id", self.tmp_ws,
                                                    {"vendor": "codex", "id_kind": "clientThreadId"})
        managed.assert_not_called()
        spawn.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_candidate_still_requires_explicit_memory_initialization(self):
        before = self.snapshot()
        with patch.object(session_module, "is_session_memory_workflow", return_value=True), \
                patch.object(session_module, "spawn_root_conversation") as spawn:
            with self.assertRaisesRegex(RuntimeError, "memory-init"):
                session_module.create_topic_and_session("blocked", "Blocked", self.tmp_ws, {"vendor": "codex"})
        spawn.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_node18_rejects_managed_provision_but_allows_legacy_template(self):
        self.initialize_memory()
        before = self.snapshot()
        run = subprocess.run

        def node18(args, **kwargs):
            if args == ["node", "--version"]:
                return subprocess.CompletedProcess(args, 0, "v18.20.0\n", "")
            return run(args, **kwargs)

        with patch.object(session_module.subprocess, "run", side_effect=node18):
            with self.assertRaisesRegex(RuntimeError, "Node.js 20"):
                create_topic_memory_doc("blocked", "Blocked", {"ws_root": self.tmp_ws, "vendor": "codex"})
            self.assertEqual(self.snapshot(), before)
            legacy_root = Path(self.tmp_ws) / "legacy"
            legacy_root.mkdir()
            created = create_topic_memory_doc("legacy", "Legacy", {"ws_root": str(legacy_root), "vendor": "codex"})
            self.assertTrue(Path(created["doc_path"]).is_file())

    def test_python_only_legacy_and_registered_projects_without_node(self):
        index = Path(self.tmp_ws) / "docs/MEMORY.md"
        index.write_text("# 未迁移的旧记忆\n", encoding="utf-8")
        with patch.object(session_module.subprocess, "run", side_effect=FileNotFoundError("node")) as run:
            created = create_topic_memory_doc("legacy", "Legacy", {"ws_root": self.tmp_ws, "vendor": "codex"})
        run.assert_not_called()
        self.assertTrue(Path(created["doc_path"]).is_file())
        self.assertEqual(index.read_text(encoding="utf-8"), "# 未迁移的旧记忆\n")

        index.unlink()
        self.initialize_memory()
        before = self.snapshot()
        with patch.object(session_module.subprocess, "run", side_effect=FileNotFoundError("node")), \
                patch.object(session_module, "spawn_root_conversation") as spawn:
            with self.assertRaisesRegex(RuntimeError, "需要 Node.js"):
                session_module.create_topic_and_session("blocked", "Blocked", self.tmp_ws, {"vendor": "codex"})
        spawn.assert_not_called()
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
