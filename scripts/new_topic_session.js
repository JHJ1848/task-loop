#!/usr/bin/env node
/**
 * new_topic_session.js - 创建与初始化专题会话
 *
 * 核心能力：
 * 1. 手动指定某个专题记忆文档 (docs/memory/*.md)，主动读取其内容并建立独立顶层根会话 (nestingDepth: 0)；
 * 2. 若未指定，自动扫描 docs/memory/*.md 找出所有未建立专题会话的受控记忆，批量补齐初始化；
 * 3. 自动原子回写 .agents/task-loop/sessions.json 与 topics.json。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const zcodeSpawn = require('./providers/spawn_zcode_session');
const stateStore = require('./task_loop_state');

function normalizePath(p) {
  return p ? p.replace(/\\/g, '/') : '';
}

/**
 * 解析受控记忆文档，提炼专题元数据与初始化 Prompt
 */
function parseMemoryDoc(docPath, wsRoot) {
  const fullPath = path.isAbsolute(docPath) ? docPath : path.join(wsRoot, docPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`记忆文档不存在: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const baseName = path.basename(fullPath, '.md');
  const relPath = normalizePath(path.relative(wsRoot, fullPath));

  // 1. 提炼专题名称与分类
  let title = '';
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].replace(/\[.*?受控记忆.*?\]/g, '').replace(/[#\*`]/g, '').trim();
  }
  if (!title) {
    title = `${baseName}专题`;
  }

  // 规范化标题格式: [专题名] 功能1 & 功能2
  let standardizedTitle = title;
  if (!/^\[.+\]\s+.+\s+&\s+.+$/.test(title)) {
    standardizedTitle = `[${baseName}专题] 核心功能维护 & 记忆沉淀`;
  }

  // 2. 提炼物理白名单与架构事实
  let allowlist = '';
  const allowlistMatch = content.match(/(?:物理白名单|白名单范围|物理范围)[*:\s]+([^\n\r]+)/i);
  if (allowlistMatch) {
    allowlist = allowlistMatch[1].trim();
  }

  // 3. 构建首条初始化 Prompt
  const initialPrompt = [
    `[${baseName}专题初始化] 你是 task-loop 项目的【${baseName}专题负责人】。`,
    `你负责维护本专题专属代码域与受控记忆文档 \`${relPath}\`。`,
    allowlist ? `【物理白名单范围】: ${allowlist}` : '',
    `【工作流规范】: 遵循专题会话标准工作流（边界锁定 -> 白名单精准实施 -> 本地自测 -> 记忆回写 -> 结构化交付）。`
  ].filter(Boolean).join('\n');

  return {
    module_key: baseName,
    memory_doc: relPath,
    title: standardizedTitle,
    initialPrompt,
    allowlist
  };
}

/**
 * 创建独立顶层根会话 (nestingDepth = 0) — 厂商感知双宿主实现
 *   AGY 宿主  : agentapi new-conversation (原行为保留)
 *   ZCode 宿主: zcode --cwd <wsRoot> -p "<prompt>" 无头拉起 (scripts/providers/spawn_zcode_session)
 * 彻底净化父级上下文环境变量；返回 { id, vendor } 或 null。
 */
function spawnRootConversation(title, prompt, wsRoot) {
  const env = { ...process.env };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.ANTIGRAVITY_SOURCE_METADATA;
  delete env.ANTIGRAVITY_TRAJECTORY_ID;

  // 1. AGY 宿主: agentapi 可用则优先（原行为）
  const agentapi = findAgentApiBinary(env);
  if (agentapi) {
    const exe = process.platform === 'win32' ? agentapi : agentapi;
    try {
      const res = spawnSync(exe, ['new-conversation', `--title=${title}`, prompt], {
        env,
        cwd: wsRoot,
        shell: true,
        encoding: 'utf8'
      });
      if (res.stdout) {
        const data = JSON.parse(res.stdout);
        const id = data?.response?.newConversation?.conversationId || null;
        if (id) return { id: id, vendor: 'antigravity' };
      }
    } catch (e) {
      // fall through to ZCode CLI
    }
  }

  // 2. ZCode 宿主: 无头 CLI 拉起
  const zcodeCli = zcodeSpawn.discoverZcodeCli(env);
  if (zcodeCli) {
    const auth = zcodeSpawn.authState(env);
    if (!auth.logged_in) {
      console.error(
        '[new-topic-session] ZCode CLI 未登录，跳过无头拉起。前置: login-api-key 配置 key 或 zcode login 一次；' +
        '或手动新建会话后将 ID 登记至 .agents/task-loop/sessions.json。'
      );
      return null;
    }
    try {
      const out = zcodeSpawn.runCli(zcodeCli, ['--cwd', wsRoot, '-p', prompt], 600, env);
      const id = zcodeSpawn.extractSessionId(out);
      if (id) return { id: id, vendor: 'zcode' };
      console.error('[new-topic-session] ZCode CLI 已执行但未解析出 sess_id，输出头部: ' + String(out).slice(0, 200));
      return null;
    } catch (e) {
      console.error('[new-topic-session] ZCode CLI 拉起失败: ' + String(e.message).split('\n')[0]);
      return null;
    }
  }

  console.error(
    '\n============================================================\n' +
    '[new-topic-session 优雅降级引导卡]\n' +
    '无法自动拉起专题会话（未检测到 agentapi 或 ZCode CLI 无头拉起未就绪）。\n' +
    '请按以下指引手动建立与绑定：\n' +
    '1. 在 IDE 侧边栏手动点击 [+] 新建一个独立专题会话；\n' +
    '2. 在该新会话中运行: node scripts/init_task_loop.js --bind-current ' + (title.match(/\[(.+?)\]/)?.[1] || '专题') + '\n' +
    '3. 或在 sessions.json 中将新会话 ID 手动登记至 vendors.<vendor>.modules 映射表中。\n' +
    '============================================================\n'
  );
  return null;
}

function findAgentApiBinary(env) {
  env = env || process.env;
  if (env.AGENTAPI_PATH && fs.existsSync(env.AGENTAPI_PATH)) return env.AGENTAPI_PATH;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.cmd'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.exe'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi'),
    path.join(home, '.antigravity', 'bin', 'agentapi.bat'),
    path.join(home, '.antigravity', 'bin', 'agentapi.cmd'),
    path.join(home, '.antigravity', 'bin', 'agentapi.exe'),
    path.join(home, '.antigravity', 'bin', 'agentapi')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Windows where.exe / Unix which
  if (process.platform === 'win32') {
    try {
      const res = spawnSync('where', ['agentapi'], { encoding: 'utf8', shell: true });
      if (res.stdout) {
        const found = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        if (found && fs.existsSync(found)) return found;
      }
    } catch {}
  } else {
    try {
      const res = spawnSync('which', ['agentapi'], { encoding: 'utf8', shell: true });
      if (res.stdout) {
        const found = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        if (found && fs.existsSync(found)) return found;
      }
    } catch {}
  }
  return null;
}

/**
 * 读取 sessions.json 状态
 */
function loadSessionsState(wsRoot) {
  // Schema v4: 仅读取当前宿主厂商分区 (跨版本兼容读, 其余厂商分区零接触)
  const vendor = stateStore.normalizeVendor(stateStore.detectVendor()) || 'antigravity';
  const sessionsPath = path.join(wsRoot, '.agents', 'task-loop', 'sessions.json');
  const part = stateStore.getPartition(sessionsPath, vendor);
  if (part) {
    return Object.assign({ schema_version: stateStore.SCHEMA_VERSION, main_thread_id: null, modules: {}, sessions: [] }, part);
  }
  return { schema_version: stateStore.SCHEMA_VERSION, main_thread_id: null, modules: {}, sessions: [] };
}

/**
 * 保存 sessions.json 与 topics.json
 */
function saveSessionsState(state, wsRoot) {
  // Schema v4: 只写当前宿主厂商分区 (读-改-写), 其余厂商分区零接触, 结构上杜绝跨厂商覆写
  const taskLoopDir = path.join(wsRoot, '.agents', 'task-loop');
  if (!fs.existsSync(taskLoopDir)) {
    fs.mkdirSync(taskLoopDir, { recursive: true });
  }

  const vendor = stateStore.normalizeVendor(stateStore.detectVendor()) || 'antigravity';
  const sessionsPath = path.join(taskLoopDir, 'sessions.json');
  const topicsPath = path.join(taskLoopDir, 'topics.json');

  const partitionData = {
    main_thread_id: state.main_thread_id || null,
    modules: state.modules || {},
    sessions: state.sessions || []
  };
  stateStore.writePartition(sessionsPath, vendor, partitionData, { kind: 'sessions' });

  const topics = Object.entries(state.modules || {}).map(([k, v]) => ({
    topic_key: k,
    name: v.title,
    session_id: v.session_id,
    vendor: v.vendor || vendor,
    resumable: v.resumable !== false,
    tags: v.tags || [k, 'topic'],
    memory_doc: v.memory_doc
  }));
  stateStore.writePartition(topicsPath, vendor, { topics: topics }, { kind: 'topics' });

  // 兼容镜像: 物理分区文件供旧版宿主工具直读
  const mirror = Object.assign({ schema_version: 3, vendor: vendor, updated_at: new Date().toISOString() }, JSON.parse(JSON.stringify(partitionData)));
  fs.writeFileSync(path.join(taskLoopDir, `sessions.${vendor}.json`), JSON.stringify(mirror, null, 2), 'utf8');
}

/**
 * 创建新专题模板文档 (docs/memory/<module_key>.md)
 */
function createTopicMemoryDoc(moduleKey, topicTitle, options = {}) {
  const wsRoot = options.wsRoot || process.cwd();
  const memoryDir = path.join(wsRoot, 'docs', 'memory');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  const docPath = path.join(memoryDir, `${moduleKey}.md`);
  const relPath = normalizePath(path.join('docs', 'memory', `${moduleKey}.md`));

  if (!fs.existsSync(docPath) || options.force) {
    const cleanTitle = topicTitle || `[${moduleKey}专题] 核心功能维护 & 记忆沉淀`;
    const docContent = `# [专题受控记忆] ${cleanTitle} (${moduleKey})

本文档为 \`${moduleKey}\` 专题的受控记忆文档，记录本专题的架构设计、物理白名单、核心逻辑与已证实事实。

---

## 一、专题架构与职责 (Architecture & Scope)
* **模块 Key**: \`${moduleKey}\`
* **专题职责**: 负责 ${moduleKey} 专属领域的业务实现、接口治理与质量保障。
* **物理白名单范围**: \`src/${moduleKey}/**/*\`, \`tests/test_${moduleKey}/**/*\`

---

## 二、架构已知事实与决策 (Architectural Facts & Decisions)
* **已证实事实 1**: 专题受控记忆初始化已建立。
`;
    fs.writeFileSync(docPath, docContent, 'utf8');
  }

  return { docPath, relPath };
}

/**
 * 将当前物理会话就地注册并绑定为专题会话 (无需新建顶层会话)
 */
function bindCurrentSession(moduleKey, topicTitle, sessionId, wsRoot, options = {}) {
  if (!sessionId) {
    throw new Error('就地绑定专题失败: 必须提供有效的 session_id');
  }
  const { docPath, relPath } = createTopicMemoryDoc(moduleKey, topicTitle, { wsRoot, force: options.force });
  const meta = parseMemoryDoc(docPath, wsRoot);
  const state = loadSessionsState(wsRoot);

  if (options.dryRun) {
    return {
      status: 'DRY_RUN',
      module_key: meta.module_key,
      session_id: sessionId,
      title: meta.title,
      memory_doc: meta.memory_doc,
      message: `[预览模式] 将把当前会话 (ID: ${sessionId}) 就地注册为专题 "${meta.title}" 并绑定至 ${meta.memory_doc}`
    };
  }

  // 判定当前厂商
  const vendor = stateStore.normalizeVendor(stateStore.detectVendor()) || 'antigravity';

  // 更新 state
  if (!state.modules) state.modules = {};
  state.modules[meta.module_key] = {
    session_id: sessionId,
    title: meta.title,
    tags: [meta.module_key, 'topic'],
    memory_doc: meta.memory_doc,
    summary: `专题模块: ${meta.title}`
  };

  if (!state.sessions) state.sessions = [];
  const existingIdx = state.sessions.findIndex(s => s.module_key === meta.module_key || s.session_id === sessionId);
  const sessionItem = {
    session_id: sessionId,
    vendor: vendor,
    title: meta.title,
    is_main: false,
    module_key: meta.module_key,
    summary: `专题模块: ${meta.title}`,
    memory_docs: [meta.memory_doc]
  };

  if (existingIdx !== -1) {
    state.sessions[existingIdx] = sessionItem;
  } else {
    state.sessions.push(sessionItem);
  }

  saveSessionsState(state, wsRoot);

  return {
    status: 'BOUND',
    module_key: meta.module_key,
    session_id: sessionId,
    title: meta.title,
    memory_doc: meta.memory_doc,
    message: `✔ 成功将当前物理会话 (vendor: ${vendor}, ID: ${sessionId}) 就地注册为专题 "${meta.title}" 并与 ${meta.memory_doc} 完成 1:1 绑定！`
  };
}

/**
 * 同时创建专题记忆文档与顶层专题会话
 */
function createTopicAndSession(moduleKey, topicTitle, wsRoot, options = {}) {
  const { docPath, relPath } = createTopicMemoryDoc(moduleKey, topicTitle, { wsRoot, force: options.force });
  return provisionSingleDoc(docPath, wsRoot, options);
}

/**
 * 单个记忆文档初始化或强制重建
 */
function provisionSingleDoc(docPath, wsRoot, options = {}) {
  const meta = parseMemoryDoc(docPath, wsRoot);
  const state = loadSessionsState(wsRoot);
  const existingModule = state.modules ? state.modules[meta.module_key] : null;

  if (existingModule && existingModule.session_id && !options.force) {
    return {
      status: 'EXISTS',
      module_key: meta.module_key,
      session_id: existingModule.session_id,
      title: existingModule.title,
      memory_doc: meta.memory_doc,
      message: `专题会话已存在 (ID: ${existingModule.session_id})。如需重新创建请使用 --force 参数。`
    };
  }

  if (options.dryRun) {
    return {
      status: 'DRY_RUN',
      module_key: meta.module_key,
      title: meta.title,
      memory_doc: meta.memory_doc,
      message: `[预览模式] 将创建顶层会话: "${meta.title}" 并绑定至 ${meta.memory_doc}`
    };
  }

  const newId = spawnRootConversation(meta.title, meta.initialPrompt, wsRoot);
  if (!newId || !newId.id) {
    throw new Error(`创建顶层会话失败: 未返回有效会话 ID（详见 stderr 提示: agentapi / zcode CLI / 手动登记三选一）`);
  }

  // 更新 state
  if (!state.modules) state.modules = {};
  state.modules[meta.module_key] = {
    session_id: newId.id,
    title: meta.title,
    tags: [meta.module_key, 'topic'],
    memory_doc: meta.memory_doc,
    summary: `专题模块: ${meta.title}`
  };

  if (!state.sessions) state.sessions = [];
  const existingIdx = state.sessions.findIndex(s => s.module_key === meta.module_key);
  const sessionItem = {
    session_id: newId.id,
    vendor: newId.vendor,
    title: meta.title,
    is_main: false,
    module_key: meta.module_key,
    summary: `专题模块: ${meta.title}`,
    memory_docs: [meta.memory_doc]
  };

  if (existingIdx !== -1) {
    state.sessions[existingIdx] = sessionItem;
  } else {
    state.sessions.push(sessionItem);
  }

  saveSessionsState(state, wsRoot);

  return {
    status: 'CREATED',
    module_key: meta.module_key,
    session_id: newId.id,
    title: meta.title,
    memory_doc: meta.memory_doc,
    message: `✔ 成功创建顶层专题根会话 (vendor: ${newId.vendor}, ID: ${newId.id}) 并与 ${meta.memory_doc} 完成 1:1 绑定！`
  };
}

/**
 * 调查当前所有受控记忆文档与专题会话的对齐状态 (纯只读安全模式)
 */
function surveyMemoryDocsStatus(wsRoot) {
  const memoryDir = path.join(wsRoot, 'docs', 'memory');
  const state = loadSessionsState(wsRoot);
  const existingModules = state.modules || {};

  const allDocs = [];
  if (fs.existsSync(memoryDir)) {
    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const key = path.basename(f, '.md');
      const mod = existingModules[key];
      allDocs.push({
        module_key: key,
        memory_doc: normalizePath(path.join('docs', 'memory', f)),
        session_id: mod ? mod.session_id : null,
        title: mod ? mod.title : `[${key}专题] 核心功能维护 & 记忆沉淀`,
        is_aligned: Boolean(mod && mod.session_id)
      });
    }
  }

  const aligned = allDocs.filter(d => d.is_aligned);
  const missing = allDocs.filter(d => !d.is_aligned);

  return { allDocs, aligned, missing };
}

/**
 * 自动查找并补齐所有未建立会话的专题记忆文档 (需显式确认)
 */
function provisionAllMissing(wsRoot, options = {}) {
  const memoryDir = path.join(wsRoot, 'docs', 'memory');
  if (!fs.existsSync(memoryDir)) {
    return { count: 0, results: [], message: '未找到 docs/memory 目录。' };
  }

  const { missing } = surveyMemoryDocsStatus(wsRoot);

  if (missing.length === 0) {
    return {
      count: 0,
      results: [],
      message: '所有受控记忆文档 (docs/memory/*.md) 均已存在对应的专题会话，无缺失项。'
    };
  }

  const results = [];
  for (const item of missing) {
    const res = provisionSingleDoc(item.memory_doc, wsRoot, options);
    results.push(res);
  }

  return {
    count: missing.length,
    results,
    message: `共发现 ${missing.length} 个缺失会话的记忆文档，已全部补齐创建完成。`
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const force = args.includes('--force') || args.includes('-f');
  const batchAll = args.includes('--all') || args.includes('-a') || args.includes('-y') || args.includes('--yes');
  const wsIndex = args.indexOf('--workspace');
  const wsRoot = (wsIndex !== -1 && args[wsIndex + 1]) ? args[wsIndex + 1] : process.cwd();

  const docIndex = args.indexOf('--doc');
  const topicIndex = args.indexOf('--topic');
  const createTopicIndex = args.indexOf('--create-topic');
  const titleIndex = args.indexOf('--topic-title');

  const bindCurrentIndex = args.indexOf('--bind-current');
  const sessionIndex = args.indexOf('--session');
  const sessionIdIndex = args.indexOf('--session-id');

  let bindCurrentSessionId = null;
  if (bindCurrentIndex !== -1) {
    const nextArg = args[bindCurrentIndex + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      bindCurrentSessionId = nextArg;
    }
  }
  if (!bindCurrentSessionId && sessionIndex !== -1 && args[sessionIndex + 1]) {
    bindCurrentSessionId = args[sessionIndex + 1];
  }
  if (!bindCurrentSessionId && sessionIdIndex !== -1 && args[sessionIdIndex + 1]) {
    bindCurrentSessionId = args[sessionIdIndex + 1];
  }
  if (!bindCurrentSessionId && bindCurrentIndex !== -1) {
    bindCurrentSessionId = process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  }

  const isBindCurrent = bindCurrentIndex !== -1 || Boolean(bindCurrentSessionId);
  const customTitle = (titleIndex !== -1 && args[titleIndex + 1]) ? args[titleIndex + 1] : null;

  let createNewTopicKey = null;
  let targetDoc = null;

  if (createTopicIndex !== -1 && args[createTopicIndex + 1]) {
    createNewTopicKey = args[createTopicIndex + 1];
  } else if (docIndex !== -1 && args[docIndex + 1]) {
    targetDoc = args[docIndex + 1];
  } else if (topicIndex !== -1 && args[topicIndex + 1]) {
    targetDoc = path.join('docs', 'memory', `${args[topicIndex + 1]}.md`);
  }

  console.log('================================================================================');
  console.log(' [new-session] 专题会话主动创建与受控记忆初始化');
  console.log('================================================================================');
  console.log(`工作区根路径: ${normalizePath(wsRoot)}`);
  if (dryRun) console.log('运行模式: [预览模式 (Dry-Run)]');

  if (isBindCurrent) {
    console.log(`模式: [就地注册模式] 将当前/指定物理会话就地注册并绑定为专题会话`);
    if (!bindCurrentSessionId) {
      console.error('❌ 执行失败: 必须指定 --bind-current <session_id> 或 --session-id <session_id>');
      process.exit(1);
    }
    console.log(`目标物理会话 ID: ${bindCurrentSessionId}`);
    const targetKey = createNewTopicKey || (targetDoc ? path.basename(targetDoc, '.md') : null);
    if (!targetKey) {
      console.error('❌ 执行失败: 就地注册模式下必须指定 --create-topic <模块Key> 或 --doc <记忆文档路径>');
      process.exit(1);
    }
    console.log(`模块 Key: ${targetKey}`);
    if (customTitle) console.log(`自定义标题: ${customTitle}`);
    console.log('--------------------------------------------------------------------------------');
    try {
      const res = bindCurrentSession(targetKey, customTitle, bindCurrentSessionId, wsRoot, { dryRun, force });
      console.log(`状态: [${res.status}]`);
      console.log(`专题标题: ${res.title}`);
      console.log(`记忆文档: ${res.memory_doc}`);
      console.log(`会话 ID: ${res.session_id}`);
      console.log(`提示: ${res.message}`);
    } catch (e) {
      console.error(`❌ 执行失败: ${e.message}`);
      process.exit(1);
    }
  } else if (createNewTopicKey) {
    console.log(`模式: [新建专题模式] 同步创建受控记忆文档与独立顶层根会话`);
    console.log(`模块 Key: ${createNewTopicKey}`);
    if (customTitle) console.log(`自定义标题: ${customTitle}`);
    console.log('--------------------------------------------------------------------------------');
    try {
      const res = createTopicAndSession(createNewTopicKey, customTitle, wsRoot, { dryRun, force });
      console.log(`状态: [${res.status}]`);
      console.log(`专题标题: ${res.title}`);
      console.log(`记忆文档: ${res.memory_doc}`);
      if (res.session_id) console.log(`会话 ID: ${res.session_id}`);
      console.log(`提示: ${res.message}`);
    } catch (e) {
      console.error(`❌ 执行失败: ${e.message}`);
      process.exit(1);
    }
  } else if (targetDoc) {
    console.log(`模式: [指定文档模式] 读取既有受控记忆文档并拉起对应会话`);
    console.log(`目标受控记忆: ${targetDoc}`);
    console.log('--------------------------------------------------------------------------------');
    try {
      const res = provisionSingleDoc(targetDoc, wsRoot, { dryRun, force });
      console.log(`状态: [${res.status}]`);
      console.log(`模块 Key: ${res.module_key}`);
      console.log(`专题标题: ${res.title}`);
      if (res.session_id) console.log(`会话 ID: ${res.session_id}`);
      console.log(`提示: ${res.message}`);
    } catch (e) {
      console.error(`❌ 执行失败: ${e.message}`);
      process.exit(1);
    }
  } else if (batchAll) {
    console.log('模式: [全量补齐模式] 为所有未建物理会话的记忆文档批量创建会话');
    console.log('--------------------------------------------------------------------------------');
    const res = provisionAllMissing(wsRoot, { dryRun, force });
    console.log(res.message);
    if (res.results && res.results.length > 0) {
      res.results.forEach((r, idx) => {
        console.log(`\n[${idx + 1}] 模块: ${r.module_key}`);
        console.log(`    记忆文档: ${r.memory_doc}`);
        console.log(`    专题标题: ${r.title}`);
        if (r.session_id) console.log(`    会话 ID: ${r.session_id}`);
        console.log(`    处理状态: ${r.status}`);
      });
    }
  } else {
    // 默认安全调查模式：主动列出清单并提示用户，严禁私自盲创
    console.log('模式: [专题对齐调查模式] 检查当前受控记忆与专题会话对齐状态');
    console.log('--------------------------------------------------------------------------------');
    const survey = surveyMemoryDocsStatus(wsRoot);

    console.log(`【已完成 1:1 绑定的专题会话 (${survey.aligned.length} 个)】:`);
    if (survey.aligned.length > 0) {
      survey.aligned.forEach((a, i) => {
        console.log(`  ${i + 1}. [${a.module_key}] ${a.title}`);
        console.log(`     记忆文档: ${a.memory_doc}`);
        console.log(`     会话 ID:  ${a.session_id}`);
      });
    } else {
      console.log('  (暂无已绑定的专题会话)');
    }

    console.log(`\n【尚未建立物理会话的记忆文档清单 (${survey.missing.length} 个)】:`);
    if (survey.missing.length > 0) {
      survey.missing.forEach((m, i) => {
        console.log(`  ${i + 1}. [${m.module_key}] ${m.title}`);
        console.log(`     记忆文档: ${m.memory_doc}`);
        console.log(`     状态: [⚠ 待建会话]`);
      });
      console.log('\n--------------------------------------------------------------------------------');
      console.log('【用户交互操作指引】:');
      console.log('若需为上述某个记忆文档创建专属专题会话，请执行:');
      console.log('  >> node scripts/new_topic_session.js --doc <记忆文档路径>');
      console.log('若需将当前非主会话直接就地注册绑定为该专题会话，请执行:');
      console.log('  >> node scripts/new_topic_session.js --doc <记忆文档路径> --bind-current <当前会话ID>');
      console.log('若需批量为所有缺失文档建立会话，请执行:');
      console.log('  >> node scripts/new_topic_session.js --all');
    } else {
      console.log('  ✔ 所有现有受控记忆文档均已 1:1 绑定专题会话，无遗留缺失项。');
      console.log('\n--------------------------------------------------------------------------------');
      console.log('【新建全新专题提示】:');
      console.log('若您需要开辟全新业务领域专题（联动创建 docs/memory/<key>.md 与物理会话），请执行:');
      console.log('  >> node scripts/new_topic_session.js --create-topic <模块Key> --topic-title "<专题名称>"');
      console.log('若在当前会话中就地注册新专题，请执行:');
      console.log('  >> node scripts/new_topic_session.js --create-topic <模块Key> --topic-title "<专题名称>" --bind-current <当前会话ID>');
    }
  }
  console.log('================================================================================\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  parseMemoryDoc,
  spawnRootConversation,
  createTopicMemoryDoc,
  createTopicAndSession,
  bindCurrentSession,
  provisionSingleDoc,
  provisionAllMissing,
  surveyMemoryDocsStatus
};
