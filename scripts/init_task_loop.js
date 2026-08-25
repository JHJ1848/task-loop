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
const { getAgyProjectSessions } = require('./providers/get_agy_project_sessions');
const { getCodexProjectSessions } = require('./providers/get_codex_project_sessions');
const { getClaudeProjectSessions } = require('./providers/get_claude_project_sessions');

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

/**
 * 启发式推断专题名称与模块 Key
 */
function inferTopicMapping(session) {
  const title = (session.title || '').toLowerCase();
  const summary = (session.summary || '').toLowerCase();
  const fullText = title + ' ' + summary;

  if (fullText.includes('hook') || fullText.includes('钩子') || fullText.includes('拦截') || fullText.includes('门禁')) {
    return {
      module_key: 'hook',
      topic_name: '钩子体系与安全拦截专题',
      tags: ['hook', 'lifecycle', 'safety_gate'],
      memory_doc: 'docs/memory/hook.md'
    };
  }
  if (fullText.includes('subagent') || fullText.includes('子代理') || fullText.includes('并行') || fullText.includes('worker')) {
    return {
      module_key: 'subagent',
      topic_name: '子代理编排与动态模板专题',
      tags: ['subagent', 'orchestration', 'workers'],
      memory_doc: 'docs/memory/subagent.md'
    };
  }
  if (fullText.includes('session') || fullText.includes('会话') || fullText.includes('provider') || fullText.includes('日志')) {
    return {
      module_key: 'session_control',
      topic_name: '跨厂商会话控制与内省专题',
      tags: ['session_control', 'introspection', 'provider'],
      memory_doc: 'docs/memory/session_control.md'
    };
  }

  // 默认从标题提取合法 key
  let fallbackKey = (session.title || 'custom_topic')
    .replace(/[^\w\u4e00-\u9fa5]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30);
  if (!fallbackKey || fallbackKey === '_') fallbackKey = 'topic_' + (session.session_id || '').slice(0, 8);

  return {
    module_key: fallbackKey,
    topic_name: session.title || '自定义专题',
    tags: ['topic', 'custom'],
    memory_doc: `docs/memory/${fallbackKey}.md`
  };
}

function surveyExistingSessions(wsRoot) {
  const agySessions = getAgyProjectSessions(wsRoot) || [];
  const codexSessions = getCodexProjectSessions(wsRoot) || [];
  const claudeSessions = getClaudeProjectSessions(wsRoot) || [];

  const all = [...agySessions, ...codexSessions, ...claudeSessions];
  const uniqueMap = new Map();

  for (const s of all) {
    if (!uniqueMap.has(s.session_id)) {
      uniqueMap.set(s.session_id, s);
    }
  }

  const list = Array.from(uniqueMap.values());
  const suggestions = list.map(s => {
    const inferred = inferTopicMapping(s);
    return {
      session_id: s.session_id,
      vendor: s.vendor,
      original_title: s.title || '(无标题)',
      suggested_module_key: inferred.module_key,
      suggested_topic_name: inferred.topic_name,
      suggested_tags: inferred.tags,
      suggested_memory_doc: inferred.memory_doc,
      is_main_candidate: s.is_main || false
    };
  });

  return suggestions;
}

function initTaskLoop(options = {}) {
  const wsRoot = options.wsRoot || process.cwd();
  const dryRun = options.dryRun || false;
  const taskLoopDir = path.join(wsRoot, '.agents', 'task-loop');
  const sessionsPath = path.join(taskLoopDir, 'sessions.json');
  const topicsPath = path.join(taskLoopDir, 'topics.json');
  const todoPath = path.join(taskLoopDir, 'todo.json');
  const policyPath = path.join(taskLoopDir, 'policy.json');

  const suggestions = surveyExistingSessions(wsRoot);

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
    topic_mapping_suggestions: suggestions
  };

  if (dryRun) {
    return result;
  }

  // 实际写入
  os_mkdir_p(taskLoopDir);

  // 1. 构建 sessions.json
  let mainThreadId = null;
  const modules = {};
  const sessionsList = [];

  for (const item of suggestions) {
    if (item.is_main_candidate && !mainThreadId) {
      mainThreadId = item.session_id;
    }
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
    main_thread_id: mainThreadId || (suggestions[0] ? suggestions[0].session_id : null),
    updated_at: new Date().toISOString(),
    modules: modules,
    sessions: sessionsList
  };

  fs.writeFileSync(sessionsPath, JSON.stringify(sessionsData, null, 2), 'utf8');

  // 2. topics.json
  if (!fs.existsSync(topicsPath)) {
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

  // 3. todo.json
  if (!fs.existsSync(todoPath)) {
    fs.writeFileSync(todoPath, JSON.stringify({ schema_version: 2, items: [] }, null, 2), 'utf8');
  }

  // 4. policy.json
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
  const wsIndex = args.indexOf('--workspace');
  const wsRoot = (wsIndex !== -1 && args[wsIndex + 1]) ? args[wsIndex + 1] : process.cwd();

  const res = initTaskLoop({ wsRoot, dryRun });

  console.log('================================================================================');
  console.log(' [task-loop] 项目初始化与已有会话调查');
  console.log('================================================================================');
  console.log(`工作区根路径: ${res.workspace_root}`);
  console.log(`状态机存储目录: ${res.storage_directory}`);
  console.log(`核心配置文件: ${res.storage_files.sessions_json}`);
  console.log(`已发现已有历史会话数量: ${res.discovered_sessions_count}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('建议专题映射清单 (Topic Mapping Recommendations):');
  
  res.topic_mapping_suggestions.forEach((s, idx) => {
    console.log(`\n[${idx + 1}] 会话 ID: ${s.session_id}`);
    console.log(`    原标题: ${s.original_title} (${s.vendor})`);
    console.log(`    建议专题名: ${s.suggested_topic_name}`);
    console.log(`    建议模块Key: ${s.suggested_module_key}`);
    console.log(`    关联受控记忆: ${s.suggested_memory_doc}`);
    if (s.is_main_candidate) console.log(`    [Main Candidate] 候选为主会话 (Main Thread)`);
  });

  console.log('\n================================================================================');
  if (dryRun) {
    console.log('【预览模式 (Dry-Run)】未实际写入文件。确认上述建议后，去掉 --dry-run 参数执行即可。');
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
