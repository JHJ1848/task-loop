#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_python_imports.py - 跨平台 Python 模块导入一致性测试
验证在不同 cwd 下加载 runtime_paths 及各核心模块均能成功，杜绝 Import 漂移与 ModuleNotFoundError。
"""

import os
import sys
import unittest
from pathlib import Path

# 测试脚本自身首先定位并引入 runtime_paths
TEST_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TEST_DIR.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import runtime_paths


class TestPythonImports(unittest.TestCase):
    def test_runtime_paths_registered(self):
        """验证 runtime_paths 成功将 scripts, providers 和 project_root 注册至 sys.path"""
        self.assertIn(str(runtime_paths.SCRIPTS_DIR), sys.path)
        self.assertIn(str(runtime_paths.PROVIDERS_DIR), sys.path)
        self.assertIn(str(runtime_paths.PROJECT_ROOT), sys.path)

    def test_core_scripts_importable(self):
        """验证核心脚本模块导入无 ModuleNotFoundError"""
        import task_loop_state
        import find_project_sessions
        import init_task_loop
        import new_topic_session

        self.assertTrue(hasattr(task_loop_state, "normalize_vendor"))
        self.assertTrue(hasattr(find_project_sessions, "find_sessions"))
        self.assertTrue(hasattr(init_task_loop, "init_task_loop"))
        self.assertTrue(hasattr(new_topic_session, "spawn_root_conversation"))

    def test_providers_importable(self):
        """验证 providers 子目录模块导入无异常"""
        import codex_model_policy
        import spawn_zcode_session
        import get_agy_project_sessions
        import get_codex_project_sessions
        import get_claude_project_sessions
        import get_zcode_project_sessions

        self.assertTrue(hasattr(codex_model_policy, "build_create_thread_request"))
        self.assertTrue(hasattr(spawn_zcode_session, "build_args"))
        self.assertTrue(hasattr(get_agy_project_sessions, "scan_agy_sessions"))
        self.assertTrue(hasattr(get_codex_project_sessions, "scan_codex_sessions"))
        self.assertTrue(hasattr(get_claude_project_sessions, "scan_claude_sessions"))
        self.assertTrue(hasattr(get_zcode_project_sessions, "scan_zcode_sessions"))


if __name__ == "__main__":
    unittest.main()
