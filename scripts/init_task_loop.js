#!/usr/bin/env node
/**
 * [task-loop] Interactive Project Initialization & Existing Session Survey
 * 
 * 1. 扫描当前工作区已有的历史会话 (AGY / Codex / Claude)
 * 2. 启发式分析历史会话标题与内容，生成专题映射建议清单
 * 3. 支持预览建议清单 (Dry Run) 与一键写入状态机
 * 4. 明确告知用户底层 JSON 存储路径 (.agents/task-loop/sessions.json)，支持直接手动兜底修改
 */

const fs = require('fs');
const path = require('path');
const codexModelPolicy = require('./providers/codex_model_policy');
const stateStore = require('./task_loop_state');
const { spawnRootConversation: createRootConversation } = require('./new_topic_session');

/**
 * 容错 Provider 注册表: 已知厂商扫描器按序尝试加载, 缺失即跳过。
 * 各分支可自带额外 Provider (如 ZCode), 只要文件存在即被自动纳入,
 * 导出名归一化兼容 scanZcodeSessions / scanZCodeSessions 两种拼写。
 */
const PROVIDER_MODULES = [
  { vendor: 'antigravity', path: './providers/get_agy_project_sessions', names: ['scanAgySessions'] },
  { vendor: 'codex', path: './providers/get_codex_project_sessions', names: ['scanCodexSessions'] },
  { vendor: 'claude', path: './providers/get_claude_project_sessions', names: ['scanClaudeSessions'] },
  { vendor: 'zcode', path: './providers/get_zcode_project_sessions', names: ['scanZcodeSessions', 'scanZCodeSessions'] }
];

function loadProviderRegistry() {
  const registry = [];
  for (const def of PROVIDER_MODULES) {
    try {
      const mod = require(def.path);
      const fnName = def.names.find(n => typeof mod[n] === 'function');
      if (fnName) {
        registry.push({ vendor: def.vendor, scan: mod[fnName] });
      }
    } catch (e) {
      // Provider 文件不存在 (通用主线未携带某厂商适配) -> 优雅跳过
    }
  }
  return registry;
}

/** 检测当前宿主厂商, 用于可续接性 (resumable) 判定 */
function detectCurrentVendor(env, currentSessionId) {
  env = env || process.env;
  const detected = stateStore.normalizeVendor(stateStore.detectVendor(env));
  if (detected) return detected;
  // sess_ 仅作为无宿主环境标记时的 ZCode 兼容线索，不能覆盖 Claude 标记。
  if (currentSessionId && /^sess_/i.test(currentSessionId) && !env.CLAUDE_SESSION_ID) return 'zcode';
  return null;
}

/** 标题清洗: 去链接标记/首尾残片/多余空白 */
function sanitizeTitle(raw) {
  let t = String(raw || '')
    .replace(/\[[^\]]+\]\([^\)]+\)/g, '')
    .replace(/\\+/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  t = t.replace(/[\s\u3000]+$/g, '').replace(/^[\s\u3000]+/g, '');
  return t || '(无标题)';
}

/** 模块 Key 卫生校验: 仅允许小写字母/数字/下划线 */
function isValidModuleKey(key) {
  return typeof key === 'string' && /^[a-z0-9_]+$/.test(key);
}

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

/**
 * 启发式推断标准化专题名称与模块 Key
 * 严格以 docs/memory/*.md 为法定事实源进行对齐
 */
function inferTopicMapping(session, knownMemoryKeys) {
  const rawTitle = sanitizeTitle(session.title);
  const titleLower = rawTitle.toLowerCase();
  const summaryLower = (session.summary || '').toLowerCase();
  const promptsLower = (session.recent_prompts || []).join(' ').toLowerCase();
  const touchedLower = (session.recent_touched_files || []).join(' ').toLowerCase();
  const fullText = `${titleLower} ${summaryLower} ${promptsLower} ${touchedLower}`;

  let moduleKey = null;
  let topicName = rawTitle;

  if (session.is_main || titleLower.includes('main') || fullText.includes('治理中枢') || fullText.includes('开发仓库')) {
    moduleKey = 'main';
    topicName = '[主会话] 任务编排 & 治理中枢';
  } else if (fullText.includes('hook') || fullText.includes('钩子') || fullText.includes('生命周期') || fullText.includes('安全门禁')) {
    moduleKey = 'hook';
    topicName = '[钩子专题] 生命周期 & 安全门禁';
  } else if (fullText.includes('subagent') || fullText.includes('子代理') || fullText.includes('动态模板') || fullText.includes('编排治理')) {
    moduleKey = 'subagent';
    topicName = '[子代理专题] Subagent机制 & 动态模板';
  } else if (fullText.includes('session_control') || fullText.includes('session') || fullText.includes('会话控制') || fullText.includes('会话管理')) {
    moduleKey = 'session_control';
    topicName = '[Session] SDK & Scripting';
  } else if (fullText.includes('plugin_spec') || fullText.includes('plugin') || fullText.includes('插件') || fullText.includes('marketplace') || fullText.includes('zcode')) {
    moduleKey = 'plugin_spec';
    topicName = '[插件专题] 多厂商插件规范与导出安装';
  } else if (fullText.includes('test_spec') || fullText.includes('自动化测试') || fullText.includes('测试专题')) {
    moduleKey = 'test_spec';
    topicName = '[测试专题] 自动化会话创建验证';
  }

  // 严格性校验: 若推断出的 moduleKey 不在 knownMemoryKeys 范围内，则不予作为常驻专题模块
  if (knownMemoryKeys && Array.isArray(knownMemoryKeys) && knownMemoryKeys.length > 0) {
    if (moduleKey && !knownMemoryKeys.includes(moduleKey)) {
      moduleKey = null;
    }
  }

  if (moduleKey) {
    return {
      module_key: moduleKey,
      needs_naming: false,
      topic_name: topicName,
      tags: [moduleKey, 'topic'],
      memory_doc: (moduleKey === 'main') ? 'docs/MEMORY.md' : `docs/memory/${moduleKey}.md`
    };
  }

  // 非法定记忆专题的临时会话不生成假专题
  return {
    module_key: null,
    needs_naming: false,
    topic_name: rawTitle,
    tags: [],
    memory_doc: null
  };
}

/**
 * 扫描项目现有受控记忆文档 (docs/memory/*.md)
 */
function scanExistingMemoryDocs(wsRoot) {
  const memoryDir = path.join(wsRoot, 'docs', 'memory');
  const memoryDocs = [];

  if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const moduleKey = path.basename(f, '.md');
      memoryDocs.push({
        module_key: moduleKey,
        relative_path: normalizePath(path.join('docs', 'memory', f)),
        absolute_path: normalizePath(path.join(memoryDir, f))
      });
    }
  }

  return memoryDocs;
}

const spawnRootConversation = createRootConversation;

function isReusableSession(vendor, session) {
  if (!session || !session.session_id || session.resumable !== true) return false;
  return stateStore.normalizeVendor(vendor) !== 'codex' || session.id_kind === 'threadId';
}

/**
 * 单一事实源: 严格以 docs/memory/*.md 中的法定模块为准进行 1:1 对齐匹配。
 * 粘性绑定锁保护 (Sticky Binding Lock):
 * 优先以 sessions.json 中既有确立绑定的 modules 字典为最高置信度来源，
 * 已绑定的物理会话强制锁定继承，禁止模糊分词重置为未绑定。
 */
function resolveModuleAssignments(suggestions, memoryDocs, existingModules = {}, currentVendor = 'antigravity') {
  const assignments = new Map(); // module_key -> suggestion (1:1 绑定)

  // 0. 粘性绑定锁: 优先锁定 sessions.json 中既有确立的 modules
  for (const [modKey, modVal] of Object.entries(existingModules || {})) {
    const existingVendor = stateStore.normalizeVendor(modVal && modVal.vendor) || currentVendor;
    if (isReusableSession(existingVendor, modVal)) {
      const existingIdentity = stateStore.sessionIdentity(existingVendor, modVal.session_id);
      const existingMatch = suggestions.find(s => stateStore.sessionIdentity(s.vendor, s.session_id) === existingIdentity);
      if (existingMatch) {
        existingMatch.suggested_module_key = modKey;
        if (modVal.title) existingMatch.suggested_topic_name = modVal.title;
        existingMatch.resumable = true;
        existingMatch.lifecycle_status = stateStore.SESSION_STATUS.BOUND;
        assignments.set(modKey, existingMatch);
      } else {
        assignments.set(modKey, {
          session_id: modVal.session_id,
          vendor: existingVendor,
          id_kind: modVal.id_kind,
          original_title: modVal.title || `${modKey}专题`,
          suggested_module_key: modKey,
          suggested_topic_name: modVal.title || `[${modKey}专题] 核心功能维护 & 记忆沉淀`,
          suggested_tags: modVal.tags || [modKey, 'topic'],
          suggested_memory_doc: modVal.memory_doc || `docs/memory/${modKey}.md`,
          resumable: true,
          physical_session: true,
          lifecycle_status: stateStore.SESSION_STATUS.BOUND,
          is_main_candidate: modKey === 'main'
        });
      }
    }
  }

  // 1. 先匹配 main (若未被粘性锁定)
  if (!assignments.has('main')) {
    const mainCand = suggestions.find(s => s.is_main_candidate) || suggestions.find(s => s.suggested_module_key === 'main');
    if (mainCand) {
      assignments.set('main', mainCand);
    }
  }

  // 2. 为每个受控记忆文档匹配首个最合适的建议项 (排除已绑定的会话)
  const assignedSessionIds = new Set([...assignments.values()].map(a => stateStore.sessionIdentity(a.vendor, a.session_id)));
  for (const doc of (memoryDocs || [])) {
    if (doc.module_key === 'main' || assignments.has(doc.module_key)) continue;
    const matched = suggestions.find(s => s.suggested_module_key === doc.module_key && !assignedSessionIds.has(stateStore.sessionIdentity(s.vendor, s.session_id)));
    if (matched) {
      assignments.set(doc.module_key, matched);
      assignedSessionIds.add(stateStore.sessionIdentity(matched.vendor, matched.session_id));
    }
  }

  return assignments;
}

function surveyExistingSessions(wsRoot, options = {}) {
  const env = options.env || process.env;
  const explicitVendor = stateStore.normalizeVendor(options.vendor);
  const explicitCallerId = options.currentSession || options.currentSessionId || null;
  const detectedVendor = explicitVendor || detectCurrentVendor(env, explicitCallerId) || null;
  const callerSessionId = explicitCallerId || stateStore.getCurrentSessionId(env, detectedVendor) || null;
  const currentVendor = explicitVendor || detectCurrentVendor(env, callerSessionId) || detectedVendor || null;
  const explicitMainSessionId = options.mainSession || options.mainSessionId || null;

  const memoryDocs = scanExistingMemoryDocs(wsRoot);
  const memoryKeys = memoryDocs.map(d => d.module_key);

  const registry = loadProviderRegistry();
  const all = [];
  for (const p of registry) {
    try {
      const found = p.scan(wsRoot) || [];
      all.push(...found);
    } catch (e) {
      // 单个 provider 失败不阻断整体调查
    }
  }
  const uniqueMap = new Map();

  for (const s of all) {
    const sessionId = s && s.session_id != null ? String(s.session_id).trim() : '';
    const vendor = stateStore.normalizeVendor(s && s.vendor) || (currentVendor || 'antigravity');
    const identity = stateStore.sessionIdentity(vendor, sessionId);
    if (!identity || uniqueMap.has(identity)) continue;
    uniqueMap.set(identity, { ...s, session_id: sessionId, vendor });
  }

  // 若 callerSessionId 存在但在扫描中未发现，自动补入
  const callerIdentity = stateStore.sessionIdentity(currentVendor, callerSessionId);
  if (callerIdentity && !uniqueMap.has(callerIdentity)) {
    uniqueMap.set(callerIdentity, {
      session_id: callerSessionId,
      vendor: currentVendor,
      title: '[主会话] 任务编排 & 治理中枢',
      is_main: true,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString()
    });
  }

  // 主会话选定优先级:
  // 1) --main-session <id> (用户显式指定)
  // 2) --current-session 或环境变量读取到的当前活跃会话 ID (发起初始化的宿主会话最高优先级)
  // 3) 既有有效 sessions.json 中持久化的 main_thread_id (若属于当前宿主环境且存在)
  // 4) 历史扫描中明确属于当前宿主环境且带 [主会话] 标签或 is_main 的会话
  // 5) suggestions 列表中的第一项
  let chosenMainId = null;
  let chosenMainIdentity = null;
  const targetVendor = currentVendor || explicitVendor || 'antigravity';
  if (explicitMainSessionId) {
    chosenMainId = explicitMainSessionId;
    chosenMainIdentity = stateStore.sessionIdentity(targetVendor, explicitMainSessionId);
    if (chosenMainIdentity && !uniqueMap.has(chosenMainIdentity)) {
      uniqueMap.set(chosenMainIdentity, {
        session_id: explicitMainSessionId,
        vendor: targetVendor,
        title: '[主会话] 任务编排 & 治理中枢',
        is_main: true,
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      });
    }
  } else if (callerIdentity && uniqueMap.has(callerIdentity)) {
    chosenMainId = callerSessionId;
    chosenMainIdentity = callerIdentity;
  } else if (callerSessionId) {
    // callerSessionId 必定作为主会话
    chosenMainId = callerSessionId;
    chosenMainIdentity = callerIdentity;
    if (chosenMainIdentity) uniqueMap.set(chosenMainIdentity, {
      session_id: callerSessionId,
      vendor: targetVendor,
      title: '[主会话] 任务编排 & 治理中枢',
      is_main: true,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString()
    });
  } else {
    let persistedMainId = null;
    try {
      const part = stateStore.getPartition(path.join(wsRoot, '.agents', 'task-loop', 'sessions.json'), targetVendor);
      persistedMainId = part && part.main_thread_id;
    } catch {}
    const persistedIdentity = stateStore.sessionIdentity(targetVendor, persistedMainId);
    if (persistedIdentity && uniqueMap.has(persistedIdentity)) {
      chosenMainId = persistedMainId;
      chosenMainIdentity = persistedIdentity;
    }
    for (const s of uniqueMap.values()) {
      if (chosenMainIdentity || s.vendor !== targetVendor) continue;
      const rawTitle = (s.title || '').toLowerCase();
      if (s.is_main || rawTitle.includes('[主会话]') || rawTitle.includes('治理中枢')) {
        chosenMainId = s.session_id;
        chosenMainIdentity = stateStore.sessionIdentity(s.vendor, s.session_id);
        break;
      }
    }
    if (!chosenMainIdentity) {
      const firstTarget = [...uniqueMap.values()].find(s => s.vendor === targetVendor);
      if (firstTarget) {
        chosenMainId = firstTarget.session_id;
        chosenMainIdentity = stateStore.sessionIdentity(firstTarget.vendor, firstTarget.session_id);
      }
    }
  }

  const list = Array.from(uniqueMap.values());
  const suggestions = list.map(s => {
    const identity = stateStore.sessionIdentity(s.vendor, s.session_id);
    const isMainCandidate = identity === chosenMainIdentity;
    const isCurrentSession = identity === callerIdentity;

    let inferred;
    if (isMainCandidate) {
      inferred = {
        module_key: 'main',
        topic_name: (s.title && s.title.includes('[主会话]')) ? s.title : '[主会话] 任务编排 & 治理中枢',
        tags: ['main', 'orchestrator'],
        memory_doc: 'docs/MEMORY.md'
      };
    } else {
      inferred = inferTopicMapping(s, memoryKeys);
      // 如果不是 chosenMainId 但被误推断成 main，修正 module_key
      if (inferred.module_key === 'main') {
        const shortId = (s.session_id || '').slice(0, 8);
        inferred.module_key = `topic_${shortId}`;
        inferred.topic_name = `[业务专题] ${s.title || '通用开发'}`;
        inferred.tags = [inferred.module_key, 'topic'];
        inferred.memory_doc = `docs/memory/${inferred.module_key}.md`;
      }
    }

    const resumable = s.vendor === currentVendor && Boolean(s.session_id);
    return {
      session_id: s.session_id,
      vendor: s.vendor,
      id_kind: s.id_kind || (s.vendor === 'codex' ? 'threadId' : s.vendor === 'antigravity' ? 'conversationId' : 'sessionId'),
      original_title: s.original_title || sanitizeTitle(s.title),
      suggested_module_key: inferred.module_key,
      needs_naming: Boolean(inferred.needs_naming),
      suggested_topic_name: inferred.topic_name,
      suggested_tags: inferred.tags,
      suggested_memory_doc: inferred.memory_doc,
      resumable,
      physical_session: Boolean(s.session_id),
      lifecycle_status: stateStore.SESSION_STATUS.DISCOVERED,
      dispatch_hint: resumable
        ? '可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)'
        : '只读遗留: 当前宿主不可续接, 仅支持历史内省; 建议经 new-session 重建为本宿主原生专题',
      is_main_candidate: isMainCandidate,
      is_current_session: isCurrentSession
    };
  });

  // 让 is_main_candidate 的项排在最前
  suggestions.sort((a, b) => {
    if (a.is_main_candidate && !b.is_main_candidate) return -1;
    if (!a.is_main_candidate && b.is_main_candidate) return 1;
    return 0;
  });

  const sessionsPath = path.join(wsRoot, '.agents', 'task-loop', 'sessions.json');
  let existingModules = {};
  try {
    const part = stateStore.getPartition(sessionsPath, currentVendor || 'antigravity');
    if (part && part.modules) {
      existingModules = part.modules;
    }
  } catch {}

  // 单一事实源: 一次性计算模块分配, 对齐报告与持久化共用
  const assignments = resolveModuleAssignments(suggestions, memoryDocs, existingModules, currentVendor || targetVendor);

  // 扫描受控记忆文档并进行 1:1 对齐 (对齐结果同样取自 assignments, 与落盘同源)
  const memoryAlignment = memoryDocs.map(doc => {
    const matchedSession = assignments.get(doc.module_key) || null;
    const stored = existingModules[doc.module_key];
    const storedNeedsCreation = Boolean(stored) && !isReusableSession(currentVendor || targetVendor, stored);
    const status = storedNeedsCreation
      ? stateStore.SESSION_STATUS.PENDING_CREATION
      : matchedSession
      ? (matchedSession.lifecycle_status || (matchedSession.resumable ? stateStore.SESSION_STATUS.DISCOVERED : stateStore.SESSION_STATUS.PENDING_CREATION))
      : (stored && stored.lifecycle_status) || stateStore.SESSION_STATUS.PENDING_CREATION;
    return {
      module_key: doc.module_key,
      memory_doc: doc.relative_path,
      matched_session_id: matchedSession ? matchedSession.session_id : null,
      matched_vendor: matchedSession ? matchedSession.vendor : null,
      resumable: storedNeedsCreation ? false : (matchedSession ? matchedSession.resumable : false),
      matched_topic_name: matchedSession ? matchedSession.suggested_topic_name : `[${doc.module_key}专题] 核心功能维护 & 记忆沉淀`,
      status
    };
  });

  return { suggestions, memoryDocs, memoryAlignment, assignments, chosenMainId, callerSessionId, currentVendor, existingModules };
}

/**
 * 批准门禁 (纯函数): 决定哪些模块建议允许持久化。
 * 默认仅 main + 记忆文档已对齐模块; 其余进入 pending_approval, 需经
 * --modules <a,b,c> 显式批准或 --exclude 显式排除。
 */
function applyApprovalGate(assignments, memoryAlignment, options = {}) {
  const allow = new Set((options.moduleAllowlist || []).filter(Boolean));
  const exclude = new Set((options.moduleExclude || []).filter(Boolean));
  const alignedKeys = new Set(memoryAlignment.filter(a => ['BOUND', 'DISCOVERED', 'ALIGNED', 'CREATED_AND_ALIGNED'].includes(a.status)).map(a => a.module_key));

  const approved = [];
  const pending = [];
  for (const [key, suggestion] of assignments.entries()) {
    const hasPhysicalResumableSession = Boolean(suggestion && suggestion.session_id && suggestion.resumable === true);
    if (!hasPhysicalResumableSession) {
      pending.push({ module_key: key, session_id: suggestion && suggestion.session_id || null, reason: 'no physical resumable session; creation is pending or unsupported' });
      continue;
    }
    if (exclude.has(key)) {
      pending.push({ module_key: key, session_id: suggestion.session_id, reason: 'explicitly_excluded' });
      continue;
    }
    if (key === 'main' || alignedKeys.has(key) || allow.has(key)) {
      approved.push({ module_key: key, session_id: suggestion.session_id, via: key === 'main' ? 'main_session' : (alignedKeys.has(key) ? 'memory_doc_aligned' : 'explicit_approval') });
    } else {
      pending.push({ module_key: key, session_id: suggestion.session_id, reason: 'not_approved (使用 --modules <key> 批准持久化)' });
    }
  }
  return { approved, pending, alignedKeys, allow, exclude };
}

/** 脚手架: 记忆文档缺失时生成最小模板 (已存在则绝不覆盖) */
function scaffoldMemoryDoc(wsRoot, relativePath, topicName) {
  const abs = path.join(wsRoot, relativePath);
  if (fs.existsSync(abs)) {
    return false;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const template = [
    `# [${topicName}] 受控记忆`,
    '',
    '## 架构已知事实',
    '',
    '## 设计决策',
    '',
    '## 排障经验',
    ''
  ].join('\n');
  fs.writeFileSync(abs, template, 'utf8');
  return true;
}

function initTaskLoop(options = {}) {
  const wsRoot = options.wsRoot || process.cwd();
  const dryRun = options.dryRun || false;
  const createMissing = Object.prototype.hasOwnProperty.call(options, 'createMissing')
    ? Boolean(options.createMissing)
    : true;
  const targetVendor = stateStore.normalizeVendor(options.vendor) || detectCurrentVendor(options.env, options.currentSession || options.currentSessionId) || 'antigravity';
  options.vendor = targetVendor;

  const taskLoopDir = path.join(wsRoot, '.agents', 'task-loop');
  const sessionsPath = path.join(taskLoopDir, 'sessions.json');
  const topicsPath = path.join(taskLoopDir, 'topics.json');
  const todoPath = path.join(taskLoopDir, 'todo.json');
  const policyPath = path.join(taskLoopDir, 'policy.json');

  const { suggestions, memoryDocs, memoryAlignment, assignments, chosenMainId, callerSessionId, currentVendor, existingModules } = surveyExistingSessions(wsRoot, options);

  const vendorSpecificFile = path.join(taskLoopDir, `sessions.${targetVendor}.json`);

  const result = {
    workspace_root: normalizePath(wsRoot),
    storage_directory: normalizePath(taskLoopDir),
    storage_files: {
      sessions_json: normalizePath(sessionsPath),
      sessions_vendor_json: normalizePath(vendorSpecificFile),
      topics_json: normalizePath(topicsPath),
      todo_json: normalizePath(todoPath),
      policy_json: normalizePath(policyPath)
    },
    discovered_sessions_count: suggestions.length,
    existing_memory_docs_count: memoryDocs.length,
    chosen_main_session_id: chosenMainId,
    caller_session_id: callerSessionId,
    current_vendor: targetVendor,
    memory_alignment: memoryAlignment,
    topic_mapping_suggestions: suggestions,
    created_sessions: [],
    pending_creation: [],
    creation_failures: [],
    unsupported: []
  };

  // 批准门禁 (dry-run 也计算, 便于预览 pending_approval)
  const gate = applyApprovalGate(assignments, memoryAlignment, {
    moduleAllowlist: options.moduleAllowlist || [],
    moduleExclude: options.moduleExclude || []
  });
  result.approved_modules = gate.approved;
  result.pending_approval = gate.pending;

  if (dryRun) {
    return result;
  }

  // 实际写入
  os_mkdir_p(taskLoopDir);

  // 1. /init 默认主动补齐；未获得正式 ID 的结果只记录 PENDING，不进入绑定。
  if (createMissing) {
    for (const align of memoryAlignment) {
      const stored = existingModules[align.module_key];
      const reusable = ['BOUND', 'DISCOVERED', 'ALIGNED', 'CREATED_AND_ALIGNED'].includes(align.status)
        && align.resumable === true
        && (!stored || isReusableSession(targetVendor, stored));
      if (!reusable) {
        const title = align.matched_topic_name;
        const prompt = `[${align.module_key}专题初始化] 你是 task-loop 项目的【${align.module_key}专题负责人】。你负责维护本专题代码与记忆文档 ${align.memory_doc}。`;
        const existingModel = targetVendor === 'codex'
          ? codexModelPolicy.configuredModel(existingModules && existingModules[align.module_key])
          : null;
        const creation = spawnRootConversation(title, prompt, wsRoot, {
          ...options,
          vendor: targetVendor,
          role: align.module_key === 'main' ? 'main' : 'topic',
          ...(existingModel ? {
            model: options.model || existingModel.model,
            reasoning_effort: options.reasoning_effort || existingModel.reasoning_effort,
            thinking: options.thinking || existingModel.thinking
          } : {})
        });
        if (creation && creation.status === 'CREATED' && creation.id) {
          align.matched_session_id = creation.id;
          align.matched_vendor = creation.vendor;
          align.resumable = creation.resumable === true;
          align.status = 'CREATED_AND_ALIGNED';
          result.created_sessions.push({ module_key: align.module_key, session_id: creation.id, vendor: creation.vendor, title });
          suggestions.push({
            session_id: creation.id,
            vendor: creation.vendor,
            id_kind: creation.id_kind,
            original_title: sanitizeTitle(title),
            suggested_module_key: align.module_key,
            suggested_topic_name: title,
            suggested_tags: [align.module_key, 'topic'],
            suggested_memory_doc: align.memory_doc,
            resumable: creation.resumable === true,
            physical_session: true,
            lifecycle_status: stateStore.SESSION_STATUS.BOUND,
            dispatch_hint: '可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)',
            is_main_candidate: false,
            is_current_session: false
          });
        } else if (creation && creation.status === 'PENDING_CREATION') {
          align.status = stateStore.SESSION_STATUS.PENDING_CREATION;
          result.pending_creation.push({ module_key: align.module_key, vendor: targetVendor, title, creation_request: creation.creation_request || creation.request, host_action: creation.host_action || 'create_thread', reason: creation.reason });
        } else if (creation && creation.status === 'UNSUPPORTED') {
          align.status = stateStore.SESSION_STATUS.UNSUPPORTED;
          result.unsupported.push({ module_key: align.module_key, vendor: targetVendor, title, reason: creation.reason });
        } else {
          align.status = stateStore.SESSION_STATUS.CREATION_FAILED;
          result.creation_failures.push({ module_key: align.module_key, vendor: targetVendor, title, reason: creation && creation.reason || 'creation adapter returned no result' });
        }
      }
    }
    // 新建会话后重算分配, 保证与落盘同源
    const refreshed = resolveModuleAssignments(suggestions, memoryDocs, existingModules, targetVendor);
    assignments.clear();
    for (const [k, v] of refreshed.entries()) assignments.set(k, v);
  }

  // 2. 构建当前厂商的数据 (仅持久化通过批准门禁的模块; 其余会话仅入清单不占绑定)
  let mainThreadId = (suggestions.find(s => s.session_id === chosenMainId && s.vendor === targetVendor) || {}).session_id || null;
  if (!mainThreadId && existingModules && isReusableSession(targetVendor, existingModules.main)) {
    mainThreadId = existingModules.main.session_id || null;
  }
  const approvedKeys = new Set(gate.approved.map(a => a.module_key));
  for (const align of memoryAlignment) {
    if (align.status === 'CREATED_AND_ALIGNED') approvedKeys.add(align.module_key);
  }

  const targetModules = {};
  // 粘性绑定保护: 当前厂商分区中已有的可续接绑定优先保留, 扫描重匹配不得覆盖 (防 re-init 污染)
  try {
    const existingDoc = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const existingPart = existingDoc && existingDoc.vendors && existingDoc.vendors[targetVendor];
    if (existingPart && typeof existingPart.modules === 'object') {
      for (const [key, mod] of Object.entries(existingPart.modules)) {
        const modVendor = stateStore.normalizeVendor(mod && mod.vendor) || targetVendor;
        if (mod && modVendor === targetVendor && isReusableSession(targetVendor, mod) && !targetModules[key]) {
          targetModules[key] = {
            ...mod,
            vendor: targetVendor,
            physical_session: true,
            lifecycle_status: mod.lifecycle_status || stateStore.SESSION_STATUS.BOUND,
            is_main: key === 'main' || mod.session_id === mainThreadId
          };
        }
      }
    }
  } catch {}
  for (const [key, item] of assignments.entries()) {
    if (approvedKeys.has(key) && item.vendor === targetVendor && item.session_id && item.resumable === true && !targetModules[key]) {
      targetModules[key] = {
        session_id: item.session_id,
        title: item.suggested_topic_name,
        tags: item.suggested_tags,
        memory_doc: item.suggested_memory_doc,
        vendor: item.vendor,
        id_kind: item.id_kind,
        resumable: true,
        physical_session: true,
        lifecycle_status: stateStore.SESSION_STATUS.BOUND,
        is_main: key === 'main' || item.session_id === mainThreadId,
        dispatch_hint: item.dispatch_hint,
        summary: `专题模块: ${item.suggested_topic_name}`
      };
    }
  }

  // Codex-only defaults are initialized once; existing per-session choices remain sticky.
  if (targetVendor === 'codex') {
    for (const [key, mod] of Object.entries(targetModules)) {
      targetModules[key] = codexModelPolicy.applyInitialModelConfig(
        { ...mod, vendor: mod.vendor || targetVendor, module_key: key, is_main: key === 'main' },
        key === 'main' ? 'main' : (key === 'subagent' ? 'subagent' : (mod.role || 'topic'))
      );
    }
  }

  // sessions 列表严格仅由 targetModules 1:1 转换得到，彻底杜绝历史临时/瞬态子代理会话的污染与重复
  const targetSessionsList = Object.entries(targetModules).map(([key, mod]) => ({
    session_id: mod.session_id,
    vendor: mod.vendor || targetVendor,
    title: mod.title,
    is_main: (key === 'main' || mod.session_id === mainThreadId),
    module_key: key,
    id_kind: mod.id_kind,
    resumable: mod.resumable === true && Boolean(mod.session_id),
    physical_session: Boolean(mod.session_id),
    lifecycle_status: mod.lifecycle_status || (mod.resumable === true ? stateStore.SESSION_STATUS.BOUND : stateStore.SESSION_STATUS.PENDING_CREATION),
    summary: mod.summary || `专题模块: ${mod.title}`,
    memory_docs: mod.memory_doc ? [mod.memory_doc] : [],
    ...(targetVendor === 'codex' && mod.model_config ? { model_config: mod.model_config } : {})
  }));

  const targetVendorData = {
    schema_version: 3,
    vendor: targetVendor,
    main_thread_id: mainThreadId,
    updated_at: new Date().toISOString(),
    modules: targetModules,
    sessions: targetSessionsList
  };

  // 3. 多厂商分区持久化与历史数据保护 (Schema v3 Namespaced Persistence)
  const vendors = {};
  let existingSessionsData = null;
  if (fs.existsSync(sessionsPath)) {
    try {
      existingSessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    } catch {}
  }

  if (existingSessionsData && existingSessionsData.vendors && typeof existingSessionsData.vendors === 'object') {
    for (const [vKey, vData] of Object.entries(existingSessionsData.vendors)) {
      vendors[vKey] = vData;
    }
  } else if (existingSessionsData && existingSessionsData.modules) {
    const oldVendor = existingSessionsData.current_vendor || 'antigravity';
    vendors[oldVendor] = {
      schema_version: 3,
      vendor: oldVendor,
      main_thread_id: existingSessionsData.main_thread_id || null,
      updated_at: existingSessionsData.updated_at || new Date().toISOString(),
      modules: existingSessionsData.modules || {},
      sessions: existingSessionsData.sessions || []
    };
  }

  // 检查磁盘既有独立物理文件
  const knownVendors = ['antigravity', 'zcode', 'codex', 'claude'];
  for (const v of knownVendors) {
    const vPath = path.join(taskLoopDir, `sessions.${v}.json`);
    if (!vendors[v] && fs.existsSync(vPath)) {
      try {
        vendors[v] = JSON.parse(fs.readFileSync(vPath, 'utf8'));
      } catch {}
    }
  }

  // 更新当前厂商分区
  vendors[targetVendor] = targetVendorData;

  // 写入当前厂商独立物理文件
  fs.writeFileSync(vendorSpecificFile, JSON.stringify(targetVendorData, null, 2), 'utf8');

  // 只写当前厂商镜像；其他厂商物理文件保持零写入，避免跨厂商污染。

  // 写入全量主 sessions.json (Schema v4: 顶层仅元数据 + vendors 厂商分区, 顶层冗余副本已废除以杜绝跨厂商覆写)
  const masterSessionsData = {
    schema_version: 4,
    updated_at: new Date().toISOString(),
    vendors: vendors
  };

  fs.writeFileSync(sessionsPath, JSON.stringify(masterSessionsData, null, 2), 'utf8');

  // 4. topics.json (Schema v4: 同样厂商顶层分区, 各厂商 topics 隔离, 动态扩展, 严禁互踩)
  const existingTopicsData = fs.existsSync(topicsPath) ? (() => {
    try { return JSON.parse(fs.readFileSync(topicsPath, 'utf8')); } catch { return null; }
  })() : null;
  const topicsVendors = {};
  if (existingTopicsData && existingTopicsData.vendors && typeof existingTopicsData.vendors === 'object') {
    for (const [vKey, vData] of Object.entries(existingTopicsData.vendors)) {
      topicsVendors[vKey] = vData;
    }
  } else if (existingTopicsData && Array.isArray(existingTopicsData.topics)) {
    const legacyVendor = existingTopicsData.current_vendor || targetVendor;
    topicsVendors[legacyVendor] = { vendor: legacyVendor, updated_at: existingTopicsData.updated_at || null, topics: existingTopicsData.topics };
  }

  const targetTopics = {
    vendor: targetVendor,
    updated_at: new Date().toISOString(),
    topics: Object.entries(targetModules).map(([k, v]) => ({
      topic_key: k,
      name: v.title,
      session_id: v.session_id,
      vendor: v.vendor,
      resumable: v.resumable,
      lifecycle_status: v.lifecycle_status,
      is_main: v.is_main === true,
      id_kind: v.id_kind,
      tags: v.tags,
      memory_doc: v.memory_doc
    }))
  };
  topicsVendors[targetVendor] = targetTopics;

  // 目标厂商物理镜像 topics.<vendor>.json
  fs.writeFileSync(path.join(taskLoopDir, `topics.${targetVendor}.json`), JSON.stringify(Object.assign({ schema_version: 3 }, targetTopics), null, 2), 'utf8');

  const topicsFileData = {
    schema_version: 4,
    updated_at: new Date().toISOString(),
    vendors: topicsVendors
  };
  fs.writeFileSync(topicsPath, JSON.stringify(topicsFileData, null, 2), 'utf8');

  // 5. todo.json
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(todoPath, JSON.stringify({ schema_version: 3, items: [] }, null, 2), 'utf8');
  }

  // 6. policy.json
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(policyPath, JSON.stringify({
      schema_version: 3,
      active_vendor: targetVendor,
      default_lease_timeout_sec: 1800,
      enable_file_state_machine: false
    }, null, 2), 'utf8');
  }

  // 7. 主会话记忆文档脚手架 (存在则不覆盖)
  if (mainThreadId) {
    result.scaffolded_memory_docs = [];
    const mainDoc = 'docs/MEMORY.md';
    if (scaffoldMemoryDoc(wsRoot, mainDoc, '[主会话] 任务编排 & 治理中枢')) {
      result.scaffolded_memory_docs.push(mainDoc);
    }
  }

  // 8. 会话工具优先指引 (核心思想: 基于会话 SDK 的长期会话编排)
  result.session_tools = {
    philosophy: 'task-loop 以会话为一等公民: 主会话的角色是需求加工与派单, 实施必须派发至专题会话/子代理',
    dispatch_order: [
      `1. 查 .agents/task-loop/sessions.${targetVendor}.json (或 sessions.json vendors.${targetVendor}) 寻找匹配专题, 优先复用`,
      '2. 可续接专题 (resumable: true): 经当前宿主 SessionProvider send/resume 原语定向派单',
      '3. 不可续接专题 (resumable: false): 仅只读内省参考; 需要实施时经 new-session 重建本宿主原生专题',
      '4. 无匹配专题: /init 经 new-session / spawn Provider 主动拉起; Codex 无原生工具时保留 PENDING_CREATION 请求, 取得 formal threadId 后再 bind'
    ],
    vendor_mapping_doc: 'references/sdk/README.md'
  };

  return result;
}

function os_mkdir_p(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const createMissing = !dryRun;
  const wsIndex = args.indexOf('--workspace');
  const wsRoot = (wsIndex !== -1 && args[wsIndex + 1]) ? args[wsIndex + 1] : process.cwd();

  let vendor = null;
  const vendorIdx = args.indexOf('--vendor');
  if (vendorIdx !== -1 && args[vendorIdx + 1]) {
    vendor = args[vendorIdx + 1].toLowerCase();
  }

  let currentSessionId = null;
  const currIdx = args.indexOf('--current-session');
  if (currIdx !== -1 && args[currIdx + 1]) {
    currentSessionId = args[currIdx + 1];
  }

  let mainSessionId = null;
  const mainIdx = args.indexOf('--main-session');
  if (mainIdx !== -1 && args[mainIdx + 1]) {
    mainSessionId = args[mainIdx + 1];
  }

  const parseList = (flag) => {
    const idx = args.indexOf(flag);
    if (idx === -1 || !args[idx + 1]) return [];
    return args[idx + 1].split(',').map(s => s.trim()).filter(Boolean);
  };
  const moduleAllowlist = parseList('--modules');
  const moduleExclude = parseList('--exclude');

  const res = initTaskLoop({ wsRoot, dryRun, createMissing, vendor, currentSessionId, mainSessionId, moduleAllowlist, moduleExclude });

  console.log('================================================================================');
  console.log(' [task-loop] 项目初始化与已有会话调查 (带记忆文档 1:1 自动映射)');
  console.log('================================================================================');
  console.log(`工作区根路径: ${res.workspace_root}`);
  console.log(`状态机存储目录: ${res.storage_directory}`);
  console.log(`核心配置文件: ${res.storage_files.sessions_json}`);
  console.log(`已发现已有历史会话数量: ${res.discovered_sessions_count}`);
  console.log(`现有受控记忆文档数量: ${res.existing_memory_docs_count}`);
  if (res.chosen_main_session_id) {
    console.log(`选定主会话 ID: ${res.chosen_main_session_id}`);
  }
  console.log('--------------------------------------------------------------------------------');
  console.log('受控记忆文档 1:1 专题会话匹配状态 (Memory Docs 1:1 Alignment):');
  
  res.memory_alignment.forEach((m, idx) => {
    const statusTag = m.status === 'ALIGNED' ? '[✔ 已匹配]' : (m.status === 'CREATED_AND_ALIGNED' ? '[✔ 已自动创建顶层会话并绑定]' : '[⚠ 本次主动补齐中/等待 formal ID]');
    const resumeTag = m.matched_session_id ? (m.resumable ? ' [可续接]' : ' [只读遗留]') : '';
    console.log(`\n[M${idx + 1}] 记忆文档: ${m.memory_doc}`);
    console.log(`     模块 Key: ${m.module_key}`);
    console.log(`     专题名称: ${m.matched_topic_name}`);
    console.log(`     绑定会话: ${m.matched_session_id || '(未绑定)'} ${statusTag}${resumeTag}`);
  });

  if (res.created_sessions && res.created_sessions.length > 0) {
    console.log('\n--------------------------------------------------------------------------------');
    console.log('【已自动创建的新独立顶层根会话 (nestingDepth = 0)】:');
    res.created_sessions.forEach((cs, i) => {
      console.log(`  ${i + 1}. [${cs.module_key}] ${cs.title} -> ${cs.session_id}`);
    });
  }

  if (res.pending_creation && res.pending_creation.length > 0) {
    console.log('\n--------------------------------------------------------------------------------');
    console.log('【待原生宿主创建 (PENDING_CREATION)】:');
    res.pending_creation.forEach((pending, i) => {
      console.log(`  ${i + 1}. [${pending.module_key}] ${pending.title} -> ${pending.host_action || 'create_thread'}`);
      console.log(`     creation_request: ${JSON.stringify(pending.creation_request || {})}`);
      console.log(`     reason: ${pending.reason || 'formal threadId 尚未返回'}`);
    });
  }

  console.log('\n--------------------------------------------------------------------------------');
  console.log('建议专题映射全量清单 (All Topic Mapping Recommendations):');
  
  res.topic_mapping_suggestions.forEach((s, idx) => {
    console.log(`\n[${idx + 1}] 会话 ID: ${s.session_id}`);
    console.log(`    原标题: ${s.original_title} (${s.vendor})`);
    console.log(`    建议专题名: ${s.suggested_topic_name}`);
    console.log(`    建议模块Key: ${s.suggested_module_key}${s.needs_naming ? ' [需人工命名]' : ''}`);
    console.log(`    可续接: ${s.resumable ? '是' : '否 (只读遗留)'}`);
    console.log(`    派单提示: ${s.dispatch_hint}`);
    console.log(`    关联受控记忆: ${s.suggested_memory_doc}`);
    if (s.is_current_session && s.is_main_candidate) {
      console.log(`    [Current Session & Main Candidate] 当前发起会话 (推荐为主治理中枢)`);
    } else if (s.is_main_candidate) {
      console.log(`    [Main Candidate] 候选为主会话 (Main Thread)`);
    } else if (s.is_current_session) {
      console.log(`    [Current Session] 当前发起会话`);
    }
  });

  if (res.pending_approval && res.pending_approval.length > 0) {
    console.log('\n--------------------------------------------------------------------------------');
    console.log('【待批准模块 (pending_approval)】以下建议默认不落盘, 确需持久化请追加: --modules <key1,key2>');
    res.pending_approval.forEach((p, i) => {
      console.log(`  ${i + 1}. [${p.module_key}] ${p.session_id} (${p.reason})`);
    });
  }

  if (res.session_tools) {
    console.log('\n--------------------------------------------------------------------------------');
    console.log('【会话工具优先指引 (Session-First)】');
    res.session_tools.dispatch_order.forEach(line => console.log(`  ${line}`));
    console.log(`  厂商原语映射: ${res.session_tools.vendor_mapping_doc}`);
  }

  console.log('\n================================================================================');
  if (dryRun) {
    console.log('【预览模式 (Dry-Run)】未实际写入文件。');
    console.log('预览不执行创建；正式运行 node scripts/init_task_loop.js 将主动补齐，Codex 缺少原生工具时返回 PENDING_CREATION 请求。');
  } else {
    console.log('【初始化完成】已将配置保存至:');
    console.log(`  - sessions.json: ${res.storage_files.sessions_json}`);
    console.log(`  - topics.json:   ${res.storage_files.topics_json}`);
    console.log('\n【用户兜底修改提示】:');
    console.log(`若上述专题划分、命名或 ID 需要调整，您随时可以直接打开并手动编辑:`);
    console.log(`  >> ${res.storage_files.sessions_json}`);
    console.log(`插件与 Hook 均实时读取该文件，改动即刻生效！`);
  }
  console.log('================================================================================\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  surveyExistingSessions,
  inferTopicMapping,
  initTaskLoop,
  resolveModuleAssignments,
  applyApprovalGate,
  sanitizeTitle,
  isValidModuleKey,
  detectCurrentVendor,
  loadProviderRegistry
};
