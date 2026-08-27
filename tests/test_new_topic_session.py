import unittest
import os
import shutil
import tempfile
import json
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from scripts.new_topic_session import (
    parse_memory_doc,
    create_topic_memory_doc,
    provision_single_doc,
    provision_all_missing
)


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


if __name__ == "__main__":
    unittest.main()
