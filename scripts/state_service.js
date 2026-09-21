#!/usr/bin/env node
/**
 * [State Service] task-loop 状态机统一集中校验、读写与收口服务
 * 
 * 核心职责:
 * 1. 集中管理 sessions.json, todo.json, policy.json, lease.json 的读写；
 * 2. 严格结构/Schema 校验，杜绝任何非法或破损 JSON 破坏系统状态；
 * 3. 厂商分区保护 (Vendor Partition Protection): 严禁任意写操作覆盖或冲掉其他厂商分区；
 * 4. 原子安全写入 (Atomic Write): 写入临时文件后重命名覆盖，杜绝半写入与数据损坏；
 * 5. 自动同步镜像文件 (如 sessions.<vendor>.json)。
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_FILES = Object.freeze([
  'sessions.json',
  'todo.json',
  'policy.json',
  'lease.json',
  'topics.json'
]);

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * 校验指定状态文件内容合法性
 * @param {string} file 文件名 (如 'todo.json')
 * @param {*} data 待校验数据 (对象)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateState(file, data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'State payload must be a non-null object' };
  }

  if (file === 'todo.json') {
    if (typeof data.schema_version !== 'number' && typeof data.schema_version !== 'string') {
      return { valid: false, error: 'todo.json missing valid schema_version' };
    }
    if (!Array.isArray(data.items)) {
      return { valid: false, error: 'todo.json items must be an array' };
    }
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (!item || typeof item !== 'object') {
        return { valid: false, error: `todo.json item[${i}] must be an object` };
      }
      if (!item.id || typeof item.id !== 'string') {
        return { valid: false, error: `todo.json item[${i}] missing valid id string` };
      }
      if (item.status && !['pending', 'in_progress', 'dispatched', 'done'].includes(item.status)) {
        return { valid: false, error: `todo.json item[${i}] has invalid status: ${item.status}` };
      }
      if (item.complexity !== undefined) {
        const comp = Number(item.complexity);
        if (![1, 2, 3].includes(comp)) {
          return { valid: false, error: `todo.json item[${i}] complexity must be 1, 2, or 3` };
        }
      }
    }
    return { valid: true };
  }

  if (file === 'sessions.json') {
    if (data.schema_version !== undefined && typeof data.schema_version !== 'number') {
      return { valid: false, error: 'sessions.json schema_version must be number' };
    }
    if (data.vendors !== undefined) {
      if (typeof data.vendors !== 'object' || data.vendors === null || Array.isArray(data.vendors)) {
        return { valid: false, error: 'sessions.json vendors must be an object mapping' };
      }
      for (const [vendorKey, vData] of Object.entries(data.vendors)) {
        if (!vData || typeof vData !== 'object' || Array.isArray(vData)) {
          return { valid: false, error: `sessions.json vendor[${vendorKey}] must be an object` };
        }
      }
    }
    return { valid: true };
  }

  if (file === 'policy.json') {
    if (data.active_vendor && typeof data.active_vendor !== 'string') {
      return { valid: false, error: 'policy.json active_vendor must be string' };
    }
    if (data.lease_minutes !== undefined) {
      const lm = Number(data.lease_minutes);
      if (isNaN(lm) || lm <= 0) {
        return { valid: false, error: 'policy.json lease_minutes must be positive number' };
      }
    }
    if (data.allow_remote_push !== undefined && typeof data.allow_remote_push !== 'boolean') {
      return { valid: false, error: 'policy.json allow_remote_push must be boolean' };
    }
    return { valid: true };
  }

  if (file === 'lease.json') {
    if (data.status && !['LOCKED', 'UNLOCKED'].includes(data.status)) {
      return { valid: false, error: 'lease.json status must be LOCKED or UNLOCKED' };
    }
    return { valid: true };
  }

  if (file === 'topics.json') {
    return { valid: true };
  }

  return { valid: false, error: `Unsupported state file: ${file}` };
}

/**
 * 安全读取状态文件
 */
function readState(file, stateDir) {
  const targetDir = stateDir || path.resolve(process.cwd(), '.agents', 'task-loop');
  const filePath = path.join(targetDir, file);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 读取全量四大状态机状态
 */
function getAllState(stateDir) {
  const targetDir = stateDir || path.resolve(process.cwd(), '.agents', 'task-loop');
  const result = {};
  for (const f of ['sessions.json', 'todo.json', 'policy.json', 'lease.json']) {
    result[f] = readState(f, targetDir);
  }
  return result;
}

/**
 * 集中校验并原子安全写入状态文件
 * 针对 sessions.json 进行多厂商分区合并保护，严防裸写覆盖其他厂商
 */
function saveState(file, data, stateDir) {
  const targetDir = stateDir || path.resolve(process.cwd(), '.agents', 'task-loop');
  
  if (!ALLOWED_FILES.includes(file)) {
    throw new Error(`Forbidden state file: ${file}. Allowed: ${ALLOWED_FILES.join(', ')}`);
  }

  const payload = typeof data === 'string' ? JSON.parse(data) : data;
  const validation = validateState(file, payload);
  if (!validation.valid) {
    throw new Error(`Validation failed for ${file}: ${validation.error}`);
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const targetPath = path.join(targetDir, file);
  let finalData = payload;

  // sessions.json 厂商多分区合并保护 (防止裸写覆盖其他厂商)
  if (file === 'sessions.json') {
    const existing = readState('sessions.json', targetDir);
    if (existing && existing.vendors && typeof existing.vendors === 'object') {
      const mergedVendors = Object.assign({}, existing.vendors);
      if (payload.vendors && typeof payload.vendors === 'object') {
        for (const [vKey, vVal] of Object.entries(payload.vendors)) {
          mergedVendors[vKey] = Object.assign({}, existing.vendors[vKey] || {}, vVal);
        }
      }
      finalData = Object.assign({}, existing, payload, {
        schema_version: 4,
        vendors: mergedVendors,
        updated_at: new Date().toISOString()
      });
    } else {
      finalData = Object.assign({}, payload, {
        schema_version: 4,
        updated_at: new Date().toISOString()
      });
    }
  }

  // policy.json 保护与合并
  if (file === 'policy.json') {
    const existing = readState('policy.json', targetDir) || {};
    finalData = Object.assign({ schema_version: 1 }, existing, payload);
  }

  const content = JSON.stringify(finalData, null, 2) + '\n';

  // 原子写入: 临时文件 -> 同步落盘 -> rename 覆盖
  const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);

  // 镜像文件自动同步 (如 sessions.<vendor>.json)
  if (file === 'sessions.json' && finalData.vendors) {
    for (const [vKey, vPart] of Object.entries(finalData.vendors)) {
      try {
        const mirrorPath = path.join(targetDir, `sessions.${vKey}.json`);
        fs.writeFileSync(mirrorPath, JSON.stringify(vPart, null, 2) + '\n', 'utf8');
      } catch (err) {}
    }
  }

  return {
    ok: true,
    file,
    bytes: Buffer.byteLength(content, 'utf8'),
    data: finalData
  };
}

module.exports = {
  ALLOWED_FILES,
  MAX_PAYLOAD_BYTES,
  validateState,
  readState,
  getAllState,
  saveState
};
