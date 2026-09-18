import unittest
import os
import shutil
import tempfile
import json
import sys

repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
scripts_dir = os.path.join(repo_root, 'scripts')
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from scripts.init_task_loop import infer_topic_mapping, init_task_loop


class TestInitSkill(unittest.TestCase):

    def test_infer_topic_mapping_standardization(self):
        mock_main = {"session_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295", "title": "当前项目作为开发仓库", "is_main": True}
        mapped_main = infer_topic_mapping(mock_main)
        self.assertEqual(mapped_main["module_key"], "main")
        self.assertEqual(mapped_main["topic_name"], "[主会话] 任务编排 & 治理中枢")
        self.assertEqual(mapped_main["memory_doc"], "docs/MEMORY.md")

        mock_hook = {"session_id": "22345678-0000-0000-0000-000000000000", "title": "Hook 拦截与状态防护", "summary": "hook lifecycle"}
        mapped_hook = infer_topic_mapping(mock_hook)
        self.assertEqual(mapped_hook["module_key"], "hook")
        self.assertEqual(mapped_hook["topic_name"], "[钩子专题] 生命周期 & 安全门禁")

        mock_subagent = {"session_id": "32345678-0000-0000-0000-000000000000", "title": "Subagent 并行与模板", "summary": "subagent workers"}
        mapped_subagent = infer_topic_mapping(mock_subagent)
        self.assertEqual(mapped_subagent["module_key"], "subagent")
        self.assertEqual(mapped_subagent["topic_name"], "[子代理专题] Subagent机制 & 动态模板")

        mock_dashboard = {"session_id": "b86d3f08-fd8d-4dc9-aaeb-8ed1608f674d", "title": "控制面板状态监控与拖拽", "summary": "dashboard web"}
        mapped_dashboard = infer_topic_mapping(mock_dashboard)
        self.assertEqual(mapped_dashboard["module_key"], "dashboard")
        self.assertEqual(mapped_dashboard["topic_name"], "[控制面板专题] 状态监控 & 拖拽交互 (dashboard)")
        self.assertEqual(mapped_dashboard["memory_doc"], "docs/memory/dashboard.md")

    def test_init_dry_run(self):
        res = init_task_loop({"dry_run": True})
        self.assertTrue(res["workspace_root"])
        self.assertTrue(res["storage_files"]["sessions_json"])
        self.assertIsInstance(res["topic_mapping_suggestions"], list)
        self.assertIsInstance(res["memory_alignment"], list)

    def test_init_isolated_workspace(self):
        os.environ["TASK_LOOP_TEST_MOCK_SPAWN"] = "1"
        def mock_spawn(title, prompt, ws_root, opt):
            return {
                "status": "CREATED",
                "vendor": opt.get("vendor", "antigravity"),
                "id": f"mock_sess_{opt.get('role', 'topic')}_{opt.get('vendor')}",
                "id_kind": "threadId" if opt.get("vendor") == "codex" else "conversationId",
                "resumable": True,
                "physical_session": True,
                "title": title
            }

        tmp_ws = tempfile.mkdtemp(prefix="task_loop_init_py_test_")
        try:
            tmp_mem = os.path.join(tmp_ws, "docs", "memory")
            os.makedirs(tmp_mem, exist_ok=True)
            with open(os.path.join(tmp_mem, "hook.md"), "w", encoding="utf-8") as f:
                f.write("# Hook Memory")

            # Initialize with antigravity vendor (with mock spawn)
            res_agy = init_task_loop({
                "ws_root": tmp_ws,
                "dry_run": False,
                "vendor": "antigravity",
                "main_session_id": "sess_agy_main",
                "force_main": True,
                "spawn_conversation": mock_spawn
            })
            self.assertTrue(os.path.exists(res_agy["storage_files"]["sessions_json"]))
            self.assertTrue(os.path.exists(res_agy["storage_files"]["sessions_vendor_json"]))
            self.assertTrue(os.path.exists(res_agy["storage_files"]["topics_json"]))
            self.assertTrue(os.path.exists(res_agy["storage_files"]["todo_json"]))
            self.assertTrue(os.path.exists(res_agy["storage_files"]["policy_json"]))

            with open(res_agy["storage_files"]["sessions_json"], "r", encoding="utf-8") as f:
                data_agy = json.load(f)
                self.assertEqual(data_agy.get("schema_version"), 4)
                self.assertEqual(data_agy["vendors"]["antigravity"]["vendor"], "antigravity")
                self.assertEqual(data_agy["vendors"]["antigravity"]["main_thread_id"], "sess_agy_main")
                self.assertIn("antigravity", data_agy.get("vendors", {}))

            # Initialize with zcode vendor on top of the same workspace -> must preserve antigravity partition!
            res_zcode = init_task_loop({
                "ws_root": tmp_ws,
                "dry_run": False,
                "vendor": "zcode",
                "main_session_id": "sess_zcode_main",
                "force_main": True,
                "spawn_conversation": mock_spawn
            })
            with open(res_zcode["storage_files"]["sessions_json"], "r", encoding="utf-8") as f:
                data_zcode = json.load(f)
                self.assertEqual(data_zcode.get("schema_version"), 4)
                self.assertEqual(data_zcode["vendors"]["zcode"]["vendor"], "zcode")
                self.assertEqual(data_zcode["vendors"]["zcode"]["main_thread_id"], "sess_zcode_main")
                self.assertEqual(data_zcode["vendors"]["antigravity"]["main_thread_id"], "sess_agy_main")
                self.assertIn("zcode", data_zcode["vendors"])
            self.assertTrue(os.path.exists(os.path.join(tmp_ws, ".agents", "task-loop", "sessions.antigravity.json")))
            self.assertTrue(os.path.exists(os.path.join(tmp_ws, ".agents", "task-loop", "sessions.zcode.json")))
        finally:
            shutil.rmtree(tmp_ws, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
