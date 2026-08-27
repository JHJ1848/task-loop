#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for install_zcode_plugin.py
Installs into a temp destination and asserts the exported plugin copy is
a self-sufficient ZCode-loadable snapshot.
"""

import importlib.util
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "install_zcode_plugin",
    Path(__file__).resolve().parent.parent / "scripts" / "install_zcode_plugin.py",
)
installer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(installer)


def test_marketplace_naming():
    m = installer.build_marketplace("task-loop")
    assert m["name"] == "task-loop-local"
    assert m["plugins"][0]["name"] == "task-loop"
    assert m["plugins"][0]["source"] == "./"


def test_check_mode_writes_nothing():
    probe_base = tempfile.mkdtemp(prefix="test_install_check_py_")
    try:
        result = installer.install_plugin(dest_root=probe_base, check=True)
        assert result["plugin_name"] == "task-loop"
        # --check 模式只输出计划，绝不落盘
        assert not os.path.exists(result["dest"]), "check mode must not create dest"
        print("Python Installer (--check plan) test PASSED!")
    finally:
        shutil.rmtree(probe_base, ignore_errors=True)


def test_install_to_temp():
    dest_base = tempfile.mkdtemp(prefix="test_install_base_py_")
    try:
        result = installer.install_plugin(dest_root=dest_base)
        assert result["plugin_name"] == "task-loop"
        assert os.path.basename(result["dest"]) == "task-loop"
        assert os.path.isdir(result["dest"])

        for d in (".zcode-plugin", "hooks", "skills", "scripts", "templates", "references", "config"):
            assert os.path.exists(os.path.join(result["dest"], d)), f"dest/{d} must exist"
        for f in ("plugin.json", "hooks.json", "SKILL.md", "README.md", "marketplace.json", "EXPORT-INFO.md"):
            assert os.path.exists(os.path.join(result["dest"], f)), f"dest/{f} must exist"

        # 开发态内容严禁混入
        for forbidden in ("tests", "docs", "AGENTS.md", ".git"):
            assert not os.path.exists(os.path.join(result["dest"], forbidden)), f"{forbidden} must NOT be exported"

        market = json.loads(Path(result["dest"], "marketplace.json").read_text(encoding="utf-8"))
        assert market["name"] == "task-loop-local"

        manifest = json.loads(
            Path(result["dest"], ".zcode-plugin", "plugin.json").read_text(encoding="utf-8")
        )
        assert manifest["name"] == "task-loop"

        # 副本自洽: hook 引用的脚本存在且可独立出上下文注入
        hooks_dir = Path(result["dest"], "scripts", "hooks")
        assert (hooks_dir / "inject_session_context_zcode.js").is_file()
        assert (hooks_dir / "inject_session_context_zcode.py").is_file()

        sys.path.insert(0, str(hooks_dir))
        for mod_name in list(sys.modules):
            if mod_name in ("inject_session_context", "inject_session_context_zcode"):
                del sys.modules[mod_name]
        inject_mod = importlib.import_module("inject_session_context_zcode")
        out = inject_mod.process_payload({"session_id": "sess_itest", "cwd": result["dest"]}, env={})
        assert "[Plugin: task-loop | 会话上下文感知]" in out["hookSpecificOutput"]["additionalContext"]

        # 幂等重装: 第二次执行仍成功且内容一致
        result2 = installer.install_plugin(dest_root=dest_base)
        assert result2["plugin_name"] == "task-loop"

        print("Python Installer (copy + idempotent reinstall) test PASSED!")
    finally:
        shutil.rmtree(dest_base, ignore_errors=True)


def test_overlap_guard():
    source_root = Path(__file__).resolve().parent.parent
    try:
        installer.install_plugin(source_root=str(source_root), dest_root=str(source_root.parent))
        raise AssertionError("overlapping dest must be refused")
    except RuntimeError as err:
        assert ("包含关系" in str(err)) or ("相同" in str(err))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    test_marketplace_naming()
    test_check_mode_writes_nothing()
    test_install_to_temp()
    test_overlap_guard()
    print("ALL Python Installer Tests PASSED SUCCESSFULLY!")
