#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit test for ZCode Session Provider (Python)
1. sqlite 读库路径: 用标准库 sqlite3 构建临时 db.sqlite fixture
2. rollout JSONL 兜底路径: 构建伪造 transcript 并验证行扫描
"""

import json
import os
import sqlite3
import sys
import tempfile
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "providers"))

from get_zcode_project_sessions import (  # noqa: E402
    scan_sessions_via_db,
    scan_sessions_via_rollout,
)


def _norm(p: str) -> str:
    return os.path.abspath(p).replace("\\", "/").rstrip("/").lower()


def build_db_fixture(db_path, project_dir):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(
        "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,"
        " directory TEXT, path TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT)"
    )
    cur.execute(
        "CREATE TABLE input_history (id INTEGER PRIMARY KEY, session_id TEXT,"
        " text TEXT, kind TEXT, time_created INTEGER)"
    )
    pid = "sess_99999999-8888-7777-6666-555555555555"
    now_ms = 1787700000000
    cur.execute(
        "INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?, 'interactive')",
        (pid, "适配 ZCode 插件钩子", project_dir, project_dir, now_ms, now_ms + 60000),
    )
    cur.execute(
        "INSERT INTO input_history (session_id, text, kind, time_created) VALUES (?, ?, 'prompt', ?)",
        (pid, "帮我适配 ZCode 的 hooks.json\n第二行应被截断", now_ms),
    )
    con.commit()
    con.close()
    return pid


def test_db_path():
    project_dir = tempfile.mkdtemp(prefix="test_zcode_proj_py_")
    db_dir = tempfile.mkdtemp(prefix="test_zcode_db_py_")
    try:
        db_path = os.path.join(db_dir, "db.sqlite")
        pid = build_db_fixture(db_path, project_dir)

        sessions = scan_sessions_via_db(
            project_dir,
            options={"db_path": db_path, "rollout_dir": os.path.join(db_dir, "missing")},
            inspect_activity=True,
        )
        assert len(sessions) == 1, f"expected 1 zcode session, got {len(sessions)}"
        s = sessions[0]
        assert s["vendor"] == "zcode"
        assert s["session_id"] == pid
        assert s["title"] == "适配 ZCode 插件钩子"
        assert s["recent_prompts"], "input_history prompts missing"
        assert s["recent_prompts"][-1].startswith("帮我适配")
        assert s["created_at"].endswith("Z")
        assert s["last_active_at"].endswith("Z")

        # 另一个项目的会话必须被过滤
        foreign = scan_sessions_via_db(
            tempfile.mkdtemp(prefix="test_zcode_foreign_py_"),
            options={"db_path": db_path},
            inspect_activity=False,
        )
        assert foreign == []
        print("Python ZCode Provider (sqlite db) test PASSED!")
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(db_dir, ignore_errors=True)


def test_rollout_fallback():
    project_dir = tempfile.mkdtemp(prefix="test_zcode_proj2_py_")
    rollout_dir = tempfile.mkdtemp(prefix="test_zcode_rollout2_py_")
    try:
        norm_root = _norm(project_dir)
        log_file = os.path.join(rollout_dir, "model-io-sess_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")
        line_real = json.dumps({
            "requestId": "r1",
            "request": {
                "body": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": f"refactor {norm_root}/hooks gate"}]}
                    ]
                }
            },
        })
        line_foreign = json.dumps({
            "request": {
                "body": {
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "nothing to do with this repo"}]}
                    ]
                }
            },
        })
        with open(log_file, "w", encoding="utf-8") as fh:
            fh.write("\n".join([line_real, line_foreign]))

        sessions = scan_sessions_via_rollout(project_dir, options={"rollout_dir": rollout_dir}, inspect_activity=True)
        assert len(sessions) == 1, f"expected 1 fallback session, got {len(sessions)}"
        s = sessions[0]
        assert s["vendor"] == "zcode"
        assert s["session_id"] == "sess_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        assert any(p.startswith("refactor") for p in s["recent_prompts"])
        print("Python ZCode Provider (rollout fallback) test PASSED!")
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(rollout_dir, ignore_errors=True)


if __name__ == "__main__":
    test_db_path()
    test_rollout_fallback()
