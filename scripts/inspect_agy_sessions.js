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

if (require.main === module) {
  const args = process.argv.slice(2);
  let root = '.';
  let brainPath = null;
  let isJson = false;
  let activeWindow = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === '--brain-path' && args[i + 1]) {
      brainPath = args[++i];
    } else if (args[i] === '--active-window' && args[i + 1]) {
      activeWindow = parseInt(args[++i], 10) || 30;
    } else if (args[i] === '--json') {
      isJson = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: node scripts/inspect_agy_sessions.js [options]`);
      console.log(`Options:`);
      console.log(`  --root <path>           Project root directory (default: .)`);
      console.log(`  --brain-path <path>     Custom AGY brain directory`);
      console.log(`  --active-window <mins>  Minutes to consider a session ACTIVE (default: 30)`);
      console.log(`  --json                  Output raw JSON instead of table`);
      process.exit(0);
    }
  }

  const report = inspectAgySessions({ root, brainPath, activeWindow });
  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
}

module.exports = { inspectAgySessions, formatRelativeTime, loadRegistrySessions };
