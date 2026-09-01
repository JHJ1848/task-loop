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
  if (env.ZCODE_SESSION_ID || env.CLAUDE_SESSION_ID) return 'zcode';
  // 会话 ID 形状硬特征: sess_ 前缀为 ZCode 会话规范, 优先级高于其他宿主残留环境变量
  if (currentSessionId && /^sess_/i.test(currentSessionId)) return 'zcode';
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.ANTIGRAVITY_CONVERSATION_ID) return 'antigravity';
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

const { spawnSync } = require('child_process');

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

/**
 * 创建独立顶层根会话 (nestingDepth = 0)
 * 净化父级上下文环境变量，确保独立展示于 IDE 左侧边栏
 */
function spawnRootConversation(title, prompt, wsRoot) {
  const env = { ...process.env };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.ANTIGRAVITY_SOURCE_METADATA;
  delete env.ANTIGRAVITY_TRAJECTORY_ID;

  try {
    const res = spawnSync('agentapi.bat', ['new-conversation', `--title=${title}`, prompt], {
      env,
      cwd: wsRoot,
      shell: true,
      encoding: 'utf8'
    });

    if (res.stdout) {
      const data = JSON.parse(res.stdout);
      return data?.response?.newConversation?.conversationId || null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * 单一事实源: 严格以 docs/memory/*.md 中的法定模块为准进行 1:1 对齐匹配。
 * 预览报告与真实落盘必须共用本函数的计算结果。
 */
function resolveModuleAssignments(suggestions, memoryDocs) {
  const assignments = new Map(); // module_key -> suggestion (1:1 绑定)

  // 1. 先匹配 main
  const mainCand = suggestions.find(s => s.is_main_candidate) || suggestions.find(s => s.suggested_module_key === 'main');
  if (mainCand) {
    assignments.set('main', mainCand);
  }

  // 2. 为每个受控记忆文档匹配首个最合适的建议项
  for (const doc of (memoryDocs || [])) {
    if (doc.module_key === 'main') continue;
    const matched = suggestions.find(s => s.suggested_module_key === doc.module_key);
    if (matched) {
      assignments.set(doc.module_key, matched);
    }
  }

  return assignments;
}

function surveyExistingSessions(wsRoot, options = {}) {
  const callerSessionId = options.currentSession || options.currentSessionId || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  const currentVendor = options.vendor || detectCurrentVendor(options.env || process.env, callerSessionId) || null;
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
    if (!uniqueMap.has(s.session_id)) {
      uniqueMap.set(s.session_id, s);
    }
  }

  // 若 callerSessionId 存在但在扫描中未发现，自动补入
  if (callerSessionId && !uniqueMap.has(callerSessionId)) {
    uniqueMap.set(callerSessionId, {
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
  if (explicitMainSessionId) {
    chosenMainId = explicitMainSessionId;
    if (!uniqueMap.has(explicitMainSessionId)) {
      uniqueMap.set(explicitMainSessionId, {
        session_id: explicitMainSessionId,
        vendor: currentVendor || 'antigravity',
        title: '[主会话] 任务编排 & 治理中枢',
        is_main: true,
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString()
      });
    }
  } else if (callerSessionId && uniqueMap.has(callerSessionId)) {
    chosenMainId = callerSessionId;
  } else if (callerSessionId) {
    // callerSessionId 必定作为主会话
    chosenMainId = callerSessionId;
    uniqueMap.set(callerSessionId, {
      session_id: callerSessionId,
      vendor: currentVendor || 'antigravity',
      title: '[主会话] 任务编排 & 治理中枢',
      is_main: true,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString()
    });
  } else {
    for (const s of uniqueMap.values()) {
      const rawTitle = (s.title || '').toLowerCase();
      const sVendor = (s.vendor || 'antigravity').toLowerCase();
      if ((s.is_main || rawTitle.includes('[主会话]') || rawTitle.includes('治理中枢')) && (sVendor === currentVendor)) {
        chosenMainId = s.session_id;
        break;
      }
    }
    if (!chosenMainId) {
      for (const s of uniqueMap.values()) {
        const rawTitle = (s.title || '').toLowerCase();
        if (s.is_main || rawTitle.includes('[主会话]') || rawTitle.includes('治理中枢')) {
          chosenMainId = s.session_id;
          break;
        }
      }
    }
    if (!chosenMainId && uniqueMap.size > 0) {
      chosenMainId = uniqueMap.keys().next().value;
    }
  }

  const list = Array.from(uniqueMap.values());
  const suggestions = list.map(s => {
    const isMainCandidate = (s.session_id === chosenMainId);
    const isCurrentSession = (s.session_id === callerSessionId);

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

    return {
      session_id: s.session_id,
      vendor: s.vendor || 'antigravity',
      original_title: s.original_title || sanitizeTitle(s.title),
      suggested_module_key: inferred.module_key,
      needs_naming: Boolean(inferred.needs_naming),
      suggested_topic_name: inferred.topic_name,
      suggested_tags: inferred.tags,
      suggested_memory_doc: inferred.memory_doc,
      resumable: (s.vendor || 'antigravity') === currentVendor,
      dispatch_hint: (s.vendor || 'antigravity') === currentVendor
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

  // 单一事实源: 一次性计算模块分配, 对齐报告与持久化共用
  const assignments = resolveModuleAssignments(suggestions, memoryDocs);

  // 扫描受控记忆文档并进行 1:1 对齐 (对齐结果同样取自 assignments, 与落盘同源)
  const memoryAlignment = memoryDocs.map(doc => {
    const matchedSession = assignments.get(doc.module_key) || null;
    return {
      module_key: doc.module_key,
      memory_doc: doc.relative_path,
      matched_session_id: matchedSession ? matchedSession.session_id : null,
      matched_vendor: matchedSession ? matchedSession.vendor : null,
      resumable: matchedSession ? matchedSession.resumable : false,
      matched_topic_name: matchedSession ? matchedSession.suggested_topic_name : `[${doc.module_key}专题] 核心功能维护 & 记忆沉淀`,
      status: matchedSession ? 'ALIGNED' : 'MISSING_SESSION'
    };
  });

  return { suggestions, memoryDocs, memoryAlignment, assignments, chosenMainId, callerSessionId, currentVendor };
}

/**
 * 批准门禁 (纯函数): 决定哪些模块建议允许持久化。
 * 默认仅 main + 记忆文档已对齐模块; 其余进入 pending_approval, 需经
 * --modules <a,b,c> 显式批准或 --exclude 显式排除。
 */
function applyApprovalGate(assignments, memoryAlignment, options = {}) {
  const allow = new Set((options.moduleAllowlist || []).filter(Boolean));
  const exclude = new Set((options.moduleExclude || []).filter(Boolean));
  const alignedKeys = new Set(memoryAlignment.filter(a => a.status === 'ALIGNED' || a.status === 'CREATED_AND_ALIGNED').map(a => a.module_key));

  const approved = [];
  const pending = [];
  for (const [key, suggestion] of assignments.entries()) {
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
  const createMissing = options.createMissing || false;
  const targetVendor = options.vendor || detectCurrentVendor(options.env, options.currentSession || options.currentSessionId) || 'antigravity';
  options.vendor = targetVendor;

  const taskLoopDir = path.join(wsRoot, '.agents', 'task-loop');
  const sessionsPath = path.join(taskLoopDir, 'sessions.json');
  const topicsPath = path.join(taskLoopDir, 'topics.json');
  const todoPath = path.join(taskLoopDir, 'todo.json');
  const policyPath = path.join(taskLoopDir, 'policy.json');

  const { suggestions, memoryDocs, memoryAlignment, assignments, chosenMainId, callerSessionId, currentVendor } = surveyExistingSessions(wsRoot, options);

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
    created_sessions: []
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

  // 1. 若开启了 createMissing，对缺失会话的记忆文档 1:1 自动拉起独立根会话 (仅在 Antigravity 宿主下有效)
  if (createMissing && targetVendor === 'antigravity') {
    for (const align of memoryAlignment) {
      if (align.status === 'MISSING_SESSION') {
        const title = align.matched_topic_name;
        const prompt = `[${align.module_key}专题初始化] 你是 task-loop 项目的【${align.module_key}专题负责人】。你负责维护本专题代码与记忆文档 ${align.memory_doc}。`;
        const newId = spawnRootConversation(title, prompt, wsRoot);
        if (newId) {
          align.matched_session_id = newId;
          align.status = 'CREATED_AND_ALIGNED';
          result.created_sessions.push({ module_key: align.module_key, session_id: newId, title });
          suggestions.push({
            session_id: newId,
            vendor: targetVendor,
            original_title: sanitizeTitle(title),
            suggested_module_key: align.module_key,
            suggested_topic_name: title,
            suggested_tags: [align.module_key, 'topic'],
            suggested_memory_doc: align.memory_doc,
            resumable: true,
            dispatch_hint: '可续接: 经当前宿主会话 SDK send/resume 原语定向派单 (各厂商映射见 references/sdk/README.md)',
            is_main_candidate: false,
            is_current_session: false
          });
        }
      }
    }
    // 新建会话后重算分配, 保证与落盘同源
    const refreshed = resolveModuleAssignments(suggestions);
    assignments.clear();
    for (const [k, v] of refreshed.entries()) assignments.set(k, v);
  }

  // 2. 构建当前厂商的数据 (仅持久化通过批准门禁的模块; 其余会话仅入清单不占绑定)
  const mainThreadId = chosenMainId || (suggestions[0] ? suggestions[0].session_id : null);
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
        if (mod && mod.session_id && mod.resumable !== false && !targetModules[key]) {
          targetModules[key] = mod;
        }
      }
    }
  } catch {}
  for (const [key, item] of assignments.entries()) {
    if (approvedKeys.has(key) && item.vendor === targetVendor && !targetModules[key]) {
      targetModules[key] = {
        session_id: item.session_id,
        title: item.suggested_topic_name,
        tags: item.suggested_tags,
        memory_doc: item.suggested_memory_doc,
        vendor: item.vendor,
        resumable: true,
        dispatch_hint: item.dispatch_hint,
        summary: `专题模块: ${item.suggested_topic_name}`
      };
    }
  }

  // sessions 列表严格仅由 targetModules 1:1 转换得到，彻底杜绝历史临时/瞬态子代理会话的污染与重复
  const targetSessionsList = Object.entries(targetModules).map(([key, mod]) => ({
    session_id: mod.session_id,
    vendor: mod.vendor,
    title: mod.title,
    is_main: (key === 'main' || mod.session_id === mainThreadId),
    module_key: key,
    resumable: true,
    summary: mod.summary || `专题模块: ${mod.title}`,
    memory_docs: mod.memory_doc ? [mod.memory_doc] : []
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

  // 若其他已知厂商在 vendors 中有数据，也确保其物理文件同步更新/落盘
  for (const [vKey, vData] of Object.entries(vendors)) {
    const vFile = path.join(taskLoopDir, `sessions.${vKey}.json`);
    if (!fs.existsSync(vFile) || vKey === targetVendor) {
      try {
        fs.writeFileSync(vFile, JSON.stringify(vData, null, 2), 'utf8');
      } catch {}
    }
  }

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
      tags: v.tags,
      memory_doc: v.memory_doc
    }))
  };
  topicsVendors[targetVendor] = targetTopics;

  // 目标厂商物理镜像 topics.<vendor>.json
  fs.writeFileSync(path.join(taskLoopDir, `topics.${targetVendor}.json`), JSON.stringify(Object.assign({ schema_version: 4 }, targetTopics), null, 2), 'utf8');

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
      '4. 无匹配专题: 经 new-session / spawn Provider 拉起新顶层会话后登记, 严禁退化为人肉 UI 操作'
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
  const createMissing = args.includes('--create-missing') || args.includes('-c');
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
    const statusTag = m.status === 'ALIGNED' ? '[✔ 已匹配]' : (m.status === 'CREATED_AND_ALIGNED' ? '[✔ 已自动创建顶层会话并绑定]' : '[⚠ 缺失会话: 可使用 --create-missing 自动补齐]');
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
    console.log('若需补齐缺失记忆文档对应的顶层会话并落盘，执行: node scripts/init_task_loop.js --create-missing');
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
