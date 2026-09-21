#!/usr/bin/env node
/**
 * [State Store] task-loop 状态机厂商分区存储 (Schema v5)
 *
 * 存储形态: sessions.json / topics.json 顶层即为厂商分区, 动态扩展, 各工具只读写自身厂商分区,
 * 结构上杜绝跨厂商覆写:
 *
 *   {
 *     "schema_version": 5,
 *     "revision": 1,
 *     "updated_at": "ISO",
 *     "vendors": {
 *       "zcode":       { "vendor": "zcode", "main_thread_id": "...", "updated_at": "...", "modules": {...}, "sessions": [...] },
 *       "antigravity": { ... }, "codex": { ... }, "claude": { ... }
 *     }
 *   }
 *
 * topics.json 同构, 分区内为 { vendor, updated_at, topics: [...] }。
 *
 * 特性支持:
 * 1. 事实源驱动: 从 contracts/ 读取 vendor-aliases, capabilities, error-codes;
 * 2. 乐观并发控制 (OCC): writePartition 支持 expectedRevision 校验, 冲突时抛出 TL_STATE_REVISION_CONFLICT;
 * 3. 强原子写入: 写入同目录临时文件后通过 rename 原子替换;
 * 4. 兼容读取顺序: v5 vendors[v] -> v4 vendors[v] -> v3 vendors[v] -> v3 顶层 -> v2 顶层。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 5;

function loadJsonContract(relPath, fallback) {
  const roots = [
    path.join(__dirname, '..'),
    process.cwd()
  ];
  for (const r of roots) {
    const p = path.join(r, relPath);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (_) {}
    }
  }
  return fallback;
}

const DEFAULT_VENDOR_ALIASES = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  zcode: 'zcode',
  'z-code': 'zcode',
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude'
};

const vendorAliasesContract = loadJsonContract('contracts/vendor-aliases.json', { aliases: DEFAULT_VENDOR_ALIASES });
const VENDOR_ALIASES = Object.freeze(Object.assign({}, DEFAULT_VENDOR_ALIASES, (vendorAliasesContract && vendorAliasesContract.aliases) || {}));

const DEFAULT_ERROR_CODES = {
  TL_STATE_INVALID_JSON: '状态文件 JSON 格式损坏无法解析',
  TL_STATE_INVALID_SCHEMA: '状态文件 Schema 校验未通过',
  TL_STATE_REVISION_CONFLICT: '状态文件写入乐观锁版本冲突 (Revision Conflict)',
  TL_STATE_FILE_NOT_FOUND: '状态文件不存在',
  TL_VENDOR_UNSUPPORTED: '不支持的目标宿主厂商',
  TL_VENDOR_UNAUTHENTICATED: '宿主厂商尚未完成前置登录认证',
  TL_SESSION_NOT_FOUND: '目标专题物理会话不存在',
  TL_SESSION_CREATION_FAILED: '物理会话拉起执行失败',
  TL_SESSION_PENDING_HOST: '会话依赖外部宿主手工拉起 (Pending Creation)',
  TL_SECURITY_ALLOWLIST_VIOLATION: 'PreToolUse 物理白名单拦截拒绝',
  TL_PROVIDER_CLI_MISSING: '宿主 Provider CLI 二进制缺失',
  TL_DISPATCH_TIMEOUT: '派单监控超时未激活',
  TL_VENDOR_AMBIGUOUS: '宿主厂商环境变量或上下文存在冲突歧义无法自动裁决'
};
const ERROR_CODES = Object.freeze(Object.assign({}, DEFAULT_ERROR_CODES, loadJsonContract('contracts/error-codes.json', {})));

const CAPABILITIES = Object.freeze(loadJsonContract('contracts/capabilities.json', { matrix: {} }));

const SESSION_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  BOUND: 'BOUND',
  PENDING_CREATION: 'PENDING_CREATION',
  CREATION_FAILED: 'CREATION_FAILED',
  UNSUPPORTED: 'UNSUPPORTED'
});

function detectVendor(env, options = {}) {
  env = env || process.env;
  if (options && options.strict) {
    const detected = [];
    if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) detected.push('codex');
    if (env.ZCODE_SESSION_ID) detected.push('zcode');
    if (env.ANTIGRAVITY_CONVERSATION_ID) detected.push('antigravity');
    if (env.CLAUDE_CONVERSATION_ID || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID) detected.push('claude');

    if (detected.length > 1) {
      const err = new Error(`Ambiguous vendor environment: multiple vendors detected [${detected.join(', ')}]`);
      err.code = 'TL_VENDOR_AMBIGUOUS';
      throw err;
    }
    return detected[0] || null;
  }

  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.ZCODE_SESSION_ID) return 'zcode';
  if (env.ANTIGRAVITY_CONVERSATION_ID) return 'antigravity';
  if (env.CLAUDE_CONVERSATION_ID || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID) return 'claude';
  return null;
}

function normalizeVendor(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return VENDOR_ALIASES[key] || (/^[a-z][a-z0-9_-]{0,31}$/.test(key) ? key : null);
}

function findRegisteredVendorBySessionId(sessionId, projectRoot) {
  if (!sessionId) return null;
  const root = projectRoot || path.join(__dirname, '..');
  const candidates = [
    path.join(root, '.agents', 'task-loop', 'sessions.json'),
    path.join(root, '.agents', 'task-loop', 'topics.json')
  ];
  for (const file of candidates) {
    const raw = readJson(file);
    if (!raw || !raw.vendors || typeof raw.vendors !== 'object') continue;
    for (const [vendor, part] of Object.entries(raw.vendors)) {
      if (!part) continue;
      if (part.main_thread_id === sessionId) return normalizeVendor(vendor);
      if (part.modules && typeof part.modules === 'object') {
        for (const mod of Object.values(part.modules)) {
          if (mod && (mod.session_id === sessionId || mod.sessionId === sessionId)) {
            return normalizeVendor(vendor);
          }
        }
      }
      if (Array.isArray(part.sessions)) {
        for (const s of part.sessions) {
          if (s && (s.session_id === sessionId || s.id === sessionId || s.sessionId === sessionId)) {
            return normalizeVendor(vendor);
          }
        }
      }
      if (Array.isArray(part.topics)) {
        for (const t of part.topics) {
          if (t && (t.session_id === sessionId || t.id === sessionId)) {
            return normalizeVendor(vendor);
          }
        }
      }
    }
  }
  return null;
}

/**
 * Vendor Resolution Policy (五级优先级解析):
 * 1. explicit vendor: 显式传入 vendor 参数
 * 2. explicit session payload: 会话/任务负载中声明的 vendor
 * 3. registered session identity: 通过 sessionId 从 sessions.json/topics.json 反查
 * 4. runtime-native environment: 环境变量判定 (若冲突且无法裁决统一返回/抛出 TL_VENDOR_AMBIGUOUS)
 * 5. UNKNOWN: 无法判定时回退到 UNKNOWN
 */
function resolveVendor(input = {}, options = {}) {
  let explicitVendor = null;
  let sessionPayload = null;
  let sessionId = null;
  let env = null;
  let projectRoot = null;

  if (typeof input === 'string') {
    explicitVendor = input;
  } else if (input && typeof input === 'object') {
    explicitVendor = input.vendor || null;
    sessionPayload = input.session || input.payload || null;
    sessionId = input.sessionId || input.session_id || (sessionPayload && (sessionPayload.session_id || sessionPayload.id)) || null;
    env = input.env || null;
    projectRoot = input.projectRoot || input.project_root || null;
  }

  // 1. Explicit vendor
  if (explicitVendor) {
    const v = normalizeVendor(explicitVendor);
    if (v) return { vendor: v, precedence: 1, matched_by: 'explicit_vendor' };
  }

  // 2. Explicit session payload
  if (sessionPayload && typeof sessionPayload === 'object' && sessionPayload.vendor) {
    const v = normalizeVendor(sessionPayload.vendor);
    if (v) return { vendor: v, precedence: 2, matched_by: 'explicit_session_payload' };
  }

  // 3. Registered session identity
  if (sessionId) {
    const registered = findRegisteredVendorBySessionId(sessionId, projectRoot);
    if (registered) return { vendor: registered, precedence: 3, matched_by: 'registered_session_identity' };
  }

  // 4. Runtime-native environment
  const runtimeEnv = env || (options && options.env) || process.env;
  const detected = [];
  if (runtimeEnv.CODEX_THREAD_ID || runtimeEnv.CODEX_SESSION_ID) detected.push('codex');
  if (runtimeEnv.ZCODE_SESSION_ID) detected.push('zcode');
  if (runtimeEnv.ANTIGRAVITY_CONVERSATION_ID) detected.push('antigravity');
  if (runtimeEnv.CLAUDE_CONVERSATION_ID || runtimeEnv.CLAUDE_SESSION_ID || runtimeEnv.CLAUDE_CODE_SESSION_ID) detected.push('claude');

  if (detected.length > 1) {
    const shouldThrow = options.throws !== false;
    const msg = `Vendor resolution ambiguous: multiple runtime environments detected [${detected.join(', ')}]`;
    if (shouldThrow) {
      const err = new Error(msg);
      err.code = 'TL_VENDOR_AMBIGUOUS';
      throw err;
    }
    return { vendor: 'UNKNOWN', precedence: 4, matched_by: 'runtime_environment_ambiguous', error: 'TL_VENDOR_AMBIGUOUS', message: msg };
  }

  if (detected.length === 1) {
    return { vendor: detected[0], precedence: 4, matched_by: 'runtime_environment' };
  }

  // 5. UNKNOWN
  return { vendor: 'UNKNOWN', precedence: 5, matched_by: 'UNKNOWN' };
}

function capabilitiesSupports(vendor, capability) {
  const v = normalizeVendor(vendor);
  if (!v || !CAPABILITIES.matrix || !CAPABILITIES.matrix[v]) return false;
  return Boolean(CAPABILITIES.matrix[v][capability]);
}

function getCurrentSessionId(env, vendor) {
  env = env || process.env;
  const currentVendor = normalizeVendor(vendor) || detectVendor(env);
  if (currentVendor === 'codex') return env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
  if (currentVendor === 'claude') return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CONVERSATION_ID || env.CLAUDE_SESSION_ID || null;
  if (currentVendor === 'zcode') return env.ZCODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || null;
  if (currentVendor === 'antigravity') return env.ANTIGRAVITY_CONVERSATION_ID || null;
  return null;
}

function sessionIdentity(vendor, sessionId) {
  const normalizedVendor = normalizeVendor(vendor);
  const normalizedId = sessionId == null ? '' : String(sessionId).trim();
  if (!normalizedVendor || !normalizedId) return null;
  return `${normalizedVendor}:${normalizedId}`;
}

function emptyPartition(vendor) {
  return { vendor: vendor, main_thread_id: null, updated_at: null, modules: {}, sessions: [] };
}

function emptyTopicsPartition(vendor) {
  return { vendor: vendor, updated_at: null, topics: [] };
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(file) {
  for (let i = 0; i < 5; i++) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (i === 4) return null;
      sleepSync(5);
    }
  }
  return null;
}

function validateStateDocument(doc, kind) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, code: 'TL_STATE_INVALID_SCHEMA', reason: '根节点必须为对象' };
  }
  if (typeof doc.schema_version !== 'number') {
    return { valid: false, code: 'TL_STATE_INVALID_SCHEMA', reason: '缺少 schema_version 字段' };
  }
  if (doc.schema_version >= 4 && (!doc.vendors || typeof doc.vendors !== 'object')) {
    return { valid: false, code: 'TL_STATE_INVALID_SCHEMA', reason: 'v4+ 格式必须包含 vendors 分区对象' };
  }
  return { valid: true, code: null };
}

/** 原子写入 JSON 文件 */
function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const content = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    for (let i = 0; i < 10; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        if (i === 9) throw e;
        sleepSync(5 + Math.floor(Math.random() * 5));
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

/** 点路径取值: getDotPath(obj, "modules.hook.session_id") */
function getDotPath(obj, dotPath) {
  if (!obj || !dotPath) return undefined;
  return dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * 迁移任意旧格式 (v2/v3/v4) 状态为 v5。非破坏性: 旧分区内容尽量保留。
 * 升级 schema_version 为 5，保持 revision >= 1。
 */
function migrateToV5(raw, kind, defaultVendor) {
  if (!raw || typeof raw !== 'object') {
    return { schema_version: SCHEMA_VERSION, revision: 1, updated_at: nowIso(), vendors: {} };
  }
  if (raw.schema_version === SCHEMA_VERSION && raw.vendors) {
    if (typeof raw.revision !== 'number') raw.revision = 1;
    return raw;
  }

  const vendors = {};
  const srcVendors = raw.vendors && typeof raw.vendors === 'object' ? raw.vendors : {};
  for (const [v, part] of Object.entries(srcVendors)) {
    if (part && typeof part === 'object') {
      vendors[v] = Object.assign({ vendor: v }, part);
    }
  }

  const target = normalizeVendor(raw.current_vendor) || normalizeVendor(defaultVendor) || 'antigravity';
  const hasAnyPartition = Object.keys(vendors).length > 0;
  const topLevelHasContent = (Array.isArray(raw.sessions) && raw.sessions.length > 0) ||
    (raw.modules && Object.keys(raw.modules).length > 0) ||
    (Array.isArray(raw.topics) && raw.topics.length > 0);

  if (topLevelHasContent || !hasAnyPartition) {
    if (!vendors[target]) {
      vendors[target] = kind === 'topics' ? emptyTopicsPartition(target) : emptyPartition(target);
    }
    const part = vendors[target];
    if (kind === 'topics') {
      if ((!Array.isArray(part.topics) || part.topics.length === 0) && Array.isArray(raw.topics)) {
        part.topics = raw.topics;
      }
    } else {
      if (!part.main_thread_id && raw.main_thread_id) part.main_thread_id = raw.main_thread_id;
      if ((!part.modules || Object.keys(part.modules).length === 0) && raw.modules) part.modules = raw.modules;
      if ((!part.sessions || part.sessions.length === 0) && Array.isArray(raw.sessions)) part.sessions = raw.sessions;
    }
  }

  const revision = typeof raw.revision === 'number' && raw.revision >= 1 ? raw.revision : 1;
  return { schema_version: SCHEMA_VERSION, revision, updated_at: nowIso(), vendors };
}

function migrateToV4(raw, kind, defaultVendor) {
  return migrateToV5(raw, kind, defaultVendor);
}

/**
 * 读取某厂商分区 (跨版本兼容, 只读不回写)。
 * 返回分区对象; 文件/分区不存在时返回 null。
 */
function getPartition(file, vendor, options = {}) {
  const v = normalizeVendor(vendor) || detectVendor();
  if (!v) return null;
  const raw = readJson(file);
  if (!raw) return null;

  // v5 或 v4 具有 vendors 分区
  if ((raw.schema_version === 5 || raw.schema_version === 4) && raw.vendors) {
    return raw.vendors[v] || null;
  }
  // v3
  if (raw.vendors && raw.vendors[v]) {
    return raw.vendors[v];
  }
  // v3 顶层 (当前厂商) / v2 顶层
  const current = normalizeVendor(raw.current_vendor) || detectVendor() || 'antigravity';
  if (v === current || v === normalizeVendor(options.defaultVendor)) {
    const part = emptyPartition(v);
    let has = false;
    if (raw.main_thread_id) { part.main_thread_id = raw.main_thread_id; has = true; }
    if (raw.modules && Object.keys(raw.modules).length) { part.modules = raw.modules; has = true; }
    if (Array.isArray(raw.sessions) && raw.sessions.length) { part.sessions = raw.sessions; has = true; }
    if (Array.isArray(raw.topics) && raw.topics.length) { part.topics = raw.topics; has = true; }
    return has ? part : null;
  }
  return null;
}

/**
 * 写入某厂商分区 (读-改-写, 只动自身分区)。
 * 旧格式文件在写入前整体迁移为 v5。
 * 支持 options.expectedRevision 乐观锁校验，冲突时抛出 TL_STATE_REVISION_CONFLICT。
 * 返回写入后的完整 v5 文档。
 */
function writePartition(file, vendor, partitionData, options = {}) {
  const v = normalizeVendor(vendor) || detectVendor();
  if (!v) throw new Error('vendor 无法判定: 请显式传入 vendor 或设置宿主环境变量');

  const existingRaw = readJson(file);

  // 乐观锁 revision 校验
  if (options.expectedRevision !== undefined && options.expectedRevision !== null) {
    const currentRev = (existingRaw && typeof existingRaw === 'object' && typeof existingRaw.revision === 'number')
      ? existingRaw.revision
      : null;
    if (currentRev !== null && currentRev !== options.expectedRevision) {
      const err = new Error(`StateStore revision conflict: file has revision ${currentRev}, expected ${options.expectedRevision}`);
      err.code = 'TL_STATE_REVISION_CONFLICT';
      throw err;
    }
  }

  let doc;
  if (options.kind === 'topics') {
    doc = migrateToV5(existingRaw, 'topics', v);
  } else {
    doc = migrateToV5(existingRaw, 'sessions', v);
  }

  const part = Object.assign(
    doc.vendors[v] || (options.kind === 'topics' ? emptyTopicsPartition(v) : emptyPartition(v)),
    partitionData,
    { vendor: v, updated_at: nowIso() }
  );
  doc.vendors[v] = part;
  doc.updated_at = nowIso();

  // 递增 revision (已存在的递增，初次写入为 1)
  if (existingRaw && typeof existingRaw.revision === 'number') {
    doc.revision = existingRaw.revision + 1;
  } else {
    doc.revision = 1;
  }

  atomicWriteJson(file, doc);
  return doc;
}

module.exports = {
  SCHEMA_VERSION,
  SESSION_STATUS,
  VENDOR_ALIASES,
  ERROR_CODES,
  CAPABILITIES,
  capabilitiesSupports,
  detectVendor,
  normalizeVendor,
  getCurrentSessionId,
  sessionIdentity,
  emptyPartition,
  emptyTopicsPartition,
  getDotPath,
  migrateToV5,
  migrateToV4,
  getPartition,
  writePartition,
  readJson,
  atomicWriteJson,
  validateStateDocument,
  resolveVendor,
  findRegisteredVendorBySessionId
};
