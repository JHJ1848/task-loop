#!/usr/bin/env node
/**
 * Initialize Task Loop State (Node.js)
 * Initializes project task-loop state files (.agents/task-loop/) with UTF-8 encoding.
 * Supports auto-scanning project sessions, standardized title generation ([具体专题] 功能点1 & 功能点2),
 * and managing main_thread_id selection.
 */

const fs = require('fs');
const path = require('path');
const { findSessions } = require('./find_project_sessions');

function generateStandardTitle(session) {
  const rawTitle = (session.title || '').replace(/\[[^\]]+\]\([^\)]+\)/g, '').trim();
  const titleLower = rawTitle.toLowerCase();
  const summaryLower = (session.summary || '').toLowerCase();
  const promptsLower = (session.recent_prompts || []).join(' ').toLowerCase();
  const touchedLower = (session.recent_touched_files || []).join(' ').toLowerCase();
  const fullText = `${titleLower} ${summaryLower} ${promptsLower} ${touchedLower}`;

  let category = '';
  let func1 = '';
  let func2 = '';

  if (fullText.includes('topic: hook') || fullText.includes('钩子专题') || (titleLower.includes('hook') && !titleLower.includes('main'))) {
    category = '钩子专题';
    func1 = '生命周期';
    func2 = '安全门禁';
  } else if (fullText.includes('topic: subagent') || fullText.includes('子代理专题') || (titleLower.includes('subagent') && !titleLower.includes('main'))) {
    category = '子代理专题';
    func1 = '动态模板';
    func2 = '编排治理';
  } else if (fullText.includes('topic: session_control') || fullText.includes('会话专题') || (titleLower.includes('session') && !titleLower.includes('main'))) {
    category = '会话控制专题';
    func1 = '跨厂商内省';
    func2 = '会话管理';
  } else if (fullText.includes('topic: memory') || fullText.includes('记忆专题') || titleLower.includes('memory')) {
    category = '受控记忆专题';
    func1 = '文档维护';
    func2 = '经验沉淀';
  } else if (fullText.includes('code review') || fullText.includes('代码审查') || fullText.includes('高级代码审查员') || fullText.includes('走查')) {
    category = '代码审查专题';
    func1 = '质量走查';
    func2 = '门禁核验';
  } else if (fullText.includes('debug') || fullText.includes('排障') || fullText.includes('卡顿') || fullText.includes('故障') || fullText.includes('报错')) {
    category = '排障诊断专题';
    func1 = '缺陷定位';
    func2 = '故障分析';
  } else if (fullText.includes('claude code') || fullText.includes('claude sdk') || fullText.includes('claude')) {
    category = 'Claude协同专题';
    func1 = 'SDK适配';
    func2 = '跨平台支持';
  } else if (fullText.includes('codex') || fullText.includes('openai')) {
    category = 'Codex协同专题';
    func1 = '跨端同步';
    func2 = '会话管理';
  } else if (fullText.includes('plugin') || fullText.includes('插件')) {
    category = 'Plugin规范专题';
    func1 = '接口定义';
    func2 = '插件集成';
  } else if (fullText.includes('dispatch') || fullText.includes('调度') || fullText.includes('task-loop') || fullText.includes('task_loop')) {
    category = '任务循环调度专题';
    func1 = '任务分发';
    func2 = '状态机管理';
  } else if (session.is_main || titleLower.includes('main') || fullText.includes('治理中枢') || fullText.includes('开发仓库')) {
    category = '主会话';
    func1 = '任务编排';
    func2 = '治理中枢';
  } else {
    const cleanText = rawTitle.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ');
    const stopWords = new Set(['请你', '一个', '当前', '这个', '作为', '可以', '需要', '进行', '如何', '为什么', '是否', '实现', '相关', '检查', '项目']);
    const words = cleanText.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
    const kw1 = words[0] || '核心业务';
    const kw2 = words[1] || '功能实现';
    category = `${kw1}专题`;
    func1 = kw1;
    func2 = kw2;
  }

  return `[${category}] ${func1} & ${func2}`;
}

function initState({
  rootPathStr = '.agents/task-loop',
  projectRootStr = '.',
  mainThreadId = null,
  activeVendor = 'antigravity',
  scanSessions = true,
  clearMain = false
} = {}) {
  const root = path.resolve(rootPathStr);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  const sessionsFile = path.join(root, 'sessions.json');
  let existingSessionsData = {};
  if (fs.existsSync(sessionsFile)) {
    try {
      existingSessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    } catch (e) {}
  }

  if (clearMain) {
    mainThreadId = null;
  } else if (mainThreadId === null && existingSessionsData.main_thread_id) {
    mainThreadId = existingSessionsData.main_thread_id;
  }

  let discoveredSessions = [];
  if (scanSessions) {
    const rawSessions = findSessions(projectRootStr, activeVendor, true);
    for (const s of rawSessions) {
      const sid = s.session_id;
      const title = generateStandardTitle(s);
      const isMain = mainThreadId ? sid === mainThreadId : false;
      discoveredSessions.push({
        session_id: sid,
        vendor: s.vendor || activeVendor,
        title: title,
        is_main: isMain,
        created_at: s.created_at,
        last_active_at: s.last_active_at,
        log_path: s.log_path,
        recent_prompts: s.recent_prompts || []
      });
    }
  }

  const sessionsContent = {
    schema_version: 1,
    main_thread_id: mainThreadId,
    sessions: discoveredSessions.length > 0 ? discoveredSessions : (existingSessionsData.sessions || []),
    modules: existingSessionsData.modules || {}
  };

  fs.writeFileSync(sessionsFile, JSON.stringify(sessionsContent, null, 2), 'utf8');

  const filesToCreate = {
    'todo.json': {
      schema_version: 2,
      items: []
    },
    'topics.json': {
      schema_version: 1,
      ignored_memory_docs: [],
      topics: []
    },
    'policy.json': {
      schema_version: 1,
      active_vendor: activeVendor,
      lease_minutes: 25,
      allow_remote_push: false,
      model_profiles: {
        simple: 'gpt-5.6-luna',
        standard: 'gpt-5.6-terra',
        complex: 'gpt-5.6-sol'
      }
    }
  };

  for (const [fname, content] of Object.entries(filesToCreate)) {
    const fpath = path.join(root, fname);
    if (!fs.existsSync(fpath)) {
      fs.writeFileSync(fpath, JSON.stringify(content, null, 2), 'utf8');
    }
  }

  const journal = path.join(root, 'run-journal.jsonl');
  if (!fs.existsSync(journal)) {
    fs.closeSync(fs.openSync(journal, 'w'));
  }

  return {
    action: 'INITIALIZED',
    root: root.replace(/\\/g, '/'),
    main_thread_id: mainThreadId,
    active_vendor: activeVendor,
    discovered_sessions_count: discoveredSessions.length
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = '.agents/task-loop';
  let projectRoot = '.';
  let mainThreadId = null;
  let clearMain = false;
  let vendor = 'antigravity';
  let noScan = false;
  let surveyMode = args.includes('--survey') || args.includes('--dry-run') || args.includes('-d');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = args[++i];
    } else if (args[i] === '--main-thread-id' && args[i + 1]) {
      mainThreadId = args[++i];
    } else if (args[i] === '--clear-main') {
      clearMain = true;
    } else if (args[i] === '--vendor' && args[i + 1]) {
      vendor = args[++i];
    } else if (args[i] === '--no-scan') {
      noScan = true;
    }
  }

  if (surveyMode) {
    console.log('================================================================================');
    console.log(' [task-loop] 项目初始化会话调查与专题映射建议 (Dry-Run Preview)');
    console.log('================================================================================');
    const rawSessions = findSessions(projectRoot, vendor, true);
    console.log(`工作区根路径: ${path.resolve(projectRoot)}`);
    console.log(`已发现历史会话总数: ${rawSessions.length}`);
    console.log(`状态机落盘目标: ${path.resolve(root, 'sessions.json')}`);
    console.log('--------------------------------------------------------------------------------');
    console.log('建议专题映射清单 (Topic Mapping Recommendations):');
    rawSessions.forEach((s, idx) => {
      const title = generateStandardTitle(s);
      console.log(`\n[${idx + 1}] 会话 ID: ${s.session_id}`);
      console.log(`    原标题/厂商: ${s.title || '(无标题)'} (${s.vendor})`);
      console.log(`    建议标准化专题名: ${title}`);
      console.log(`    最近交互提示词: ${(s.recent_prompts && s.recent_prompts[0]) ? s.recent_prompts[0].slice(0, 60) + '...' : '(无)'}`);
    });
    console.log('\n================================================================================');
    console.log('【预览完成】确认上述映射后，去掉 --dry-run / --survey 参数即可实际落盘写入。');
    console.log(`【兜底修改提示】写入后若有命名/ID微调需求，可直接打开编辑: ${path.resolve(root, 'sessions.json')}`);
    console.log('================================================================================\n');
    return;
  }

  const result = initState({
    rootPathStr: root,
    projectRootStr: projectRoot,
    mainThreadId: mainThreadId,
    activeVendor: vendor,
    scanSessions: !noScan,
    clearMain: clearMain
  });

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { initState, generateStandardTitle };
