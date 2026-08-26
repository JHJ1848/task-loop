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
const { scanAgySessions } = require('./providers/get_agy_project_sessions');
const { scanCodexSessions } = require('./providers/get_codex_project_sessions');
const { scanClaudeSessions } = require('./providers/get_claude_project_sessions');

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

/**
 * 启发式推断标准化专题名称与模块 Key
 * 规范格式: [专题名称] 核心功能1 & 核心功能2
 */
function inferTopicMapping(session) {
  const rawTitle = (session.title || '').replace(/\[[^\]]+\]\([^\)]+\)/g, '').trim();
  const titleLower = rawTitle.toLowerCase();
  const summaryLower = (session.summary || '').toLowerCase();
  const promptsLower = (session.recent_prompts || []).join(' ').toLowerCase();
  const touchedLower = (session.recent_touched_files || []).join(' ').toLowerCase();
  const fullText = `${titleLower} ${summaryLower} ${promptsLower} ${touchedLower}`;

  let category = '';
  let func1 = '';
  let func2 = '';
  let moduleKey = '';

  if (session.is_main || titleLower.includes('main') || (session.session_id === 'ee94b2c5-c0c2-473f-8f71-213250ba5295') || fullText.includes('治理中枢') || fullText.includes('开发仓库')) {
    category = '主会话';
    func1 = '任务编排';
    func2 = '治理中枢';
    moduleKey = 'main';
  } else if (fullText.includes('topic: hook') || fullText.includes('钩子专题') || (titleLower.includes('hook') && !titleLower.includes('main'))) {
    category = '钩子专题';
    func1 = '生命周期';
    func2 = '安全门禁';
    moduleKey = 'hook';
  } else if (fullText.includes('topic: subagent') || fullText.includes('子代理专题') || (titleLower.includes('subagent') && !titleLower.includes('main'))) {
    category = '子代理专题';
    func1 = '动态模板';
    func2 = '编排治理';
    moduleKey = 'subagent';
  } else if (fullText.includes('topic: session_control') || fullText.includes('session_control') || fullText.includes('会话专题') || fullText.includes('会话') || (titleLower.includes('session') && !titleLower.includes('main'))) {
    category = '会话控制专题';
    func1 = '跨厂商内省';
    func2 = '会话管理';
    moduleKey = 'session_control';
  } else if (fullText.includes('topic: memory') || fullText.includes('记忆专题') || titleLower.includes('memory')) {
    category = '受控记忆专题';
    func1 = '文档维护';
    func2 = '经验沉淀';
    moduleKey = 'memory';
  } else if (fullText.includes('code review') || fullText.includes('代码审查') || fullText.includes('高级代码审查员') || fullText.includes('走查')) {
    category = '代码审查专题';
    func1 = '质量走查';
    func2 = '门禁核验';
    moduleKey = 'code_review';
  } else if (fullText.includes('debug') || fullText.includes('排障') || fullText.includes('卡顿') || fullText.includes('故障') || fullText.includes('报错')) {
    category = '排障诊断专题';
    func1 = '缺陷定位';
    func2 = '故障分析';
    moduleKey = 'debug';
  } else if (fullText.includes('claude code') || fullText.includes('claude sdk') || (titleLower.includes('claude') && !titleLower.includes('main'))) {
    category = 'Claude协同专题';
    func1 = 'SDK适配';
    func2 = '跨平台支持';
    moduleKey = 'claude_sdk';
  } else if (fullText.includes('topic: codex') || (titleLower.includes('codex') && !titleLower.includes('main'))) {
    category = 'Codex协同专题';
    func1 = '跨端同步';
    func2 = '会话管理';
    moduleKey = 'codex_sync';
  } else if (fullText.includes('topic: plugin') || fullText.includes('plugin规范') || (titleLower.includes('plugin') && !titleLower.includes('main'))) {
    category = 'Plugin规范专题';
    func1 = '接口定义';
    func2 = '插件集成';
    moduleKey = 'plugin_spec';
  } else if (fullText.includes('topic: dispatch') || fullText.includes('调度专题')) {
    category = '任务循环调度专题';
    func1 = '任务分发';
    func2 = '状态机管理';
    moduleKey = 'task_loop';
  } else {
    // 通用启发式智能关键词提取
    const cleanText = rawTitle.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ');
    const stopWords = new Set(['请你', '一个', '当前', '这个', '作为', '可以', '需要', '进行', '如何', '为什么', '是否', '实现', '相关', '检查', '项目']);
    const words = cleanText.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));

    const kw1 = words[0] || '核心业务';
    const kw2 = words[1] || '功能实现';
    category = `${kw1}专题`;
    func1 = kw1;
    func2 = kw2;
    moduleKey = (words[0] ? words[0] : 'custom_topic')
      .replace(/[^\w\u4e00-\u9fa5]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 25);
    if (!moduleKey || moduleKey === '_') moduleKey = `topic_${(session.session_id || '').slice(0, 8)}`;
  }

  const standardizedTitle = `[${category}] ${func1} & ${func2}`;
  return {
    module_key: moduleKey,
    topic_name: standardizedTitle,
    tags: [moduleKey, 'topic'],
    memory_doc: `docs/memory/${moduleKey}.md`
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

function surveyExistingSessions(wsRoot, options = {}) {
  const callerSessionId = options.currentSession || options.currentSessionId || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  const explicitMainSessionId = options.mainSession || options.mainSessionId || null;

  const agySessions = scanAgySessions(wsRoot) || [];
  const codexSessions = scanCodexSessions(wsRoot) || [];
  const claudeSessions = scanClaudeSessions ? scanClaudeSessions(wsRoot) : [];

  const all = [...agySessions, ...codexSessions, ...claudeSessions];
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
      vendor: 'antigravity',
      title: '[主会话] 任务编排 & 治理中枢',
      is_main: true,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString()
    });
  }

  // 主会话选定优先级:
  // 1) --main-session <id> (用户显式指定)
  // 2) --current-session 或环境变量读取到的当前活跃会话 ID (推荐当前发起会话为主会话)
  // 3) 历史扫描中明确带 [主会话] 标签或 is_main 的会话
  // 4) suggestions 列表中的第一项
  let chosenMainId = null;
  if (explicitMainSessionId && uniqueMap.has(explicitMainSessionId)) {
    chosenMainId = explicitMainSessionId;
  } else if (callerSessionId && uniqueMap.has(callerSessionId)) {
    chosenMainId = callerSessionId;
  } else {
    for (const s of uniqueMap.values()) {
      const rawTitle = (s.title || '').toLowerCase();
      if (s.is_main || rawTitle.includes('[主会话]') || rawTitle.includes('治理中枢')) {
        chosenMainId = s.session_id;
        break;
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
        memory_doc: 'docs/memory/main.md'
      };
    } else {
      inferred = inferTopicMapping(s);
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
      original_title: s.title || '(无标题)',
      suggested_module_key: inferred.module_key,
      suggested_topic_name: inferred.topic_name,
      suggested_tags: inferred.tags,
      suggested_memory_doc: inferred.memory_doc,
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

  // 扫描受控记忆文档并进行 1:1 对齐
  const memoryDocs = scanExistingMemoryDocs(wsRoot);
  const memoryAlignment = memoryDocs.map(doc => {
    const matchedSession = suggestions.find(s => s.suggested_module_key === doc.module_key);
    return {
      module_key: doc.module_key,
      memory_doc: doc.relative_path,
      matched_session_id: matchedSession ? matchedSession.session_id : null,
      matched_topic_name: matchedSession ? matchedSession.suggested_topic_name : `[${doc.module_key}专题] 核心功能维护 & 记忆沉淀`,
      status: matchedSession ? 'ALIGNED' : 'MISSING_SESSION'
    };
  });

  return { suggestions, memoryDocs, memoryAlignment, chosenMainId, callerSessionId };
}

function initTaskLoop(options = {}) {
  const wsRoot = options.wsRoot || process.cwd();
  const dryRun = options.dryRun || false;
  const createMissing = options.createMissing || false;
  const taskLoopDir = path.join(wsRoot, '.agents', 'task-loop');
  const sessionsPath = path.join(taskLoopDir, 'sessions.json');
  const topicsPath = path.join(taskLoopDir, 'topics.json');
  const todoPath = path.join(taskLoopDir, 'todo.json');
  const policyPath = path.join(taskLoopDir, 'policy.json');

  const { suggestions, memoryDocs, memoryAlignment, chosenMainId, callerSessionId } = surveyExistingSessions(wsRoot, options);

  const result = {
    workspace_root: normalizePath(wsRoot),
    storage_directory: normalizePath(taskLoopDir),
    storage_files: {
      sessions_json: normalizePath(sessionsPath),
      topics_json: normalizePath(topicsPath),
      todo_json: normalizePath(todoPath),
      policy_json: normalizePath(policyPath)
    },
    discovered_sessions_count: suggestions.length,
    existing_memory_docs_count: memoryDocs.length,
    chosen_main_session_id: chosenMainId,
    caller_session_id: callerSessionId,
    memory_alignment: memoryAlignment,
    topic_mapping_suggestions: suggestions,
    created_sessions: []
  };

  if (dryRun) {
    return result;
  }

  // 实际写入
  os_mkdir_p(taskLoopDir);

  // 1. 若开启了 createMissing，对缺失会话的记忆文档 1:1 自动拉起独立根会话
  if (createMissing) {
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
            vendor: 'antigravity',
            original_title: title,
            suggested_module_key: align.module_key,
            suggested_topic_name: title,
            suggested_tags: [align.module_key, 'topic'],
            suggested_memory_doc: align.memory_doc,
            is_main_candidate: false,
            is_current_session: false
          });
        }
      }
    }
  }

  // 2. 构建 sessions.json
  const mainThreadId = chosenMainId || (suggestions[0] ? suggestions[0].session_id : null);
  const modules = {};
  const sessionsList = [];

  for (const item of suggestions) {
    modules[item.suggested_module_key] = {
      session_id: item.session_id,
      title: item.suggested_topic_name,
      tags: item.suggested_tags,
      memory_doc: item.suggested_memory_doc,
      summary: `专题模块: ${item.suggested_topic_name}`
    };
    sessionsList.push({
      session_id: item.session_id,
      vendor: item.vendor,
      title: item.suggested_topic_name,
      is_main: (item.session_id === mainThreadId),
      module_key: item.suggested_module_key,
      summary: `专题模块: ${item.suggested_topic_name}`,
      memory_docs: [item.suggested_memory_doc]
    });
  }

  const sessionsData = {
    schema_version: 2,
    main_thread_id: mainThreadId,
    updated_at: new Date().toISOString(),
    modules: modules,
    sessions: sessionsList
  };

  fs.writeFileSync(sessionsPath, JSON.stringify(sessionsData, null, 2), 'utf8');

  // 3. topics.json
  if (!fs.existsSync(topicsPath) || createMissing) {
    const topicsData = {
      schema_version: 2,
      topics: Object.entries(modules).map(([k, v]) => ({
        topic_key: k,
        name: v.title,
        session_id: v.session_id,
        tags: v.tags,
        memory_doc: v.memory_doc
      }))
    };
    fs.writeFileSync(topicsPath, JSON.stringify(topicsData, null, 2), 'utf8');
  }

  // 4. todo.json
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(todoPath, JSON.stringify({ schema_version: 2, items: [] }, null, 2), 'utf8');
  }

  // 5. policy.json
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(policyPath, JSON.stringify({
      schema_version: 2,
      active_vendor: 'antigravity',
      default_lease_timeout_sec: 1800,
      enable_file_state_machine: false
    }, null, 2), 'utf8');
  }

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

  const res = initTaskLoop({ wsRoot, dryRun, createMissing, currentSessionId, mainSessionId });

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
    console.log(`\n[M${idx + 1}] 记忆文档: ${m.memory_doc}`);
    console.log(`     模块 Key: ${m.module_key}`);
    console.log(`     专题名称: ${m.matched_topic_name}`);
    console.log(`     绑定会话: ${m.matched_session_id || '(未绑定)'} ${statusTag}`);
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
    console.log(`    建议模块Key: ${s.suggested_module_key}`);
    console.log(`    关联受控记忆: ${s.suggested_memory_doc}`);
    if (s.is_current_session && s.is_main_candidate) {
      console.log(`    [Current Session & Main Candidate] 当前发起会话 (推荐为主治理中枢)`);
    } else if (s.is_main_candidate) {
      console.log(`    [Main Candidate] 候选为主会话 (Main Thread)`);
    } else if (s.is_current_session) {
      console.log(`    [Current Session] 当前发起会话`);
    }
  });

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
  initTaskLoop
};
