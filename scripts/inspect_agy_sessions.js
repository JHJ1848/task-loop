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

/**
 * 保护性检查 AgentAPI RPC 连通性
 */
function checkAgentApiRpc(sessionId, options = {}) {
  if (options.skipRpc) {
    return { checked: false, available: true, skipped: true };
  }
  const home = os.homedir();
  const candidates = [
    process.env.AGENTAPI_PATH,
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.exe'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi'),
    path.join(home, '.antigravity', 'bin', 'agentapi.bat'),
    path.join(home, '.antigravity', 'bin', 'agentapi.exe'),
    path.join(home, '.antigravity', 'bin', 'agentapi')
  ].filter(Boolean);

  let bin = candidates.find(c => fs.existsSync(c));
  if (!bin) {
    try {
      const which = process.platform === 'win32' ? 'where.exe agentapi' : 'which agentapi';
      const out = require('child_process').execSync(which, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 600 }).trim();
      const firstLine = out.split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) bin = firstLine;
    } catch {}
  }

  if (!bin || !fs.existsSync(bin)) {
    return { checked: false, available: false, error: 'agentapi binary not found' };
  }

  try {
    const isWin = process.platform === 'win32';
    const isBat = isWin && /\.(bat|cmd)$/i.test(bin);
    let res;
    if (isBat) {
      const cmdPath = process.env.ComSpec || 'cmd.exe';
      res = require('child_process').spawnSync(cmdPath, ['/d', '/s', '/c', `"${bin}" get-conversation-metadata ${sessionId}`], {
        encoding: 'utf8',
        timeout: 3000,
        windowsVerbatimArguments: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    } else {
      res = require('child_process').spawnSync(bin, ['get-conversation-metadata', sessionId], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    }
    if (res.error) {
      return { checked: true, available: false, error: res.error.message };
    }
    if (res.status === 0 && res.stdout) {
      let meta = null;
      try { meta = JSON.parse(res.stdout); } catch { meta = res.stdout.trim(); }
      return { checked: true, available: true, metadata: meta };
    } else {
      const errOut = (res.stderr && res.stderr.trim()) || `exit code ${res.status}`;
      return { checked: true, available: false, error: errOut };
    }
  } catch (err) {
    return { checked: true, available: false, error: err.message };
  }
}

/**
 * 跨会话转录内省原语 (Transcript Introspection Primitive)
 * 按时序提取目标会话的最新执行轨迹，包括思维链 Thinking、工具调用与模型内容。
 */
function fetchSessionTranscript(sessionId, options = {}) {
  const tail = typeof options.tail === 'number' && options.tail > 0 ? options.tail : 5;
  const includeThinking = options.includeThinking !== false;
  const includeTools = options.includeTools !== false;
  const brainDir = options.brainPath
    ? path.resolve(options.brainPath)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const sessionDir = path.join(brainDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    return {
      session_id: sessionId,
      found: false,
      total_steps: 0,
      tail,
      steps: [],
      error: `会话目录不存在: ${sessionDir}`
    };
  }

  let logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(logFile)) {
    logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  }

  if (!fs.existsSync(logFile)) {
    return {
      session_id: sessionId,
      found: false,
      total_steps: 0,
      tail,
      steps: [],
      error: `日志文件不存在: ${logFile}`
    };
  }

  const allSteps = [];
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        allSteps.push(parsed);
      } catch {}
    }
  } catch (err) {
    return {
      session_id: sessionId,
      found: false,
      total_steps: 0,
      tail,
      steps: [],
      error: `读取转录日志失败: ${err.message}`
    };
  }

  const rawTailSteps = allSteps.slice(-tail);
  const formattedSteps = rawTailSteps.map((st, idx) => {
    const stepIdx = st.step_index !== undefined ? st.step_index : (allSteps.length - rawTailSteps.length + idx);
    const item = {
      step_index: stepIdx,
      type: st.type || 'UNKNOWN',
      source: st.source || 'UNKNOWN',
      status: st.status || 'DONE',
      created_at: st.created_at || null
    };

    if (includeThinking && st.thinking) {
      item.thinking_preview = st.thinking.length > 200
        ? st.thinking.slice(0, 197) + '...'
        : st.thinking;
    } else {
      item.thinking_preview = null;
    }

    if (includeTools && st.tool_calls && Array.isArray(st.tool_calls)) {
      item.tool_calls = st.tool_calls.map(tc => {
        let argsSummary = '';
        if (tc.args) {
          if (typeof tc.args === 'string') {
            argsSummary = tc.args.length > 120 ? tc.args.slice(0, 117) + '...' : tc.args;
          } else {
            const str = JSON.stringify(tc.args);
            argsSummary = str.length > 120 ? str.slice(0, 117) + '...' : str;
          }
        }
        return {
          name: tc.name || 'unnamed_tool',
          args_summary: argsSummary
        };
      });
    } else {
      item.tool_calls = [];
    }

    if (st.content && typeof st.content === 'string') {
      item.content_snippet = st.content.length > 200
        ? st.content.slice(0, 197) + '...'
        : st.content;
    } else {
      item.content_snippet = null;
    }

    return item;
  });

  return {
    session_id: sessionId,
    found: true,
    total_steps: allSteps.length,
    tail,
    log_file: logFile,
    steps: formattedSteps
  };
}

/**
 * 格式化打印近期执行轨迹报告
 */
function printRecentTrajectory(data) {
  console.log('\n' + '='.repeat(80));
  console.log('[task-loop] 目标专题会话执行轨迹内省报告 (Transcript Introspection)');
  console.log('='.repeat(80));
  console.log(`* 会话 ID   : ${data.session_id}`);
  console.log(`* 状态     : ${data.found ? '🟢 日志已就绪' : '🔴 未找到日志'}`);
  console.log(`* 总步数   : ${data.total_steps} (展示最近 ${data.steps ? data.steps.length : 0} 步)`);
  if (data.log_file) {
    console.log(`* 日志路径 : ${data.log_file}`);
  }
  if (data.error) {
    console.log(`* 错误信息 : ${data.error}`);
  }
  console.log('-'.repeat(80));

  if (!data.steps || data.steps.length === 0) {
    console.log('(未检测到有效历史步骤)');
  } else {
    data.steps.forEach(st => {
      const sourceTag = `[${st.source || 'UNKNOWN'}]`;
      const typeTag = `[${st.type || 'STEP'}]`;
      const statusTag = `[${st.status || 'DONE'}]`;
      console.log(`\n#${st.step_index} ${sourceTag} ${typeTag} ${statusTag} (${st.created_at || '时间未知'})`);
      if (st.thinking_preview) {
        console.log(`   💡 思考链: ${st.thinking_preview.replace(/\r?\n/g, ' ')}`);
      }
      if (st.tool_calls && st.tool_calls.length > 0) {
        st.tool_calls.forEach(tc => {
          console.log(`   🔧 工具调用: ${tc.name} -> ${tc.args_summary}`);
        });
      }
      if (st.content_snippet) {
        console.log(`   💬 内容摘要: ${st.content_snippet.replace(/\r?\n/g, ' ')}`);
      }
    });
  }
  console.log('\n' + '='.repeat(80) + '\n');
}

/**
 * 4维物理交叉验证探针 (4-Dimension Physical Cross-Validation Probe)
 * 彻底消灭历史步骤与假阳性绿灯，综合在场锁、文件物理增量、步骤时效与 Daemon RPC。
 */
function probeDispatchSession(sessionId, options = {}) {
  const brainDir = options.brainPath ? path.resolve(options.brainPath) : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const sessionDir = path.join(brainDir, sessionId);
  const nowMs = Date.now();
  const freshWindowSec = typeof options.freshWindowSec === 'number' ? options.freshWindowSec : 30;
  const baselineTime = options.baselineTime || null;
  const baselineSize = typeof options.baselineSize === 'number' ? options.baselineSize : null;

  // 维度 1: Presence 在场锁检测
  const presenceLockDir = options.presencePath
    ? path.resolve(options.presencePath)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'presence');
  const presenceLockFile = path.join(presenceLockDir, `${sessionId}.lock`);
  const isPresent = fs.existsSync(presenceLockFile);
  const dimensionPresence = {
    is_present: isPresent,
    lock_file: presenceLockFile
  };

  if (!fs.existsSync(sessionDir)) {
    const dimensionFs = {
      transcript_path: null,
      transcript_mtime: null,
      transcript_size: 0,
      delta_bytes: 0,
      has_recent_write: false,
      mtime_diff_sec: null
    };
    const dimensionInference = {
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      latest_model_step: null,
      is_fresh: false,
      step_age_sec: null,
      thread_running_fresh: false
    };
    const dimensionRpc = checkAgentApiRpc(sessionId, options);

    return {
      session_id: sessionId,
      found: false,
      thread_running: false,
      is_working: false,
      working_status: 'DORMANT_NOT_ACTIVATED',
      can_enter_gate: false,
      can_enter_120s_gate: false,
      should_loop_probe: true,
      should_loop_30s_probe: true,
      should_loop_30s_monitor: true,
      dispatch_found: false,
      recent_trajectory: [],
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      dimensions: {
        presence: dimensionPresence,
        filesystem: dimensionFs,
        inference_step: dimensionInference,
        rpc: dimensionRpc
      },
      reason: `会话目录不存在: ${sessionDir}`,
      deep_link: `conversation://${sessionId}`,
      alert_card: `[🔴 专题未激活告警卡]\n专题会话 (${sessionId}) 尚未创建或无日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://${sessionId})`
    };
  }

  let logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(logFile)) {
    logFile = path.join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  }

  // 维度 2: 文件系统物理状态与增量检测
  let transcriptMtime = null;
  let transcriptMtimeMs = 0;
  let transcriptSize = 0;
  let deltaBytes = null;
  if (fs.existsSync(logFile)) {
    try {
      const stat = fs.statSync(logFile);
      transcriptMtime = stat.mtime.toISOString();
      transcriptMtimeMs = stat.mtime.getTime();
      transcriptSize = stat.size;
      if (baselineSize !== null) {
        deltaBytes = Math.max(0, transcriptSize - baselineSize);
      }
    } catch {}
  }

  let mtimeDiffSec = transcriptMtimeMs > 0 ? Math.floor((nowMs - transcriptMtimeMs) / 1000) : null;
  let hasRecentWrite = false;
  if (baselineTime) {
    const baseMs = typeof baselineTime === 'number' ? baselineTime : new Date(baselineTime).getTime();
    if (!isNaN(baseMs)) {
      hasRecentWrite = transcriptMtimeMs >= (baseMs - 1000);
      if (baselineSize !== null) {
        hasRecentWrite = hasRecentWrite && (deltaBytes > 0);
      }
    }
  } else if (mtimeDiffSec !== null) {
    hasRecentWrite = mtimeDiffSec <= freshWindowSec;
  }

  const dimensionFilesystem = {
    transcript_path: logFile,
    transcript_mtime: transcriptMtime,
    transcript_size: transcriptSize,
    delta_bytes: deltaBytes,
    has_recent_write: hasRecentWrite,
    mtime_diff_sec: mtimeDiffSec
  };

  if (!fs.existsSync(logFile)) {
    const dimensionInference = {
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      latest_model_step: null,
      is_fresh: false,
      step_age_sec: null,
      thread_running_fresh: false
    };
    const dimensionRpc = checkAgentApiRpc(sessionId, options);

    return {
      session_id: sessionId,
      found: false,
      thread_running: false,
      is_working: false,
      working_status: 'DORMANT_NOT_ACTIVATED',
      can_enter_gate: false,
      can_enter_120s_gate: false,
      should_loop_probe: true,
      should_loop_30s_probe: true,
      should_loop_30s_monitor: true,
      dispatch_found: false,
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      dimensions: {
        presence: dimensionPresence,
        filesystem: dimensionFilesystem,
        inference_step: dimensionInference,
        rpc: dimensionRpc
      },
      reason: '未找到 transcript.jsonl 日志文件',
      deep_link: `conversation://${sessionId}`,
      alert_card: `[🔴 专题未激活告警卡]\n专题会话 (${sessionId}) 尚未生成交互日志！请点击唤醒：\n[-> 点击切换并激活专题会话](conversation://${sessionId})`
    };
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
    const dimensionInference = {
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      latest_model_step: null,
      is_fresh: false,
      step_age_sec: null,
      thread_running_fresh: false
    };
    const dimensionRpc = checkAgentApiRpc(sessionId, options);

    return {
      session_id: sessionId,
      found: false,
      thread_running: false,
      is_working: false,
      working_status: 'DORMANT_NOT_ACTIVATED',
      can_enter_gate: false,
      can_enter_120s_gate: false,
      should_loop_probe: true,
      should_loop_30s_probe: true,
      should_loop_30s_monitor: true,
      dispatch_found: false,
      model_steps_count: 0,
      tool_calls_count: 0,
      thinking_steps_count: 0,
      in_progress_steps_count: 0,
      dimensions: {
        presence: dimensionPresence,
        filesystem: dimensionFilesystem,
        inference_step: dimensionInference,
        rpc: dimensionRpc
      },
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

  // 检查最后一步是否为 IN_PROGRESS
  if (steps.length > 0 && steps[steps.length - 1].status === 'IN_PROGRESS') {
    threadRunning = true;
  }

  // 维度 3: Step Freshness 时效强校验 (彻底根除历史步骤假阳性)
  let isStepFresh = false;
  let stepAgeSec = null;
  if (latestModelStep && latestModelStep.created_at) {
    const stepMs = new Date(latestModelStep.created_at).getTime();
    if (!isNaN(stepMs)) {
      stepAgeSec = Math.floor((nowMs - stepMs) / 1000);
      if (baselineTime) {
        const baseMs = typeof baselineTime === 'number' ? baselineTime : new Date(baselineTime).getTime();
        if (!isNaN(baseMs)) {
          isStepFresh = stepMs >= (baseMs - 1000);
        }
      } else {
        isStepFresh = stepAgeSec <= freshWindowSec;
      }
    }
  }

  let threadRunningFresh = false;
  if (threadRunning && steps.length > 0) {
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.created_at) {
      const lastMs = new Date(lastStep.created_at).getTime();
      if (!isNaN(lastMs)) {
        const lastAgeSec = Math.floor((nowMs - lastMs) / 1000);
        if (baselineTime) {
          const baseMs = typeof baselineTime === 'number' ? baselineTime : new Date(baselineTime).getTime();
          threadRunningFresh = lastMs >= (baseMs - 1000);
        } else {
          threadRunningFresh = lastAgeSec <= freshWindowSec;
        }
      }
    }
  }

  const dimensionInference = {
    model_steps_count: modelStepsAfterDispatch,
    tool_calls_count: toolCallsCount,
    thinking_steps_count: thinkingStepsCount,
    in_progress_steps_count: inProgressStepsCount,
    latest_model_step: latestModelStep,
    is_fresh: isStepFresh,
    step_age_sec: stepAgeSec,
    thread_running_fresh: threadRunningFresh
  };

  // 维度 4: Daemon RPC 可达性
  const dimensionRpc = checkAgentApiRpc(sessionId, options);

  // 综合裁决逻辑 (Reconciliation Logic):
  // 充要条件:
  // 1. 最新模型推理步骤在时效判定窗口内 (is_fresh 或 threadRunningFresh)
  // 2. 或磁盘物理层近期有真实写入且 IDE 在场处于前台聚焦活跃态 (has_recent_write && is_present)
  const isWorking = Boolean(
    dimensionInference.is_fresh ||
    dimensionInference.thread_running_fresh ||
    (dimensionFilesystem.has_recent_write && dimensionPresence.is_present)
  );

  const canEnterGate = isWorking;
  const shouldLoopProbe = !isWorking;

  const dimensions = {
    presence: dimensionPresence,
    filesystem: dimensionFilesystem,
    inference_step: dimensionInference,
    rpc: dimensionRpc
  };

  const alertCard = isWorking ? null : [
    `[🔴 专题未激活告警卡]`,
    `专题会话 (${sessionId}) 尚未进入大模型真实工作态 (4维物理交叉验证: 未检测到时效内的有效步骤与活跃写入)！`,
    `【4维物理校验指标】:`,
    `* 在场锁 (Presence): ${dimensionPresence.is_present ? '🟢 在场' : '⚪ 未打开/休眠'}`,
    `* 磁盘变更 (Filesystem): ${dimensionFilesystem.has_recent_write ? '🟢 近期有写入' : '⚪ 无近期写入'} (${dimensionFilesystem.delta_bytes !== null ? `增量: ${dimensionFilesystem.delta_bytes}B` : `大小: ${dimensionFilesystem.transcript_size}B`})`,
    `* 推理时效 (Inference): ${dimensionInference.is_fresh ? '🟢 新鲜步骤' : '🔴 无时效内步骤'} (步骤距今: ${dimensionInference.step_age_sec !== null ? `${dimensionInference.step_age_sec}s` : '无'})`,
    `* RPC 可达 (Daemon): ${dimensionRpc.available ? '🟢 可达' : '⚪ 未激活'}`,
    `【自愈与门禁规则】:`,
    `1. 绝对严禁挂载 120s 巡检任务进入盲等！`,
    `2. 立即通过 agentapi send-message 补发唤醒，或点击下方链接在 UI 中手动激活：`,
    `[-> 点击切换并激活专题会话](conversation://${sessionId})`,
    `3. 必须继续挂载 30s 进度监测器循环监控，直到真实激活。`
  ].join('\n');

  const recentTrajectory = steps.slice(-3).map((st, idx) => {
    const stepIdx = st.step_index !== undefined ? st.step_index : (steps.length - 3 + idx);
    const tcNames = (st.tool_calls && Array.isArray(st.tool_calls))
      ? st.tool_calls.map(tc => tc.name).filter(Boolean)
      : [];
    let actionSummary = st.type || 'UNKNOWN';
    if (tcNames.length > 0) {
      actionSummary = `tool_calls(${tcNames.join(', ')})`;
    } else if (st.thinking) {
      actionSummary = 'thinking';
    } else if (st.content) {
      actionSummary = 'content_output';
    }
    return {
      step_index: stepIdx,
      source: st.source || 'UNKNOWN',
      type: st.type || 'UNKNOWN',
      status: st.status || 'DONE',
      created_at: st.created_at || null,
      action_summary: actionSummary,
      thinking_preview: st.thinking ? (st.thinking.slice(0, 100).replace(/\s+/g, ' ')) : null
    };
  });

  return {
    session_id: sessionId,
    found: true,
    thread_running: threadRunningFresh || threadRunning,
    is_working: isWorking,
    working_status: isWorking ? 'WORKING_IN_PROGRESS' : 'DORMANT_NOT_ACTIVATED',
    can_enter_gate: canEnterGate,
    can_enter_120s_gate: canEnterGate,
    should_loop_probe: shouldLoopProbe,
    should_loop_30s_probe: shouldLoopProbe,
    should_loop_30s_monitor: shouldLoopProbe,
    dispatch_found: lastDispatchIndex !== -1,
    dispatch_step_index: lastDispatchIndex,
    last_dispatch_step: lastDispatchStep,
    recent_trajectory: recentTrajectory,
    model_steps_count: modelStepsAfterDispatch,
    tool_calls_count: toolCallsCount,
    thinking_steps_count: thinkingStepsCount,
    in_progress_steps_count: inProgressStepsCount,
    latest_model_step: latestModelStep,
    dimensions,
    deep_link: `conversation://${sessionId}`,
    alert_card: alertCard
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let root = '.';
  let brainPath = null;
  let isJson = false;
  let activeWindow = 30;
  let probeDispatchId = null;
  let dumpRecentId = null;
  let tail = 5;
  let baselineTime = null;
  let baselineSize = null;
  let freshWindowSec = 30;
  let skipRpc = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === '--brain-path' && args[i + 1]) {
      brainPath = args[++i];
    } else if (args[i] === '--active-window' && args[i + 1]) {
      activeWindow = parseInt(args[++i], 10) || 30;
    } else if ((args[i] === '--probe-dispatch' || args[i] === '--monitor-dispatch') && args[i + 1]) {
      probeDispatchId = args[++i];
    } else if (args[i] === '--dump-recent' && args[i + 1]) {
      dumpRecentId = args[++i];
    } else if (args[i] === '--tail' && args[i + 1]) {
      tail = parseInt(args[++i], 10) || 5;
    } else if (args[i] === '--baseline-time' && args[i + 1]) {
      baselineTime = args[++i];
    } else if (args[i] === '--baseline-size' && args[i + 1]) {
      baselineSize = parseInt(args[++i], 10);
    } else if (args[i] === '--fresh-window-sec' && args[i + 1]) {
      freshWindowSec = parseInt(args[++i], 10) || 30;
    } else if (args[i] === '--skip-rpc') {
      skipRpc = true;
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: node scripts/inspect_agy_sessions.js [options]`);
      console.log(`Options:`);
      console.log(`  --root <path>               Project root directory (default: .)`);
      console.log(`  --brain-path <path>         Custom AGY brain directory`);
      console.log(`  --active-window <mins>      Minutes to consider a session ACTIVE (default: 30)`);
      console.log(`  --monitor-dispatch <id>     Monitor target session for real MODEL execution post-dispatch (alias: --probe-dispatch)`);
      console.log(`  --probe-dispatch <sess_id>  Alias for --monitor-dispatch`);
      console.log(`  --dump-recent <sess_id>     Introspect recent execution trajectory (thinking, tools, content)`);
      console.log(`  --tail <n>                  Number of recent steps to dump (default: 5)`);
      console.log(`  --baseline-time <iso_or_ms> Dispatch baseline timestamp for freshness calculation`);
      console.log(`  --baseline-size <bytes>     Dispatch baseline transcript size in bytes`);
      console.log(`  --fresh-window-sec <sec>    Window in seconds for fresh step calculation (default: 30)`);
      console.log(`  --skip-rpc                  Skip AgentAPI metadata query`);
      console.log(`  --json                      Output raw JSON instead of table`);
      process.exit(0);
    }
  }

  if (dumpRecentId) {
    const dumpResult = fetchSessionTranscript(dumpRecentId, {
      brainPath,
      tail
    });
    if (isJson) {
      console.log(JSON.stringify(dumpResult, null, 2));
    } else {
      printRecentTrajectory(dumpResult);
    }
    process.exit(0);
  }

  if (probeDispatchId) {
    const probeResult = probeDispatchSession(probeDispatchId, {
      brainPath,
      baselineTime,
      baselineSize,
      freshWindowSec,
      skipRpc
    });
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

module.exports = {
  inspectAgySessions,
  probeDispatchSession,
  formatRelativeTime,
  loadRegistrySessions,
  checkAgentApiRpc,
  fetchSessionTranscript,
  printRecentTrajectory
};
