'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./errors');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_INTERVAL_MS = 40;
const DEFAULT_STALE_TIMEOUT_MS = 10000; // 10秒超时自动回收死锁

/**
 * 睡眠辅助函数（同步）
 * 优先使用 Atomics.wait，若不支持则降级为短时间忙等
 */
function sleepSync(ms) {
  if (typeof Atomics !== 'undefined' && typeof SharedArrayBuffer !== 'undefined') {
    try {
      const sharedBuffer = new SharedArrayBuffer(4);
      const sharedArray = new Int32Array(sharedBuffer);
      Atomics.wait(sharedArray, 0, 0, ms);
      return;
    } catch {
      // 降级
    }
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 短暂忙等
  }
}

/**
 * 检查并尝试回收陈旧死锁
 */
function tryCleanStaleLock(lockFilePath, staleTimeoutMs) {
  try {
    if (!fs.existsSync(lockFilePath)) {
      return false;
    }
    const stat = fs.statSync(lockFilePath);
    let lockData = null;
    try {
      const raw = fs.readFileSync(lockFilePath, 'utf8');
      lockData = JSON.parse(raw);
    } catch {
      // 若 JSON 损坏，按文件修改时间为准
    }

    const timestamp = (lockData && typeof lockData.timestamp === 'number')
      ? lockData.timestamp
      : stat.mtimeMs;

    const age = Date.now() - timestamp;
    if (age > staleTimeoutMs) {
      try {
        fs.unlinkSync(lockFilePath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 获取文件排他锁
 * @param {string} lockFilePath 锁文件绝对路径
 * @param {object} options 配置选项
 * @returns {object} 锁句柄
 */
function acquireLock(lockFilePath, options = {}) {
  const timeout = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;
  const retryInterval = options.retryInterval !== undefined ? options.retryInterval : DEFAULT_RETRY_INTERVAL_MS;
  const staleTimeout = options.staleTimeout !== undefined ? options.staleTimeout : DEFAULT_STALE_TIMEOUT_MS;
  const task = options.task || process.env.TASK_LOOP_ACTIVE_TASK || 'default';

  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startTime = Date.now();

  while (true) {
    try {
      // 使用独占标志 'wx' 确保原子性创建
      const fd = fs.openSync(lockFilePath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
        task,
        created_at: new Date().toISOString()
      });
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);

      return {
        lockFilePath,
        acquired: true,
        pid: process.pid,
        timestamp: Date.now()
      };
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 尝试检查是否为陈旧死锁
        const cleaned = tryCleanStaleLock(lockFilePath, staleTimeout);
        if (cleaned) {
          // 死锁已清理，立即重试一次
          continue;
        }

        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          fail(`获取文件并发锁超时 (${timeout}ms): ${lockFilePath}`);
        }

        sleepSync(retryInterval);
      } else {
        throw err;
      }
    }
  }
}

/**
 * 释放文件锁
 * @param {string} lockFilePath 锁文件绝对路径
 */
function releaseLock(lockFilePath) {
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 忽略已删除错误，其他错误记录但不崩溃
    }
  }
}

/**
 * 自动加锁并执行回调
 * @param {string} lockFilePath 锁文件路径
 * @param {Function} fn 执行函数
 * @param {object} options 锁选项
 */
function withLock(lockFilePath, fn, options = {}) {
  acquireLock(lockFilePath, options);
  try {
    return fn();
  } finally {
    releaseLock(lockFilePath);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  withLock,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_TIMEOUT_MS
};
