#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
[Lease Manager] task-loop 独立租约锁模块 (Python 标准库零依赖)

统一数据结构:
{
  "schema_version": 5,
  "lease_id": "<uuid>",
  "resource": "sessions" | "todo" | "policy",
  "owner": {
    "vendor": "antigravity",
    "session_id": "..."
  },
  "holder_thread_id": "...",
  "acquired_at": "<iso>",
  "heartbeat_at": "<iso>",
  "expires_at": "<iso>"
}

核心方法:
- acquire(resource, owner, options)
- renew(lease_id, owner, options)
- release(lease_id, owner, options)
- expire(resource, options)
- inspect(resource, options)

保证并发安全:
- 基于底层文件系统独占原子排他互斥锁 (.lock w/ O_CREAT | O_EXCL);
- 0 corrupt JSON, 0 duplicate owner, 0 lost update.
"""

import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# 保证当前 scripts 目录在 sys.path 中
_CURRENT_DIR = Path(__file__).resolve().parent
if str(_CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(_CURRENT_DIR))

from task_loop_state import atomic_write_json, read_json, normalize_vendor

DEFAULT_LEASE_FILE = _CURRENT_DIR.parent / ".agents" / "task-loop" / "lease.json"
DEFAULT_TTL_MS = 5 * 60 * 1000  # 5 分钟
DEFAULT_LOCK_TIMEOUT_S = 10.0
STALE_LOCK_THRESHOLD_S = 10.0


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_ms(iso_str):
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.timestamp() * 1000.0
    except Exception:
        return 0.0


def _iso_from_timestamp_ms(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000.0, timezone.utc).isoformat()


class LeaseSchemaError(ValueError):
    def __init__(self, message="Lease Schema 校验未通过"):
        super().__init__(message)
        self.code = "TL_STATE_INVALID_SCHEMA"


class LockTimeoutError(TimeoutError):
    def __init__(self, message="获取排他文件锁超时"):
        super().__init__(message)
        self.code = "TL_LOCK_TIMEOUT"


def validate_lease(lease, allow_released=False):
    """校验 Lease 对象结构 (基于 Schema 契约)"""
    if not isinstance(lease, dict):
        raise LeaseSchemaError("Lease 根节点必须为对象")
    if allow_released and lease.get("lease_id") is None:
        return True
    if not lease.get("lease_id") or not isinstance(lease["lease_id"], str):
        raise LeaseSchemaError("Lease 缺少有效 lease_id")
    if not lease.get("resource") or not isinstance(lease["resource"], str):
        raise LeaseSchemaError("Lease 缺少有效 resource 字段")
    owner = lease.get("owner")
    if not isinstance(owner, dict) or not owner.get("vendor") or not owner.get("session_id"):
        raise LeaseSchemaError("Lease 缺少有效 owner 对象 (vendor 与 session_id)")
    if not lease.get("acquired_at") or not lease.get("expires_at"):
        raise LeaseSchemaError("Lease 缺少有效 acquired_at 或 expires_at 字段")
    return True


def acquire_file_lock(lock_file, timeout_s=DEFAULT_LOCK_TIMEOUT_S):
    """获取底层文件原子排他锁 (.lock 带有 O_CREAT | O_EXCL 标志)"""
    lock_path = Path(lock_file).resolve()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()

    while time.time() - start < timeout_s:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            def unlock():
                try:
                    os.close(fd)
                except Exception:
                    pass
                for _ in range(5):
                    try:
                        if lock_path.exists():
                            lock_path.unlink()
                        break
                    except Exception:
                        time.sleep(0.005)
            return unlock
        except (FileExistsError, PermissionError, OSError):
            try:
                if lock_path.exists():
                    mtime = lock_path.stat().st_mtime
                    if time.time() - mtime > STALE_LOCK_THRESHOLD_S:
                        try:
                            lock_path.unlink()
                        except Exception:
                            pass
            except Exception:
                pass
            time.sleep(0.01 + random.uniform(0.005, 0.02))
        except Exception as e:
            raise e

    raise LockTimeoutError(f"获取文件锁超时 ({timeout_s}s): {lock_file}")


def with_file_lock(lease_file, fn, timeout_s=DEFAULT_LOCK_TIMEOUT_S):
    """在底层独占锁保护下执行临界区操作"""
    lock_file = f"{lease_file}.lock"
    unlock = acquire_file_lock(lock_file, timeout_s)
    try:
        return fn()
    finally:
        unlock()


class LeaseManager:
    def __init__(self, lease_path=None, ttl_ms=DEFAULT_TTL_MS, lock_timeout_s=DEFAULT_LOCK_TIMEOUT_S):
        self.lease_path = Path(lease_path).resolve() if lease_path else DEFAULT_LEASE_FILE
        self.default_ttl_ms = ttl_ms
        self.lock_timeout_s = lock_timeout_s

    def _resolve_file(self, options=None):
        options = options or {}
        if options.get("lease_path") or options.get("leasePath"):
            return Path(options.get("lease_path") or options.get("leasePath")).resolve()
        return self.lease_path

    def _resolve_ttl_ms(self, options=None):
        options = options or {}
        if options.get("ttl_ms") is not None:
            return options["ttl_ms"]
        if options.get("ttlMs") is not None:
            return options["ttlMs"]
        if options.get("lease_minutes") is not None:
            return options["lease_minutes"] * 60 * 1000
        if options.get("leaseMinutes") is not None:
            return options["leaseMinutes"] * 60 * 1000
        return self.default_ttl_ms

    def acquire(self, resource, owner, options=None):
        """抢占租约锁 (Acquire)"""
        options = options or {}
        if not resource:
            raise ValueError("acquire: resource 不能为空")
        if not isinstance(owner, dict) or not owner.get("vendor") or not owner.get("session_id"):
            raise ValueError("acquire: owner 必须包含 vendor 和 session_id")

        norm_vendor = normalize_vendor(owner.get("vendor")) or owner.get("vendor")
        norm_owner = {"vendor": norm_vendor, "session_id": str(owner.get("session_id"))}
        target_file = self._resolve_file(options)
        ttl_ms = self._resolve_ttl_ms(options)
        timeout_s = options.get("lock_timeout_s") or options.get("lockTimeoutMs", 0) / 1000.0 or self.lock_timeout_s

        def _critical():
            existing = read_json(target_file)
            now_ms = time.time() * 1000.0
            now_str = _now_iso()

            if isinstance(existing, dict) and existing.get("lease_id") and existing.get("expires_at"):
                exp_ms = _parse_iso_ms(existing["expires_at"])
                is_expired = now_ms >= exp_ms

                if not is_expired and (existing.get("resource") == resource or not existing.get("resource")):
                    ex_owner = existing.get("owner")
                    is_same_owner = (
                        isinstance(ex_owner, dict)
                        and ex_owner.get("vendor") == norm_owner["vendor"]
                        and str(ex_owner.get("session_id")) == norm_owner["session_id"]
                    )

                    if is_same_owner:
                        # 重入续期
                        existing["heartbeat_at"] = now_str
                        existing["expires_at"] = _iso_from_timestamp_ms(now_ms + ttl_ms)
                        validate_lease(existing)
                        atomic_write_json(target_file, existing)
                        return {
                            "success": True,
                            "acquired": True,
                            "reentered": True,
                            "lease_id": existing["lease_id"],
                            "lease": existing,
                        }

                    return {
                        "success": False,
                        "acquired": False,
                        "reason": "LEASE_HELD_BY_OTHER",
                        "active_lease": existing,
                    }

            # 授予新租约
            lease_id = str(uuid.uuid4())
            new_lease = {
                "schema_version": 5,
                "lease_id": lease_id,
                "resource": resource,
                "owner": norm_owner,
                "holder_thread_id": norm_owner["session_id"],
                "acquired_at": now_str,
                "heartbeat_at": now_str,
                "expires_at": _iso_from_timestamp_ms(now_ms + ttl_ms),
            }

            validate_lease(new_lease)
            atomic_write_json(target_file, new_lease)

            return {
                "success": True,
                "acquired": True,
                "reentered": False,
                "lease_id": lease_id,
                "lease": new_lease,
            }

        return with_file_lock(target_file, _critical, timeout_s)

    def renew(self, lease_id, owner=None, options=None):
        """续期/心跳 (Renew)"""
        options = options or {}
        if not lease_id:
            raise ValueError("renew: lease_id 不能为空")
        target_file = self._resolve_file(options)
        ttl_ms = self._resolve_ttl_ms(options)
        timeout_s = options.get("lock_timeout_s") or options.get("lockTimeoutMs", 0) / 1000.0 or self.lock_timeout_s

        def _critical():
            existing = read_json(target_file)
            if not isinstance(existing, dict) or existing.get("lease_id") != lease_id:
                return {"success": False, "renewed": False, "reason": "LEASE_NOT_HELD"}

            if owner:
                norm_vendor = normalize_vendor(owner.get("vendor")) or owner.get("vendor")
                ex_owner = existing.get("owner", {})
                if ex_owner.get("vendor") != norm_vendor or str(ex_owner.get("session_id")) != str(owner.get("session_id")):
                    return {"success": False, "renewed": False, "reason": "OWNER_MISMATCH"}

            now_ms = time.time() * 1000.0
            existing["heartbeat_at"] = _now_iso()
            existing["expires_at"] = _iso_from_timestamp_ms(now_ms + ttl_ms)

            validate_lease(existing)
            atomic_write_json(target_file, existing)

            return {"success": True, "renewed": True, "lease": existing}

        return with_file_lock(target_file, _critical, timeout_s)

    def release(self, lease_id, owner=None, options=None):
        """释放租约 (Release)"""
        options = options or {}
        force = options.get("force", False)
        if not lease_id and not force:
            raise ValueError("release: lease_id 不能为空 (除非指定 force=True)")

        target_file = self._resolve_file(options)
        timeout_s = options.get("lock_timeout_s") or options.get("lockTimeoutMs", 0) / 1000.0 or self.lock_timeout_s

        def _critical():
            existing = read_json(target_file)
            if not isinstance(existing, dict) or (not force and existing.get("lease_id") != lease_id):
                return {"success": False, "released": False, "reason": "LEASE_NOT_HELD"}

            if not force and owner:
                norm_vendor = normalize_vendor(owner.get("vendor")) or owner.get("vendor")
                ex_owner = existing.get("owner", {})
                if ex_owner.get("vendor") != norm_vendor or str(ex_owner.get("session_id")) != str(owner.get("session_id")):
                    return {"success": False, "released": False, "reason": "OWNER_MISMATCH"}

            released_lease = {
                "schema_version": 5,
                "lease_id": None,
                "resource": existing.get("resource", "sessions"),
                "owner": None,
                "holder_thread_id": None,
                "acquired_at": None,
                "heartbeat_at": None,
                "expires_at": None,
            }

            atomic_write_json(target_file, released_lease)
            return {"success": True, "released": True}

        return with_file_lock(target_file, _critical, timeout_s)

    def expire(self, resource=None, options=None):
        """强制使租约过期 (Expire)"""
        options = options or {}
        target_file = self._resolve_file(options)
        timeout_s = options.get("lock_timeout_s") or options.get("lockTimeoutMs", 0) / 1000.0 or self.lock_timeout_s

        def _critical():
            existing = read_json(target_file)
            if not isinstance(existing, dict) or not existing.get("lease_id"):
                return {"success": True, "expired": False, "reason": "NO_ACTIVE_LEASE"}
            if resource and existing.get("resource") and existing.get("resource") != resource:
                return {"success": False, "expired": False, "reason": "RESOURCE_MISMATCH"}

            existing["expires_at"] = "1970-01-01T00:00:00+00:00"
            atomic_write_json(target_file, existing)
            return {"success": True, "expired": True, "lease": existing}

        return with_file_lock(target_file, _critical, timeout_s)

    def inspect(self, resource=None, options=None):
        """查看当前租约状态 (Inspect)"""
        options = options or {}
        target_file = self._resolve_file(options)
        existing = read_json(target_file)

        if not isinstance(existing, dict) or not existing.get("lease_id") or not existing.get("expires_at"):
            return {"active": False, "is_expired": False, "lease": None}
        if resource and existing.get("resource") and existing.get("resource") != resource:
            return {"active": False, "is_expired": False, "lease": None, "other_resource": existing.get("resource")}

        now_ms = time.time() * 1000.0
        exp_ms = _parse_iso_ms(existing["expires_at"])
        is_expired = now_ms >= exp_ms

        return {
            "active": not is_expired,
            "is_expired": is_expired,
            "lease": existing,
        }


_default_manager = LeaseManager()


def acquire(resource, owner, options=None):
    return _default_manager.acquire(resource, owner, options)


def renew(lease_id, owner=None, options=None):
    return _default_manager.renew(lease_id, owner, options)


def release(lease_id, owner=None, options=None):
    return _default_manager.release(lease_id, owner, options)


def expire(resource=None, options=None):
    return _default_manager.expire(resource, options)


def inspect(resource=None, options=None):
    return _default_manager.inspect(resource, options)
