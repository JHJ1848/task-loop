import unittest
import os
import shutil
import tempfile
import json
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from scripts.init_task_loop import infer_topic_mapping, init_task_loop


class TestInitSkill(unittest.TestCase):

    def test_infer_topic_mapping_standardization(self):
        mock_main = {"session_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295", "title": "当前项目作为开发仓库", "is_main": True}
        mapped_main = infer_topic_mapping(mock_main)
        self.assertEqual(mapped_main["module_key"], "main")
        self.assertEqual(mapped_main["topic_name"], "[主会话] 任务编排 & 治理中枢")

        mock_hook = {"session_id": "22345678-0000-0000-0000-000000000000", "title": "Hook 拦截与状态防护", "summary": "hook lifecycle"}
        mapped_hook = infer_topic_mapping(mock_hook)
        self.assertEqual(mapped_hook["module_key"], "hook")
        self.assertEqual(mapped_hook["topic_name"], "[钩子专题] 生命周期 & 安全门禁")

        mock_subagent = {"session_id": "32345678-0000-0000-0000-000000000000", "title": "Subagent 并行与模板", "summary": "subagent workers"}
        mapped_subagent = infer_topic_mapping(mock_subagent)
        self.assertEqual(mapped_subagent["module_key"], "subagent")
        self.assertEqual(mapped_subagent["topic_name"], "[子代理专题] 动态模板 & 编排治理")

    def test_init_dry_run(self):
        res = init_task_loop({"dry_run": True})
        self.assertTrue(res["workspace_root"])
        self.assertTrue(res["storage_files"]["sessions_json"])
        self.assertIsInstance(res["topic_mapping_suggestions"], list)
        self.assertIsInstance(res["memory_alignment"], list)

    def test_init_isolated_workspace(self):
        tmp_ws = tempfile.mkdtemp(prefix="task_loop_init_py_test_")
        try:
            tmp_mem = os.path.join(tmp_ws, "docs", "memory")
            os.makedirs(tmp_mem, exist_ok=True)
            with open(os.path.join(tmp_mem, "sample.md"), "w", encoding="utf-8") as f:
                f.write("# Sample Memory")

            res = init_task_loop({"ws_root": tmp_ws, "dry_run": False})
            self.assertTrue(os.path.exists(res["storage_files"]["sessions_json"]))
            self.assertTrue(os.path.exists(res["storage_files"]["topics_json"]))
            self.assertTrue(os.path.exists(res["storage_files"]["todo_json"]))
            self.assertTrue(os.path.exists(res["storage_files"]["policy_json"]))

            with open(res["storage_files"]["sessions_json"], "r", encoding="utf-8") as f:
                data = json.load(f)
                self.assertEqual(data.get("schema_version"), 2)
        finally:
            shutil.rmtree(tmp_ws, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
