#!/usr/bin/env node
/**
 * [inspect_agy_sessions.js]
 * Antigravity (AGY) Project Session Inspector & State Probe
 * 
 * Scans, inspects, and reports the live/sleeping state of all AGY sessions
 * associated with the current workspace.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function formatRelativeTime(dateIso) {
  if (!dateIso) return '未知';
  const now = new Date();
  const date = new Date(dateIso);
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (isNaN(diffSec) || diffSec < 0) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return dateIso.substring(0, 10);
}

function loadRegistrySessions(projectRoot) {
  const map = new Map();
  const candidates = [
    path.join(projectRoot, '.agents', 'task-loop', 'sessions.antigravity.json'),
    path.join(projectRoot, '.agents', 'task-loop', 'sessions.json')
  ];

  for (const fp of candidates) {
    if (fs.existsSync(fp)) {
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        const data = JSON.parse(raw);
        let mainId = data.main_thread_id || null;
        if (data.vendor === 'antigravity' || data.vendors?.antigravity) {
          const vData = data.vendors?.antigravity || data;
          mainId = vData.main_thread_id || mainId;
          const modules = vData.modules || {};
          for (const [modKey, modInfo] of Object.entries(modules)) {
            if (modInfo.session_id) {
              map.set(modInfo.session_id, {
                module_key: modKey,
                title: modInfo.title || `[${modKey}]`,
                is_main: modInfo.session_id === mainId,
                memory_doc: modInfo.memory_doc || null,
                is_registered: true
              });
            }
          }
          const sessions = vData.sessions || [];
          for (const s of sessions) {
            if (s.session_id && !map.has(s.session_id)) {
              map.set(s.session_id, {
                module_key: s.module_key || 'unassigned',
                title: s.title || `Session ${s.session_id.substring(0, 8)}`,
                is_main: s.is_main || s.session_id === mainId,
                memory_doc: s.memory_docs?.[0] || null,
                is_registered: true
              });
            }
          }
        }
        if (map.size > 0) break;
      } catch (e) {
        // ignore parse error
      }
    }
  }
  return map;
}

function inspectAgySessions(options = {}) {
  const projectRootStr = options.root || '.';
  const projectRoot = normalizePath(projectRootStr);
  const rawProjectRoot = path.resolve(projectRootStr);
  const activeWindowMinutes = options.activeWindow || 30;
  const brainDir = options.brainPath ? path.resolve(options.brainPath) : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  const registryMap = loadRegistrySessions(rawProjectRoot);

  if (!fs.existsSync(brainDir) || !fs.statSync(brainDir).isDirectory()) {
    return { project_root: rawProjectRoot, total: 0, sessions: [] };
  }

  const results = [];
  const entries = fs.readdirSync(brainDir);

  for (const entry of entries) {
    const entryPath = path.join(brainDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    const convId = entry;
    let logFile = path.join(entryPath, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(logFile)) {
      logFile = path.join(entryPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!fs.existsSync(logFile)) continue;
    }

    let isMatch = registryMap.has(convId);
    let stepCount = 0;
    let firstCreatedAt = '';
    let lastActiveAt = '';
    let recentPrompt = '';
    let lastUserPrompt = '';
    let lastSidebusMessage = '';

    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        stepCount++;
        const lineLower = line.toLowerCase();
        const projectRootEscaped = projectRoot.replace(':', '%3a');

        if (!isMatch && (lineLower.includes(projectRoot) || lineLower.includes(projectRootEscaped))) {
          isMatch = true;
        }

        try {
          const parsed = JSON.parse(line);
          const createdAt = parsed.created_at || '';
          if (createdAt) {
            if (!firstCreatedAt) firstCreatedAt = createdAt;
            lastActiveAt = createdAt;
          }

          if (parsed.type === 'USER_INPUT' && parsed.content) {
            let clean = parsed.content.replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').trim();
            if (clean) lastUserPrompt = clean;
          }

          if (parsed.content && (parsed.content.includes('[主会话派单') || parsed.content.includes('[专题交付') || parsed.content.includes('[协同回执'))) {
            let clean = parsed.content.replace(/<[^>]+>/g, '').replace(/[\r\n]+/g, ' ').trim();
            if (clean) lastSidebusMessage = clean;
          }
        } catch (e) {
          // fallback string match
        }
      }
    } catch (e) {
      // ignore
    }

    if (!lastActiveAt) {
      try {
        const stat = fs.statSync(logFile);
        lastActiveAt = stat.mtime.toISOString();
        if (!firstCreatedAt) firstCreatedAt = (stat.birthtime || stat.ctime).toISOString();
      } catch (e) {}
    }

    if (!isMatch) continue;

    recentPrompt = lastSidebusMessage || lastUserPrompt || '(无近期交互摘要)';
    if (recentPrompt.length > 80) {
      recentPrompt = recentPrompt.substring(0, 77) + '...';
    }

    const regInfo = registryMap.get(convId) || {
      module_key: 'unregistered',
      title: `[未命名会话] ${convId.substring(0, 8)}`,
      is_main: false,
      memory_doc: null,
      is_registered: false
    };

    // Calculate active/sleeping state
    const nowMs = Date.now();
    const lastActiveMs = lastActiveAt ? new Date(lastActiveAt).getTime() : 0;
    const diffMins = (nowMs - lastActiveMs) / (1000 * 60);

    let status = 'IDLE_SLEEPING';
    if (diffMins <= activeWindowMinutes) {
      status = regInfo.is_registered ? 'ACTIVE' : 'UNREGISTERED_ACTIVE';
    } else {
      status = regInfo.is_registered ? 'IDLE_SLEEPING' : 'UNREGISTERED';
    }

    results.push({
      session_id: convId,
      title: regInfo.title,
      module_key: regInfo.module_key,
      is_main: regInfo.is_main,
      is_registered: regInfo.is_registered,
      status: status,
      steps: stepCount,
      created_at: firstCreatedAt,
      last_active_at: lastActiveAt,
      last_active_relative: formatRelativeTime(lastActiveAt),
      memory_doc: regInfo.memory_doc,
      recent_prompt: recentPrompt,
      deep_link: `conversation://${convId}`
    });
  }

  // Sort: Main session first, then active sessions, then by last active timestamp descending
  results.sort((a, b) => {
    if (a.is_main && !b.is_main) return -1;
    if (!a.is_main && b.is_main) return 1;
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
    return (new Date(b.last_active_at || 0)).getTime() - (new Date(a.last_active_at || 0)).getTime();
  });

  return {
    project_root: rawProjectRoot,
    total: results.length,
    active_count: results.filter(r => r.status === 'ACTIVE').length,
    sleeping_count: results.filter(r => r.status === 'IDLE_SLEEPING').length,
    sessions: results
  };
}

function printTable(report) {
  console.log(`\n================================================================================`);
  console.log(`[task-loop] AGY 会话状态巡检与探针报告 (Session Inspector)`);
  console.log(`================================================================================`);
  console.log(`* 工作区目录: ${report.project_root}`);
  console.log(`* 会话总数: ${report.total} (活跃: ${report.active_count} | 休眠: ${report.sleeping_count})`);
  console.log(`--------------------------------------------------------------------------------`);

  if (report.sessions.length === 0) {
    console.log(`(当前工作区未发现已绑定的 AGY 会话)`);
    console.log(`--------------------------------------------------------------------------------\n`);
    return;
  }

  for (let i = 0; i < report.sessions.length; i++) {
    const s = report.sessions[i];
    const roleTag = s.is_main ? '[Main 会话中枢]' : `[专题: ${s.module_key}]`;
    const statusTag = s.status === 'ACTIVE' ? '[ACTIVE:活跃]' : `[SLEEPING:休眠]`;

    console.log(`\n${i + 1}. ${s.title}  ${roleTag}  ${statusTag}`);
    console.log(`   * 会话 ID     : ${s.session_id}`);
    console.log(`   * 步数 / 活跃 : ${s.steps} Steps | ${s.last_active_relative} (${s.last_active_at || 'N/A'})`);
    if (s.memory_doc) {
      console.log(`   * 受控记忆   : ${s.memory_doc}`);
    }
    console.log(`   * 最近交互   : ${s.recent_prompt}`);
    console.log(`   * 切换唤醒卡 : [-> 点击切换至该会话](${s.deep_link})`);
  }

  console.log(`\n================================================================================\n`);
}

function probeDispatchSession(sessionId, options = {}) {
  const brainDir = options.brainPath ? path.resolve(options.brainPath) : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const sessionDir = path.join(brainDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    return {
      session_id: sessionId,
      found: false,
      thread_running: false,
      is_working: false,
      working_status: 'DORMANT_NOT_ACTIVATED',
      can_enter_120s_gate: false,
      should_loop_30s_probe: true,
      dispatch_found: false,
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      reason: `会话目录不存在: ${sessionDir}`,
      deep_link: `conversation://${sessionId}`,
      alert_card: `[🔴 专题未激活告警卡]\n专题会话 (${sessionId}) 尚未创建或无日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://${sessionId})`
    };
  }

  let logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(logFile)) {
    logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (!fs.existsSync(logFile)) {
      return {
        session_id: sessionId,
        found: false,
        thread_running: false,
        is_working: false,
        working_status: 'DORMANT_NOT_ACTIVATED',
        can_enter_120s_gate: false,
        should_loop_30s_probe: true,
        dispatch_found: false,
        model_steps_count: 0,
        tool_calls_count: 0,
        thinking_steps_count: 0,
        in_progress_steps_count: 0,
        reason: '未找到 transcript.jsonl 日志文件',
        deep_link: `conversation://${sessionId}`,
        alert_card: `[🔴 专题未激活告警卡]\n专题会话 (${sessionId}) 尚未生成交互日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://${sessionId})`
      };
    }
  }

  let lastDispatchIndex = -1;
  let lastDispatchStep = null;
  const steps = [];

  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    let idx = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        steps.push(parsed);
        const text = parsed.content || (parsed.thinking ? JSON.stringify(parsed.thinking) : '') || '';
        if (
          text.includes('[主会话派单') ||
          text.includes('【主会话派单') ||
          (parsed.type === 'USER_INPUT' && (text.includes('单一职责目标') || text.includes('物理白名单') || text.includes('派单任务')))
        ) {
          lastDispatchIndex = idx;
          lastDispatchStep = {
            step_index: parsed.step_index ?? idx,
            type: parsed.type,
            created_at: parsed.created_at,
            snippet: text.slice(0, 100)
          };
        }
        idx++;
      } catch (e) {}
    }
  } catch (e) {
    return {
      session_id: sessionId,
      found: false,
      thread_running: false,
      is_working: false,
      working_status: 'DORMANT_NOT_ACTIVATED',
      can_enter_120s_gate: false,
      should_loop_30s_probe: true,
      dispatch_found: false,
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      reason: `读取日志异常: ${e.message}`,
      deep_link: `conversation://${sessionId}`
    };
  }

  if (lastDispatchIndex === -1) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].source === 'USER_EXPLICIT' || steps[i].type === 'USER_INPUT' || steps[i].source === 'SYSTEM') {
        lastDispatchIndex = i;
        lastDispatchStep = {
          step_index: steps[i].step_index ?? i,
          type: steps[i].type,
          created_at: steps[i].created_at,
          snippet: (steps[i].content || '').slice(0, 100)
        };
        break;
      }
    }
  }

  let modelStepsAfterDispatch = 0;
  let toolCallsCount = 0;
  let thinkingStepsCount = 0;
  let inProgressStepsCount = 0;
  let threadRunning = false;
  let latestModelStep = null;

  for (let i = lastDispatchIndex + 1; i < steps.length; i++) {
    const st = steps[i];
    const isModel = st.source === 'MODEL' || st.type === 'PLANNER_RESPONSE';
    const hasToolCalls = Boolean(st.tool_calls && st.tool_calls.length > 0);
    const hasThinking = Boolean(st.thinking);
    const isInProgress = st.status === 'IN_PROGRESS';

    if (hasToolCalls) {
      toolCallsCount += (Array.isArray(st.tool_calls) ? st.tool_calls.length : 1);
    }
    if (hasThinking) {
      thinkingStepsCount++;
    }
    if (isInProgress) {
      inProgressStepsCount++;
      threadRunning = true;
    }

    if (isModel || hasToolCalls || hasThinking || isInProgress) {
      modelStepsAfterDispatch++;
      latestModelStep = {
        step_index: st.step_index ?? i,
        type: st.type,
        status: st.status || 'DONE',
        created_at: st.created_at,
        has_tool_calls: hasToolCalls,
        has_thinking: hasThinking,
        is_in_progress: isInProgress
      };
    }
  }

  // Also check if the absolute last step of the whole session is actively generating/in-progress
  if (steps.length > 0 && steps[steps.length - 1].status === 'IN_PROGRESS') {
    threadRunning = true;
  }

  const isWorking = Boolean(modelStepsAfterDispatch > 0 || threadRunning);
  const canEnter120sGate = isWorking;
  const shouldLoop30sProbe = !isWorking;

  return {
    session_id: sessionId,
    found: true,
    thread_running: threadRunning,
    is_working: isWorking,
    working_status: isWorking ? 'WORKING_IN_PROGRESS' : 'DORMANT_NOT_ACTIVATED',
    can_enter_120s_gate: canEnter120sGate,
    should_loop_30s_probe: shouldLoop30sProbe,
    dispatch_found: lastDispatchIndex !== -1,
    dispatch_step_index: lastDispatchIndex,
    last_dispatch_step: lastDispatchStep,
    model_steps_count: modelStepsAfterDispatch,
    tool_calls_count: toolCallsCount,
    thinking_steps_count: thinkingStepsCount,
    in_progress_steps_count: inProgressStepsCount,
    latest_model_step: latestModelStep,
    deep_link: `conversation://${sessionId}`,
    alert_card: isWorking ? null : `[🔴 专题未激活告警卡]\n专题会话 (${sessionId}) 尚未进入大模型真实工作态 (未见 MODEL 步 / thread_running: false)！\n【自愈与门禁规则】:\n1. 绝对严禁挂载 120s 定时器进入盲等！\n2. 立即通过 agentapi.bat send-message 补发唤醒，或点击下方链接在 UI 中手动激活：\n[-> 点击切换并激活专题会话](conversation://${sessionId})\n3. 必须继续挂载 30s 探针循环监控，直到真实激活。`
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let root = '.';
  let brainPath = null;
  let isJson = false;
  let activeWindow = 30;
  let probeDispatchId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === '--brain-path' && args[i + 1]) {
      brainPath = args[++i];
    } else if (args[i] === '--active-window' && args[i + 1]) {
      activeWindow = parseInt(args[++i], 10) || 30;
    } else if (args[i] === '--probe-dispatch' && args[i + 1]) {
      probeDispatchId = args[++i];
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: node scripts/inspect_agy_sessions.js [options]`);
      console.log(`Options:`);
      console.log(`  --root <path>               Project root directory (default: .)`);
      console.log(`  --brain-path <path>         Custom AGY brain directory`);
      console.log(`  --active-window <mins>      Minutes to consider a session ACTIVE (default: 30)`);
      console.log(`  --probe-dispatch <sess_id>  Probe target session for real MODEL execution post-dispatch`);
      console.log(`  --json                      Output raw JSON instead of table`);
      process.exit(0);
    }
  }

  if (probeDispatchId) {
    const probeResult = probeDispatchSession(probeDispatchId, { brainPath });
    console.log(JSON.stringify(probeResult, null, 2));
    process.exit(0);
  }

  const report = inspectAgySessions({ root, brainPath, activeWindow });
  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
}

module.exports = { inspectAgySessions, probeDispatchSession, formatRelativeTime, loadRegistrySessions };
