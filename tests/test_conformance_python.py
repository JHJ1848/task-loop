#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Conformance Test] Golden Fixture Conformance Runner (Python)

读取 contracts/fixtures/ 下的黄金一致性测试固件并断言:
1. vendor/vendor-precedence.json: 5级优先级、别名归一化与 TL_VENDOR_AMBIGUOUS 冲突检测;
2. allowlist/allowlist-cases.json: 物理白名单边界拦截、前缀碰撞、路径穿越与豁免路径;
3. state/state-v5-sample.json: Schema v5 结构验证、OCC revision 乐观锁冲突拦截与 v4->v5 迁移.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# 确保路径解析
TEST_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TEST_DIR.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
HOOKS_DIR = SCRIPTS_DIR / "hooks"
FIXTURES_DIR = PROJECT_ROOT / "contracts" / "fixtures"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from task_loop_state import (
    RevisionConflictError,
    VendorAmbiguousError,
    migrate_to_v5,
    resolve_vendor,
    validate_state_document,
    write_partition,
)
from enforce_allowlist import is_path_allowed


def load_fixture(rel_path):
    p = FIXTURES_DIR / rel_path
    if not p.exists():
        raise FileNotFoundError(f"Fixture file not found: {p}")
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)


class TestConformancePython(unittest.TestCase):
    def test_vendor_precedence_conformance(self):
        fixture = load_fixture("vendor/vendor-precedence.json")
        tmp_mock_root = Path(tempfile.mkdtemp(prefix="conformance_vendor_py_"))
        state_dir = tmp_mock_root / ".agents" / "task-loop"
        state_dir.mkdir(parents=True, exist_ok=True)
        mock_sessions = {
            "schema_version": 5,
            "revision": 1,
            "updated_at": "2026-09-20T10:00:00+00:00",
            "vendors": {
                "antigravity": {
                    "vendor": "antigravity",
                    "main_thread_id": "mock-registered-session-id",
                    "updated_at": "2026-09-20T10:00:00+00:00",
                    "modules": {
                        "session_control": {
                            "session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
                            "memory_doc": "docs/memory/session_control.md",
                        }
                    },
                    "sessions": [
                        {"session_id": "mock-registered-session-id", "vendor": "antigravity"},
                        {"session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa", "vendor": "antigravity"},
                    ],
                }
            },
        }
        with open(state_dir / "sessions.json", "w", encoding="utf-8") as fh:
            json.dump(mock_sessions, fh, ensure_ascii=False, indent=2)

        try:
            for tc in fixture["cases"]:
                name = tc["name"]
                inp = dict(tc["input"], projectRoot=str(tmp_mock_root))
                if "expected" in tc:
                    exp = tc["expected"]
                    res = resolve_vendor(inp)
                    self.assertEqual(res["vendor"], exp["vendor"], f"[{name}] vendor mismatch")
                    self.assertEqual(res["precedence"], exp["precedence"], f"[{name}] precedence mismatch")
                    self.assertEqual(res["matched_by"], exp["matched_by"], f"[{name}] matched_by mismatch")
                elif "expected_error" in tc:
                    exp_err = tc["expected_error"]
                    with self.assertRaises(VendorAmbiguousError) as cm:
                        resolve_vendor(inp, {"project_root": str(tmp_mock_root), "throws": True})
                    self.assertEqual(cm.exception.code, exp_err["code"], f"[{name}] code mismatch")

                    res_no_throw = resolve_vendor(inp, {"project_root": str(tmp_mock_root), "throws": False})
                    self.assertEqual(res_no_throw.get("error"), exp_err["code"])

            print("Python Vendor Precedence Conformance PASSED!")
        finally:
            shutil.rmtree(str(tmp_mock_root), ignore_errors=True)

    def test_allowlist_conformance(self):
        fixture = load_fixture("allowlist/allowlist-cases.json")
        ws_root = str(PROJECT_ROOT)
        for tc in fixture["cases"]:
            if "platform" in tc and tc["platform"] != sys.platform:
                continue

            name = tc["name"]
            target_file = tc["target_file"]
            allowlist = [entry.replace("${WS_ROOT}", ws_root) for entry in tc["allowlist"]]

            if "${WS_ROOT}" in target_file:
                if sys.platform == "win32":
                    norm_ws = ws_root.replace("/", "\\")
                    target_file = target_file.replace("${WS_ROOT}", norm_ws)
                else:
                    if name == "unc_prefix_normalized_allowed":
                        target_file = "\\\\?\\" + os.path.join(ws_root, "scripts", "task_loop_state.js")
                    else:
                        target_file = target_file.replace("${WS_ROOT}", ws_root).replace("\\\\", "/").replace("\\", "/")

            expected_allowed = tc["expected_decision"] == "allow"
            decision = is_path_allowed(target_file, allowlist, ws_root)
            self.assertEqual(
                decision,
                expected_allowed,
                f"[{name}] target '{target_file}' expected decision '{tc['expected_decision']}', got '{decision}'",
            )

        print("Python Allowlist Boundary Conformance PASSED!")

    def test_state_v5_conformance(self):
        fixture = load_fixture("state/state-v5-sample.json")
        sample_doc = fixture["sample_document"]
        tmp_dir = Path(tempfile.mkdtemp(prefix="conformance_state_py_"))
        test_state_file = tmp_dir / "sessions.json"

        try:
            with open(test_state_file, "w", encoding="utf-8") as fh:
                json.dump(sample_doc, fh, ensure_ascii=False, indent=2)

            for tc in fixture["cases"]:
                name = tc["name"]
                if name == "schema_v5_validation_success":
                    val_res = validate_state_document(sample_doc, "sessions")
                    self.assertEqual(val_res["valid"], tc["expected_valid"])
                elif name == "occ_revision_match_success":
                    written = write_partition(
                        str(test_state_file),
                        "antigravity",
                        tc["partition_update"],
                        {"expected_revision": tc["expected_revision"]},
                    )
                    self.assertEqual(written["schema_version"], 5)
                    self.assertEqual(written["revision"], tc["resulting_revision"])
                elif name == "occ_revision_mismatch_conflict":
                    with self.assertRaises(RevisionConflictError) as cm:
                        write_partition(
                            str(test_state_file),
                            "antigravity",
                            tc["partition_update"],
                            {"expected_revision": tc["expected_revision"]},
                        )
                    self.assertEqual(cm.exception.code, tc["expected_error_code"])
                elif name == "legacy_v4_migration_to_v5":
                    migrated = migrate_to_v5(tc["legacy_input"], "sessions", "antigravity")
                    self.assertEqual(migrated["schema_version"], tc["expected_version"])
                    self.assertGreaterEqual(migrated["revision"], tc["expected_min_revision"])
                    self.assertIn("antigravity", migrated.get("vendors", {}))

            print("Python State Schema v5 & OCC Conformance PASSED!")
        finally:
            shutil.rmtree(str(tmp_dir), ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
