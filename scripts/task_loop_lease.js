#!/usr/bin/env node
/**
 * [Lease Manager] task-loop 独立租约锁模块 (Node.js)
 *
 * 统一数据结构:
 * {
 *   "schema_version": 5,
 *   "lease_id": "<uuid>",
 *   "resource": "sessions" | "todo" | "policy",
 *   "owner": {
 *     "vendor": "antigravity",
 *     "session_id": "..."
 *   },
 *   "holder_thread_id": "...",
 *   "acquired_at": "<iso>",
 *   "heartbeat_at": "<iso>",
 *   "expires_at": "<iso>"
 * }
 *
 * 核心方法:
 * - acquire(resource, owner, options)
 * - renew(leaseId, owner, options)
 * - release(leaseId, owner, options)
 * - expire(resource, options)
 * - inspect(resource, options)
 *
 * 保证并发安全:
 * - 基于底层文件系统独占原子排他互斥锁 (.lock w/ O_EXCL 'wx' 标志);
 * - 0 corrupt JSON, 0 duplicate owner, 0 lost update.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, readJson, normalizeVendor } = require('./task_loop_state');

const DEFAULT_LEASE_FILE = path.resolve(__dirname, '..', '.agents', 'task-loop', 'lease.json');
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DEFAULT_LOCK_TIMEOUT_MS = 10000; // 10 秒
const STALE_LOCK_THRESHOLD_MS = 10000; // 10 秒视为失效僵死锁

function generateUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

/**
 * 校验 Lease 对象结构 (基于 Schema 契约)
 */
function validateLease(lease, { allowReleased = false } = {}) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    const err = new Error('Lease 根节点必须为对象');
    err.code = 'TL_STATE_INVALID_SCHEMA';
    throw err;
  }
  if (allowReleased && lease.lease_id === null) {
    return true;
  }
  if (!lease.lease_id || typeof lease.lease_id !== 'string') {
    const err = new Error('Lease 缺少有效 lease_id');
    err.code = 'TL_STATE_INVALID_SCHEMA';
    throw err;
  }
  if (!lease.resource || typeof lease.resource !== 'string') {
    const err = new Error('Lease 缺少有效 resource 字段');
    err.code = 'TL_STATE_INVALID_SCHEMA';
    throw err;
  }
  if (!lease.owner || typeof lease.owner !== 'object' || !lease.owner.vendor || !lease.owner.session_id) {
    const err = new Error('Lease 缺少有效 owner 对象 (vendor 与 session_id)');
    err.code = 'TL_STATE_INVALID_SCHEMA';
    throw err;
  }
  if (!lease.acquired_at || !lease.expires_at) {
    const err = new Error('Lease 缺少有效 acquired_at 或 expires_at 字段');
    err.code = 'TL_STATE_INVALID_SCHEMA';
    throw err;
  }
  return true;
}

/**
 * 获取底层文件原子排他锁 (.lock 带有 'wx' 标志)
 */
function acquireFileLock(lockFile, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const start = Date.now();
  const dir = path.dirname(lockFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      return () => {
        try {
          fs.closeSync(fd);
        } catch (_) {}
        for (let i = 0; i < 5; i++) {
          try {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
            break;
          } catch (_) {
            sleepSync(5);
          }
        }
      };
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
        try {
          if (fs.existsSync(lockFile)) {
            const stat = fs.statSync(lockFile);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              try { fs.unlinkSync(lockFile); } catch (_) {}
            }
          }
        } catch (_) {}
        sleepSync(10 + Math.floor(Math.random() * 20));
        continue;
      }
      throw err;
    }
  }
  const timeoutErr = new Error(`获取文件锁超时 (${timeoutMs}ms): ${lockFile}`);
  timeoutErr.code = 'TL_LOCK_TIMEOUT';
  throw timeoutErr;
}

/**
 * 在底层独占锁保护下执行临界区操作
 */
function withFileLock(leaseFile, fn, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const lockFile = `${leaseFile}.lock`;
  const unlock = acquireFileLock(lockFile, timeoutMs);
  try {
    return fn();
  } finally {
    unlock();
  }
}

class LeaseManager {
  constructor(options = {}) {
    this.leasePath = options.leasePath ? path.resolve(options.leasePath) : DEFAULT_LEASE_FILE;
    this.defaultTtlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.lockTimeoutMs = options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
  }

  _resolveFile(options = {}) {
    return options.leasePath ? path.resolve(options.leasePath) : this.leasePath;
  }

  _resolveTtl(options = {}) {
    if (options.ttlMs) return options.ttlMs;
    if (options.leaseMinutes) return options.leaseMinutes * 60 * 1000;
    return this.defaultTtlMs;
  }

  /**
   * 抢占租约锁 (Acquire)
   */
  acquire(resource, owner, options = {}) {
    if (!resource) throw new Error('acquire: resource 不能为空');
    if (!owner || !owner.vendor || !owner.session_id) {
      throw new Error('acquire: owner 必须包含 vendor 和 session_id');
    }

    const normVendor = normalizeVendor(owner.vendor) || owner.vendor;
    const normOwner = { vendor: normVendor, session_id: String(owner.session_id) };
    const targetFile = this._resolveFile(options);
    const ttlMs = this._resolveTtl(options);

    return withFileLock(targetFile, () => {
      const existing = readJson(targetFile);
      const now = Date.now();
      const nowStr = new Date(now).toISOString();

      if (existing && existing.lease_id && existing.expires_at) {
        const expiresTime = new Date(existing.expires_at).getTime();
        const isExpired = now >= expiresTime;

        // 若租约尚未过期且资源匹配
        if (!isExpired && (existing.resource === resource || !existing.resource)) {
          const isSameOwner = existing.owner &&
            existing.owner.vendor === normOwner.vendor &&
            existing.owner.session_id === normOwner.session_id;

          if (isSameOwner) {
            // 同一 owner 可重入并续期
            const newExpires = new Date(now + ttlMs).toISOString();
            existing.heartbeat_at = nowStr;
            existing.expires_at = newExpires;
            validateLease(existing);
            atomicWriteJson(targetFile, existing);
            return {
              success: true,
              acquired: true,
              reentered: true,
              lease_id: existing.lease_id,
              lease: existing
            };
          }

          // 其他会话持有有效租约，无法抢占
          return {
            success: false,
            acquired: false,
            reason: 'LEASE_HELD_BY_OTHER',
            active_lease: existing
          };
        }
      }

      // 未被占用或已过期: 授予新租约
      const leaseId = generateUuid();
      const newLease = {
        schema_version: 5,
        lease_id: leaseId,
        resource: resource,
        owner: normOwner,
        holder_thread_id: normOwner.session_id,
        acquired_at: nowStr,
        heartbeat_at: nowStr,
        expires_at: new Date(now + ttlMs).toISOString()
      };

      validateLease(newLease);
      atomicWriteJson(targetFile, newLease);

      return {
        success: true,
        acquired: true,
        reentered: false,
        lease_id: leaseId,
        lease: newLease
      };
    }, options.lockTimeoutMs || this.lockTimeoutMs);
  }

  /**
   * 续期/心跳 (Renew)
   */
  renew(leaseId, owner, options = {}) {
    if (!leaseId) throw new Error('renew: leaseId 不能为空');
    const targetFile = this._resolveFile(options);
    const ttlMs = this._resolveTtl(options);

    return withFileLock(targetFile, () => {
      const existing = readJson(targetFile);
      if (!existing || existing.lease_id !== leaseId) {
        return { success: false, renewed: false, reason: 'LEASE_NOT_HELD' };
      }

      if (owner) {
        const normVendor = normalizeVendor(owner.vendor) || owner.vendor;
        if (existing.owner.vendor !== normVendor || existing.owner.session_id !== String(owner.session_id)) {
          return { success: false, renewed: false, reason: 'OWNER_MISMATCH' };
        }
      }

      const now = Date.now();
      existing.heartbeat_at = new Date(now).toISOString();
      existing.expires_at = new Date(now + ttlMs).toISOString();

      validateLease(existing);
      atomicWriteJson(targetFile, existing);

      return { success: true, renewed: true, lease: existing };
    }, options.lockTimeoutMs || this.lockTimeoutMs);
  }

  /**
   * 释放租约 (Release)
   */
  release(leaseId, owner, options = {}) {
    if (!leaseId && !options.force) throw new Error('release: leaseId 不能为空 (除非指定 force: true)');
    const targetFile = this._resolveFile(options);

    return withFileLock(targetFile, () => {
      const existing = readJson(targetFile);
      if (!existing || (!options.force && existing.lease_id !== leaseId)) {
        return { success: false, released: false, reason: 'LEASE_NOT_HELD' };
      }

      if (!options.force && owner) {
        const normVendor = normalizeVendor(owner.vendor) || owner.vendor;
        if (existing.owner.vendor !== normVendor || existing.owner.session_id !== String(owner.session_id)) {
          return { success: false, released: false, reason: 'OWNER_MISMATCH' };
        }
      }

      const releasedLease = {
        schema_version: 5,
        lease_id: null,
        resource: existing.resource || 'sessions',
        owner: null,
        holder_thread_id: null,
        acquired_at: null,
        heartbeat_at: null,
        expires_at: null
      };

      atomicWriteJson(targetFile, releasedLease);
      return { success: true, released: true };
    }, options.lockTimeoutMs || this.lockTimeoutMs);
  }

  /**
   * 强制使租约过期 (Expire)
   */
  expire(resource, options = {}) {
    const targetFile = this._resolveFile(options);
    return withFileLock(targetFile, () => {
      const existing = readJson(targetFile);
      if (!existing || !existing.lease_id) {
        return { success: true, expired: false, reason: 'NO_ACTIVE_LEASE' };
      }
      if (resource && existing.resource && existing.resource !== resource) {
        return { success: false, expired: false, reason: 'RESOURCE_MISMATCH' };
      }

      existing.expires_at = '1970-01-01T00:00:00.000Z';
      atomicWriteJson(targetFile, existing);
      return { success: true, expired: true, lease: existing };
    }, options.lockTimeoutMs || this.lockTimeoutMs);
  }

  /**
   * 查看当前租约状态 (Inspect)
   */
  inspect(resource, options = {}) {
    const targetFile = this._resolveFile(options);
    const existing = readJson(targetFile);
    if (!existing || !existing.lease_id || !existing.expires_at) {
      return { active: false, is_expired: false, lease: null };
    }
    if (resource && existing.resource && existing.resource !== resource) {
      return { active: false, is_expired: false, lease: null, other_resource: existing.resource };
    }

    const now = Date.now();
    const expiresTime = new Date(existing.expires_at).getTime();
    const isExpired = now >= expiresTime;

    return {
      active: !isExpired,
      is_expired: isExpired,
      lease: existing
    };
  }
}

// 模块级单例工厂与快捷方法
const defaultManager = new LeaseManager();

module.exports = {
  LeaseManager,
  validateLease,
  acquireFileLock,
  withFileLock,
  acquire: (resource, owner, options) => defaultManager.acquire(resource, owner, options),
  renew: (leaseId, owner, options) => defaultManager.renew(leaseId, owner, options),
  release: (leaseId, owner, options) => defaultManager.release(leaseId, owner, options),
  expire: (resource, options) => defaultManager.expire(resource, options),
  inspect: (resource, options) => defaultManager.inspect(resource, options)
};
