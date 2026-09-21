#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Test] LeaseManager 独立模块与并发测试 + Vendor Resolution Policy (Python)
"""

import concurrent.futures
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

# 将 scripts 目录与项目根目录添加到 sys.path
TEST_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TEST_DIR.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from task_loop_lease import LeaseManager, LeaseSchemaError, validate_lease
from task_loop_state import (
    VendorAmbiguousError,
    detect_vendor,
    resolve_vendor,
)


class TestLeaseManager(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp(prefix="task_loop_test_lease_"))
        self.lease_file = self.tmp_dir / "lease.json"
        self.manager = LeaseManager(lease_path=str(self.lease_file), ttl_ms=2000)

    def tearDown(self):
        try:
            shutil.rmtree(str(self.tmp_dir), ignore_errors=True)
        except Exception:
            pass

    def test_lease_basic_lifecycle(self):
        # 1. 初始状态
        inspect_res = self.manager.inspect("sessions")
        self.assertFalse(inspect_res["active"])
        self.assertIsNone(inspect_res["lease"])

        # 2. 正常获取租约
        owner_a = {"vendor": "antigravity", "session_id": "sess-owner-a"}
        acq_a = self.manager.acquire("sessions", owner_a)
        self.assertTrue(acq_a["success"])
        self.assertTrue(acq_a["acquired"])
        self.assertFalse(acq_a["reentered"])
        self.assertTrue(bool(acq_a["lease_id"]))
        self.assertEqual(acq_a["lease"]["resource"], "sessions")
        self.assertEqual(acq_a["lease"]["owner"]["vendor"], "antigravity")
        self.assertEqual(acq_a["lease"]["owner"]["session_id"], "sess-owner-a")

        # 3. inspect 验证活跃
        inspect_a = self.manager.inspect("sessions")
        self.assertTrue(inspect_a["active"])
        self.assertFalse(inspect_a["is_expired"])
        self.assertEqual(inspect_a["lease"]["lease_id"], acq_a["lease_id"])

        # 4. 同一 owner 重入
        reenter_a = self.manager.acquire("sessions", owner_a)
        self.assertTrue(reenter_a["success"])
        self.assertTrue(reenter_a["reentered"])
        self.assertEqual(reenter_a["lease_id"], acq_a["lease_id"])

        # 5. 其他 owner 抢占失败
        owner_b = {"vendor": "zcode", "session_id": "sess-owner-b"}
        acq_b = self.manager.acquire("sessions", owner_b)
        self.assertFalse(acq_b["success"])
        self.assertFalse(acq_b["acquired"])
        self.assertEqual(acq_b["reason"], "LEASE_HELD_BY_OTHER")

        # 6. 心跳续期
        renew_res = self.manager.renew(acq_a["lease_id"], owner_a, {"ttl_ms": 5000})
        self.assertTrue(renew_res["success"])
        self.assertTrue(renew_res["renewed"])

        # 7. 非法 owner 续期被拒
        invalid_renew = self.manager.renew(acq_a["lease_id"], owner_b)
        self.assertFalse(invalid_renew["success"])
        self.assertEqual(invalid_renew["reason"], "OWNER_MISMATCH")

        # 8. 强制过期
        exp_res = self.manager.expire("sessions")
        self.assertTrue(exp_res["success"])
        self.assertTrue(exp_res["expired"])

        inspect_exp = self.manager.inspect("sessions")
        self.assertFalse(inspect_exp["active"])
        self.assertTrue(inspect_exp["is_expired"])

        # 9. 过期后其他 owner 抢占成功
        acq_b_after_exp = self.manager.acquire("sessions", owner_b)
        self.assertTrue(acq_b_after_exp["success"])
        self.assertTrue(acq_b_after_exp["acquired"])
        self.assertEqual(acq_b_after_exp["lease"]["owner"]["vendor"], "zcode")

        # 10. 释放租约
        rel_res = self.manager.release(acq_b_after_exp["lease_id"], owner_b)
        self.assertTrue(rel_res["success"])
        self.assertTrue(rel_res["released"])

        inspect_after_rel = self.manager.inspect("sessions")
        self.assertFalse(inspect_after_rel["active"])
        print("Python LeaseBasicLifecycle PASSED!")

    def test_lease_schema_validation(self):
        valid_lease = {
            "schema_version": 5,
            "lease_id": "uuid-valid",
            "resource": "policy",
            "owner": {"vendor": "codex", "session_id": "codex-1"},
            "acquired_at": "2026-09-20T10:00:00+00:00",
            "heartbeat_at": "2026-09-20T10:00:00+00:00",
            "expires_at": "2026-09-20T10:05:00+00:00",
        }
        self.assertTrue(validate_lease(valid_lease))

        # 缺少 resource
        with self.assertRaises(LeaseSchemaError) as cm:
            validate_lease({"lease_id": "1", "owner": {"vendor": "a", "session_id": "b"}})
        self.assertEqual(cm.exception.code, "TL_STATE_INVALID_SCHEMA")

        # 缺少 owner
        with self.assertRaises(LeaseSchemaError) as cm2:
            validate_lease({"lease_id": "1", "resource": "todo"})
        self.assertEqual(cm2.exception.code, "TL_STATE_INVALID_SCHEMA")

        print("Python LeaseSchemaValidation PASSED!")

    def test_high_concurrency_lock_contention(self):
        concurrency = 30
        writers = [
            {"vendor": "antigravity" if i % 2 == 0 else "zcode", "session_id": f"py-writer-{i}"}
            for i in range(concurrency)
        ]

        def _worker(w):
            for attempt in range(5):
                try:
                    res = self.manager.acquire("sessions", w)
                    return {"writer": w, "res": res, "error": None}
                except (PermissionError, OSError) as e:
                    if attempt == 4:
                        return {"writer": w, "res": None, "error": str(e)}
                    time.sleep(0.02 + attempt * 0.02)
                except Exception as e:
                    return {"writer": w, "res": None, "error": str(e)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
            futures = [executor.submit(_worker, w) for w in writers]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        acquired_count = 0
        rejected_count = 0
        winner = None

        for item in results:
            self.assertIsNone(item["error"], f"Unexpected error: {item['error']}")
            if item["res"]["acquired"]:
                acquired_count += 1
                winner = item["writer"]
            else:
                rejected_count += 1
                self.assertEqual(item["res"]["reason"], "LEASE_HELD_BY_OTHER")

        # 1. 0 duplicate owner: 恰好且仅有 1 个胜出
        self.assertEqual(acquired_count, 1)
        self.assertEqual(rejected_count, concurrency - 1)
        self.assertIsNotNone(winner)

        # 2. 0 corrupt JSON: 最终落盘内容有效
        with open(self.lease_file, "r", encoding="utf-8") as fh:
            parsed_final = json.load(fh)

        self.assertTrue(validate_lease(parsed_final))
        self.assertEqual(parsed_final["owner"]["session_id"], winner["session_id"])

        # 3. 0 lost update: 胜出者顺利释放
        rel = self.manager.release(parsed_final["lease_id"], winner)
        self.assertTrue(rel["success"])
        self.assertTrue(rel["released"])

        print(f"Python HighConcurrencyLockContention PASSED ({concurrency} concurrent writers: 0 corrupt, 0 duplicate owner, 0 lost update)!")

    def test_vendor_resolution_policy_precedence(self):
        saved_env = dict(os.environ)
        try:
            for k in ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "ZCODE_SESSION_ID", "ANTIGRAVITY_CONVERSATION_ID", "CLAUDE_CONVERSATION_ID"]:
                os.environ.pop(k, None)

            # 1. Explicit vendor (优先级 1)
            res1 = resolve_vendor({"vendor": "agy", "session": {"vendor": "codex"}, "env": {"ZCODE_SESSION_ID": "1"}})
            self.assertEqual(res1["vendor"], "antigravity")
            self.assertEqual(res1["precedence"], 1)
            self.assertEqual(res1["matched_by"], "explicit_vendor")

            # 2. Explicit session payload (优先级 2)
            res2 = resolve_vendor({"session": {"vendor": "zcode"}, "env": {"ANTIGRAVITY_CONVERSATION_ID": "2"}})
            self.assertEqual(res2["vendor"], "zcode")
            self.assertEqual(res2["precedence"], 2)
            self.assertEqual(res2["matched_by"], "explicit_session_payload")

            # 3. Registered session identity (优先级 3)
            tmp_mock_root = Path(tempfile.mkdtemp(prefix="lease_vendor_py_"))
            mock_state_dir = tmp_mock_root / ".agents" / "task-loop"
            mock_state_dir.mkdir(parents=True, exist_ok=True)
            with open(mock_state_dir / "sessions.json", "w", encoding="utf-8") as fh:
                json.dump({
                    "schema_version": 5,
                    "vendors": {
                        "antigravity": {
                            "vendor": "antigravity",
                            "main_thread_id": "mock-reg-py-id",
                            "sessions": [{"session_id": "mock-reg-py-id", "vendor": "antigravity"}]
                        }
                    }
                }, fh, ensure_ascii=False, indent=2)

            try:
                res3 = resolve_vendor({"sessionId": "mock-reg-py-id", "env": {"CODEX_THREAD_ID": "th-1"}, "projectRoot": str(tmp_mock_root)})
            finally:
                shutil.rmtree(str(tmp_mock_root), ignore_errors=True)

            self.assertEqual(res3["vendor"], "antigravity")
            self.assertEqual(res3["precedence"], 3)
            self.assertEqual(res3["matched_by"], "registered_session_identity")

            # 4. Runtime-native environment (优先级 4)
            res4 = resolve_vendor({"env": {"CODEX_THREAD_ID": "codex-th"}})
            self.assertEqual(res4["vendor"], "codex")
            self.assertEqual(res4["precedence"], 4)
            self.assertEqual(res4["matched_by"], "runtime_environment")

            # 5. Runtime-native environment 冲突 (TL_VENDOR_AMBIGUOUS)
            with self.assertRaises(VendorAmbiguousError) as cm:
                resolve_vendor({"env": {"CODEX_THREAD_ID": "th", "ZCODE_SESSION_ID": "zc"}})
            self.assertEqual(cm.exception.code, "TL_VENDOR_AMBIGUOUS")

            res_ambiguous = resolve_vendor({"env": {"CODEX_THREAD_ID": "th", "ZCODE_SESSION_ID": "zc"}}, {"throws": False})
            self.assertEqual(res_ambiguous["error"], "TL_VENDOR_AMBIGUOUS")
            self.assertEqual(res_ambiguous["vendor"], "UNKNOWN")

            # 6. UNKNOWN (优先级 5)
            res5 = resolve_vendor({"env": {}})
            self.assertEqual(res5["vendor"], "UNKNOWN")
            self.assertEqual(res5["precedence"], 5)

            print("Python VendorResolutionPolicyPrecedence PASSED!")
        finally:
            os.environ.clear()
            os.environ.update(saved_env)


if __name__ == "__main__":
    unittest.main()
