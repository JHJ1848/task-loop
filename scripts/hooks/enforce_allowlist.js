#!/usr/bin/env node
/**
 * [Hook Script] Enforce Allowlist Guard (PreToolUse)
 * 
 * Google Antigravity PreToolUse Hook
 * Intercepts modifying tools (write_to_file, replace_file_content, etc.),
 * checks whether target file is within the dispatched allowlist.
 * 
 * Input: stdin JSON ({ toolCall: { name, args }, conversationId, workspacePaths, ... })
 * Output: stdout JSON ({ decision: "allow" | "deny", reason?: string })
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function stripUncPrefix(p) {
  if (!p || typeof p !== 'string') return '';
  let str = p;
  if (str.startsWith('\\\\?\\') || str.startsWith('//?/')) {
    str = str.slice(4);
    if (str.toUpperCase().startsWith('UNC\\') || str.toUpperCase().startsWith('UNC/')) {
      str = '\\\\' + str.slice(4);
    }
  }
  return str;
}

function normalizePath(p) {
  if (!p) return '';
  let cleaned = stripUncPrefix(p);
  cleaned = path.normalize(cleaned).replace(/\\/g, '/');
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
    cleaned = cleaned.toLowerCase();
  }
  return cleaned;
}

function resolveRealPathSafely(p) {
  if (!p) return '';
  const absPath = path.resolve(stripUncPrefix(p));
  try {
    if (fs.existsSync(absPath)) {
      return fs.realpathSync(absPath);
    }
    let curr = absPath;
    const missingSegments = [];
    while (curr && curr !== path.dirname(curr)) {
      missingSegments.unshift(path.basename(curr));
      curr = path.dirname(curr);
      if (fs.existsSync(curr)) {
        const realParent = fs.realpathSync(curr);
        return path.join(realParent, ...missingSegments);
      }
    }
  } catch (_) {}
  return absPath;
}

function isPathInside(candidate, parent) {
  if (!candidate || !parent) return false;
  const absParent = path.resolve(stripUncPrefix(parent));
  const absCandidate = path.resolve(stripUncPrefix(candidate));

  let p1 = absParent;
  let p2 = absCandidate;
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(p1) || /^[a-zA-Z]:/.test(p2)) {
    p1 = p1.toLowerCase();
    p2 = p2.toLowerCase();
  }

  const rel = path.relative(p1, p2);
  if (rel === '') return true;

  const isOutside = rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    path.isAbsolute(rel);

  return !isOutside;
}

const DEFAULT_VENDOR_ALIASES = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  zcode: 'zcode',
  'z-code': 'zcode',
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude'
};

function loadVendorAliasesContract() {
  const roots = [
    path.resolve(__dirname, '..', '..'),
    process.cwd()
  ];
  for (const r of roots) {
    const p = path.join(r, 'contracts', 'vendor-aliases.json');
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (raw && typeof raw.aliases === 'object') {
          return Object.freeze(Object.assign({}, DEFAULT_VENDOR_ALIASES, raw.aliases));
        }
      } catch (_) {}
    }
  }
  return Object.freeze(Object.assign({}, DEFAULT_VENDOR_ALIASES));
}

const VENDOR_ALIASES = loadVendorAliasesContract();

function normalizeVendor(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return VENDOR_ALIASES[key] || (/^[a-z][a-z0-9_-]{0,31}$/.test(key) ? key : null);
}

function resolveWorkspaceRoot(workspacePaths) {
  if (Array.isArray(workspacePaths) && workspacePaths.length > 0) {
    return workspacePaths[0];
  }
  return process.cwd();
}

function extractTargetFile(toolName, args) {
  if (!args || typeof args !== 'object') return null;

  const writeTools = [
    // Antigravity native file-modification tools
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'create_file',
    'edit_file',
    'delete_file',
    // ZCode / Claude-Code-style file-modification tools
    'write',
    'edit',
    'multiedit',
    'notebookedit'
  ];

  if (!writeTools.includes(toolName.toLowerCase())) {
    return null;
  }

  return args.TargetFile || args.FilePath || args.target_file || args.target_path || args.path || null;
}

function findAllowlistForSession(wsRoot, conversationId) {
  // 1. 检查环境变量
  if (process.env.TASK_LOOP_ALLOWLIST) {
    try {
      const parsed = JSON.parse(process.env.TASK_LOOP_ALLOWLIST);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      const parts = process.env.TASK_LOOP_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    }
  }

  // 2. 检查 todo.json
  const todoCandidates = [
    path.join(wsRoot, '.agents', 'task-loop', 'todo.json'),
    path.join(process.cwd(), '.agents', 'task-loop', 'todo.json')
  ];

  for (const c of todoCandidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.items)) {
          const item = data.items.find(i => 
            (!conversationId || i.assignee_thread_id === conversationId) &&
            ['in_progress', 'dispatched', 'pending'].includes(i.status)
          );
          if (item && Array.isArray(item.allowlist) && item.allowlist.length > 0) {
            return item.allowlist;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 3. 检查 dispatch/*.json 包
  const dispatchDirs = [
    path.join(wsRoot, '.agents', 'task-loop', 'dispatch'),
    path.join(process.cwd(), '.agents', 'task-loop', 'dispatch')
  ];

  for (const d of dispatchDirs) {
    if (fs.existsSync(d)) {
      try {
        const files = fs.readdirSync(d);
        for (const f of files) {
          if (f.endsWith('.json')) {
            const p = path.join(d, f);
            const raw = fs.readFileSync(p, 'utf8');
            const pkt = JSON.parse(raw);
            if (!conversationId || pkt.target_thread_id === conversationId) {
              if (Array.isArray(pkt.allowlist) && pkt.allowlist.length > 0) {
                return pkt.allowlist;
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function isExemptPath(normTarget, normWsRoot) {
  if (!normTarget) return false;
  // Inside the workspace, only specific subdirectories are exempt
  if (normWsRoot && isPathInside(normTarget, normWsRoot)) {
    const wsExemptPrefixes = [
      path.join(normWsRoot, 'docs'),
      path.join(normWsRoot, 'scratch'),
      path.join(normWsRoot, '.agents', 'task-loop')
    ];
    for (const p of wsExemptPrefixes) {
      if (isPathInside(normTarget, p)) return true;
    }
    return false;
  }

  // Outside the workspace: allow OS tempdir, brain, Desktop
  const outsideExemptPrefixes = [
    os.tmpdir(),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), 'Desktop')
  ];
  for (const p of outsideExemptPrefixes) {
    if (isPathInside(normTarget, p)) return true;
  }
  return false;
}

function isPathAllowed(targetFile, allowlist, wsRoot) {
  if (!targetFile || !Array.isArray(allowlist)) return false;

  const rawWsRoot = resolveWorkspaceRoot([wsRoot]);
  const absTarget = path.isAbsolute(targetFile) ? path.resolve(stripUncPrefix(targetFile)) : path.resolve(rawWsRoot, stripUncPrefix(targetFile));
  const realTarget = resolveRealPathSafely(absTarget);

  // 1. 豁免路径直接放行 (Desktop, docs, scratch, temp, brain, task-loop state)
  // 逻辑路径与真实路径必须均在豁免范围内，防御符号链接逃逸
  if (isExemptPath(absTarget, rawWsRoot) && isExemptPath(realTarget, rawWsRoot)) {
    return true;
  }

  for (const entry of allowlist) {
    if (entry === '*') return true;
    let cleanEntry = entry;
    if (cleanEntry.endsWith('/**')) cleanEntry = cleanEntry.slice(0, -3);
    else if (cleanEntry.endsWith('/*')) cleanEntry = cleanEntry.slice(0, -2);

    const absEntry = path.isAbsolute(cleanEntry) ? path.resolve(stripUncPrefix(cleanEntry)) : path.resolve(rawWsRoot, stripUncPrefix(cleanEntry));
    const realEntry = resolveRealPathSafely(absEntry);

    // 逻辑路径与真实路径双重严格子路径校验，防止前缀碰撞与软链接逃逸
    const isLogicalInside = isPathInside(absTarget, absEntry);
    const isRealInside = isPathInside(realTarget, realEntry);

    if (isLogicalInside && isRealInside) {
      return true;
    }
  }

  return false;
}

function findSessionsRegistry(wsRoot, targetVendor) {
  const candidates = [];
  const vendor = normalizeVendor(targetVendor);
  if (vendor) {
    candidates.push(path.join(wsRoot, '.agents', 'task-loop', `sessions.${vendor}.json`));
  }
  candidates.push(
    path.join(wsRoot, '.agents', 'task-loop', 'sessions.json'),
    path.join(wsRoot, '.agents', 'sessions.json')
  );
  if (process.cwd() && process.cwd() !== wsRoot) {
    if (vendor) {
      candidates.push(path.join(process.cwd(), '.agents', 'task-loop', `sessions.${vendor}.json`));
    }
    candidates.push(path.join(process.cwd(), '.agents', 'task-loop', 'sessions.json'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        return JSON.parse(raw);
      } catch {}
    }
  }
  return null;
}

function isGovernanceOrStateFile(normTarget, normWsRoot) {
  if (!normTarget) return false;
  const absWsRoot = normWsRoot || process.cwd();

  // 允许主会话维护状态机、治理规则、受控记忆、插件定义与临时派单文件
  const allowedPrefixes = [
    path.join(absWsRoot, '.agents'),
    path.join(absWsRoot, 'docs'),
    path.join(absWsRoot, 'rules'),
    path.join(absWsRoot, 'templates'),
    path.join(absWsRoot, 'references'),
    path.join(absWsRoot, 'config'),
    os.tmpdir(),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain')
  ];

  for (const p of allowedPrefixes) {
    if (isPathInside(normTarget, p)) return true;
  }

  const allowedExactFiles = [
    path.join(absWsRoot, 'AGENTS.md'),
    path.join(absWsRoot, '.gitignore'),
    path.join(absWsRoot, 'plugin.json'),
    path.join(absWsRoot, 'hooks.json'),
    path.join(absWsRoot, 'SKILL.md')
  ];

  for (const f of allowedExactFiles) {
    if (isPathInside(normTarget, f)) return true;
  }

  return false;
}

function getVendorData(sessionData, vendor) {
  if (!sessionData || !vendor) return null;
  if (sessionData.vendors && typeof sessionData.vendors === 'object') return sessionData.vendors[vendor] || null;
  return vendor === 'antigravity' ? sessionData : null;
}

function checkIsMainSession(sessionData, conversationId, vendor) {
  if (!sessionData || !conversationId) return false;
  const vendorData = getVendorData(sessionData, vendor);
  return Boolean(vendorData && (vendorData.main_thread_id === conversationId ||
    (Array.isArray(vendorData.sessions) && vendorData.sessions.some(s => s && s.session_id === conversationId && s.is_main))));
}

function detectVendor(conversationId, explicitVendor) {
  if (explicitVendor) return normalizeVendor(explicitVendor);
  if (process.env.CODEX_THREAD_ID && (!conversationId || process.env.CODEX_THREAD_ID === conversationId)) return 'codex';
  if (process.env.CODEX_SESSION_ID && (!conversationId || process.env.CODEX_SESSION_ID === conversationId)) return 'codex';
  if (process.env.ZCODE_SESSION_ID && (!conversationId || process.env.ZCODE_SESSION_ID === conversationId)) return 'zcode';
  if (conversationId && process.env.ANTIGRAVITY_CONVERSATION_ID === conversationId) return 'antigravity';
  if (typeof conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  if (typeof conversationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) return 'antigravity';
  return null;
}

function isRegisteredForVendor(sessionData, conversationId, vendor) {
  if (!sessionData || !conversationId || !vendor) return false;
  const vendorData = getVendorData(sessionData, vendor);
  if (!vendorData || typeof vendorData !== 'object') return false;
  if (vendorData.main_thread_id === conversationId) return true;
  if (Array.isArray(vendorData.sessions) && vendorData.sessions.some(s => s && s.session_id === conversationId)) return true;
  if (vendorData.modules && typeof vendorData.modules === 'object') {
    return Object.values(vendorData.modules).some(s => s && s.session_id === conversationId);
  }
  return false;
}

function extractMainThreadId(sessionData, vendor) {
  const vendorData = getVendorData(sessionData, vendor);
  return vendorData && vendorData.main_thread_id ? vendorData.main_thread_id : null;
}

function processPayload(payload) {
  try {
    const toolCall = payload.toolCall;
    if (!toolCall || typeof toolCall !== 'object') {
      return { decision: 'allow' };
    }

    const toolName = toolCall.name;
    if (!toolName) {
      return { decision: 'allow' };
    }

    const targetFile = extractTargetFile(toolName, toolCall.args);
    if (!targetFile) {
      // 非文件写入工具，放行
      return { decision: 'allow' };
    }

    const wsRoot = resolveWorkspaceRoot(payload.workspacePaths);
    const conversationId = payload.conversationId || payload.conversation_id || payload.sessionId || payload.session_id;
    // 1. 主会话行为硬性红线拦截 (Explore-Only Hard Gate)
    let vendor = detectVendor(conversationId, payload.vendor);
    const sessionData = findSessionsRegistry(wsRoot, vendor);
    if (!payload.vendor && !vendor && conversationId && isRegisteredForVendor(sessionData, conversationId, 'antigravity')) vendor = 'antigravity';
    if (vendor === 'codex') {
      return { decision: 'deny', reason: '[task-loop PreToolUse DENY] Codex automatic file interception is unsupported; use Skills, Provider, and pre-dispatch allowlist validation.' };
    }
    if (!vendor || !['antigravity', 'zcode', 'claude'].includes(vendor)) {
      return { decision: 'deny', reason: `[task-loop PreToolUse DENY] Unknown or missing vendor '${payload.vendor || 'unknown'}' cannot write files.` };
    }
    if (!conversationId) {
      return { decision: 'deny', reason: `[task-loop PreToolUse DENY] Vendor '${vendor}' file writes require a registered session.` };
    }
    if (conversationId && (!vendor || !isRegisteredForVendor(sessionData, conversationId, vendor))) {
      return { decision: 'deny', reason: `[task-loop PreToolUse DENY] Session '${conversationId}' is missing, unregistered, or mismatched for vendor '${vendor || 'unknown'}'.` };
    }
    const isMain = checkIsMainSession(sessionData, conversationId, vendor);

    if (isMain) {
      const normTarget = normalizePath(path.isAbsolute(targetFile) ? targetFile : path.resolve(wsRoot, targetFile));
      const normWsRoot = normalizePath(wsRoot);
      if (!isGovernanceOrStateFile(normTarget, normWsRoot)) {
        return {
          decision: 'deny',
          reason: `[task-loop PreToolUse DENY] 主会话硬性治理红线：主会话仅限只读探索 (Explore Only)，严禁直接修改业务代码 (${targetFile})！所有具体代码实施、功能落地与 BugFix 必须且强制要求派单至专题会话 (Topic Session) 或子代理 (Subagent Worker) 实施，以彻底杜绝多会话并发修改导致的上下文错乱与业务冲突。请先生成派单契约并使用 send_message 或 invoke_subagent 派发。`
        };
      }
      return { decision: 'allow' };
    }

    const allowlist = findAllowlistForSession(wsRoot, conversationId);

    // Any write without a dispatched allowlist is fail-closed.
    if (!allowlist || allowlist.length === 0) {
      return { decision: 'deny', reason: '[task-loop PreToolUse DENY] File writes require a non-empty dispatched allowlist.' };
    }

    const allowed = isPathAllowed(targetFile, allowlist, wsRoot);
    if (!allowed) {
      const mainThreadId = extractMainThreadId(sessionData, vendor) || '<main_thread_id>';
      return {
        decision: 'deny',
        reason: `[task-loop Allowlist Guard] 工具调用被拦截！目标文件 '${targetFile}' 不在当前任务白名单 (Allowlist: [${allowlist.join(', ')}]) 范围内，严禁越界修改！若确需修改此文件，必须向主治理中枢发起标准化白名单扩展申请 (ALLOWLIST_EXPANSION_REQUEST)：\nsend_message('${mainThreadId}', JSON.stringify({\n  "type": "ALLOWLIST_EXPANSION_REQUEST",\n  "target_files": ["${targetFile}"],\n  "reason": "<请在此详细阐述需要修改该文件的理由与影响分析>"\n}, null, 2))`
      };
    }

    return { decision: 'allow' };
  } catch (err) {
    return { decision: 'deny', reason: '[task-loop PreToolUse DENY] File write validation failed.' };
  }
}

function main() {
  let rawInput = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', chunk => {
    rawInput += chunk;
  });

  process.stdin.on('end', () => {
    let payload = {};
    if (rawInput.trim().length > 0) {
      try {
        payload = JSON.parse(rawInput);
      } catch {
        payload = {};
      }
    } else {
      const argIdx = process.argv.indexOf('--payload');
      if (argIdx !== -1 && process.argv[argIdx + 1]) {
        try {
          payload = JSON.parse(process.argv[argIdx + 1]);
        } catch {
          payload = {};
        }
      }
    }

    const result = processPayload(payload);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  processPayload,
  extractTargetFile,
  isPathAllowed,
  findAllowlistForSession,
  detectVendor,
  isRegisteredForVendor,
  isPathInside,
  normalizePath,
  resolveRealPathSafely,
  stripUncPrefix,
  VENDOR_ALIASES
};
