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
  const prompts = (session.recent_prompts || []).join(' ').toLowerCase();
  const touched = (session.recent_touched_files || []).join(' ').toLowerCase();
  const combined = `${prompts} ${touched}`;

  let category, func1, func2;

  if (combined.includes('主会话') || combined.includes('skill的开发仓库') || combined.includes('任务编排')) {
    category = '主会话';
    func1 = '任务编排';
    func2 = '治理中枢';
  } else if (combined.includes('会话') || combined.includes('session') || combined.includes('sdk')) {
    category = '会话专题';
    func1 = 'SDK接口封装';
    func2 = '会话管理';
  } else if (combined.includes('memory') || combined.includes('记忆')) {
    category = '记忆专题';
    func1 = '记忆文档维护';
    func2 = '经验沉淀';
  } else if (combined.includes('dispatch') || combined.includes('123') || combined.includes('complexity')) {
    category = '调度专题';
    func1 = '复杂度裁决';
    func2 = '派单协议';
  } else if (combined.includes('lease') || combined.includes('lock')) {
    category = '租约专题';
    func1 = '原子锁控制';
    func2 = '并发防护';
  } else if (combined.includes('test') || combined.includes('preflight')) {
    category = '测试专题';
    func1 = '门禁验证';
    func2 = '自动化回归';
  } else {
    category = '通用专题';
    const rawPrompt = (session.recent_prompts && session.recent_prompts[0]) || '';
    const cleaned = rawPrompt.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ');
    const words = cleaned.split(/\s+/).filter(w => w.length >= 2).slice(0, 2);
    func1 = words[0] || '功能开发';
    func2 = words[1] || '自测验证';
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
