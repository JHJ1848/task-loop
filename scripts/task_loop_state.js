#!/usr/bin/env node
/**
 * [State Store] task-loop 状态机厂商分区存储 (Schema v4)
 *
 * 存储形态: sessions.json / topics.json 顶层即为厂商分区, 动态扩展, 各工具只读写自身厂商分区,
 * 结构上杜绝跨厂商覆写:
 *
 *   {
 *     "schema_version": 4,
 *     "updated_at": "ISO",
 *     "vendors": {
 *       "zcode":       { "vendor": "zcode", "main_thread_id": "...", "updated_at": "...", "modules": {...}, "sessions": [...] },
 *       "antigravity": { ... }, "codex": { ... }, "claude": { ... }
 *     }
 *   }
 *
 * topics.json 同构, 分区内为 { vendor, updated_at, topics: [...] }。
 *
 * 兼容读取顺序 (仅读, 不回写旧格式): v4 vendors[v] -> v3 vendors[v] -> v3 顶层 (v 匹配 current_vendor 时) -> v2 顶层。
 * 首次写分区时自动把 v2/v3 整体迁移为 v4, 保留其余厂商分区不受影响。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 4;
const VENDOR_ALIASES = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  zcode: 'zcode',
  'z-code': 'zcode',
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude'
};

function detectVendor(env) {
  env = env || process.env;
  if (env.ANTIGRAVITY_CONVERSATION_ID) return 'antigravity';
  if (env.ZCODE_SESSION_ID || env.CLAUDE_SESSION_ID) return 'zcode';
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  return null;
}

function normalizeVendor(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return VENDOR_ALIASES[key] || (/^[a-z][a-z0-9_-]{0,31}$/.test(key) ? key : null);
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
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 点路径取值: getDotPath(obj, "modules.hook.session_id") */
function getDotPath(obj, dotPath) {
  if (!obj || !dotPath) return undefined;
  return dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * 迁移任意旧格式 (v2/v3) 状态为 v4。非破坏性: 旧分区内容尽量保留。
 * - v3: vendors.<v> 原样搬入; 顶层 main/modules/sessions 并入 currentVendor 分区 (分区已有内容时顶层只补缺)
 * - v2: 顶层 main/modules/sessions 并入 defaultVendor 分区
 * - topics 文件: v<3 顶层 topics 数组并入 defaultVendor
 */
function migrateToV4(raw, kind, defaultVendor) {
  if (!raw || typeof raw !== 'object') {
    return { schema_version: SCHEMA_VERSION, updated_at: nowIso(), vendors: {} };
  }
  if (raw.schema_version === SCHEMA_VERSION && raw.vendors) {
    return raw; // 已是 v4
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

  return { schema_version: SCHEMA_VERSION, updated_at: nowIso(), vendors: vendors };
}

/**
 * 读取某厂商分区 (跨版本兼容, 只读不回写)。
 * 返回分区分对象; 文件/分区不存在时返回 null。
 */
function getPartition(file, vendor, options = {}) {
  const v = normalizeVendor(vendor) || detectVendor();
  if (!v) return null;
  const raw = readJson(file);
  if (!raw) return null;

  if (raw.schema_version === SCHEMA_VERSION && raw.vendors) {
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
 * 旧格式文件在写入前整体迁移为 v4。返回写入后的完整 v4 文档。
 */
function writePartition(file, vendor, partitionData, options = {}) {
  const v = normalizeVendor(vendor) || detectVendor();
  if (!v) throw new Error('vendor 无法判定: 请显式传入 vendor 或设置宿主环境变量');

  let doc;
  if (options.kind === 'topics') {
    doc = migrateToV4(readJson(file), 'topics', v);
  } else {
    doc = migrateToV4(readJson(file), 'sessions', v);
  }

  const part = Object.assign(
    doc.vendors[v] || (options.kind === 'topics' ? emptyTopicsPartition(v) : emptyPartition(v)),
    partitionData,
    { vendor: v, updated_at: nowIso() }
  );
  doc.vendors[v] = part;
  doc.updated_at = nowIso();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

module.exports = {
  SCHEMA_VERSION,
  VENDOR_ALIASES,
  detectVendor,
  normalizeVendor,
  emptyPartition,
  emptyTopicsPartition,
  getDotPath,
  migrateToV4,
  getPartition,
  writePartition,
  readJson
};
