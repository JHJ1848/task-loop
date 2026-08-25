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

function normalizePath(p) {
  if (!p) return '';
  return path.normalize(p).replace(/\\/g, '/').toLowerCase();
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
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'create_file',
    'edit_file',
    'delete_file'
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

function isPathAllowed(targetFile, allowlist, wsRoot) {
  const normTarget = normalizePath(path.isAbsolute(targetFile) ? targetFile : path.resolve(wsRoot, targetFile));
  const normWsRoot = normalizePath(wsRoot);

  // 仅当目标文件在工作区外部且位于系统临时目录/脑区时豁免
  const tempDir = normalizePath(os.tmpdir());
  if (!normTarget.startsWith(normWsRoot) && normTarget.startsWith(tempDir)) {
    return true;
  }

  const brainDir = normalizePath(path.join(os.homedir(), '.gemini', 'antigravity', 'brain'));
  if (normTarget.startsWith(brainDir)) {
    return true;
  }

  for (const entry of allowlist) {
    if (entry === '*') return true;
    let cleanEntry = entry;
    if (cleanEntry.endsWith('/**')) cleanEntry = cleanEntry.slice(0, -3);
    else if (cleanEntry.endsWith('/*')) cleanEntry = cleanEntry.slice(0, -2);

    const absEntry = normalizePath(path.isAbsolute(cleanEntry) ? cleanEntry : path.resolve(wsRoot, cleanEntry));

    if (normTarget === absEntry) return true;

    // 前缀匹配（目录）
    const prefix = absEntry.endsWith('/') ? absEntry : absEntry + '/';
    if (normTarget.startsWith(prefix)) return true;
  }

  return false;
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
    const conversationId = payload.conversationId;

    const allowlist = findAllowlistForSession(wsRoot, conversationId);

    // 如果没有配置白名单，默认放行
    if (!allowlist || allowlist.length === 0) {
      return { decision: 'allow' };
    }

    // 检查是否在白名单内
    const allowed = isPathAllowed(targetFile, allowlist, wsRoot);
    if (!allowed) {
      return {
        decision: 'deny',
        reason: `[task-loop Allowlist Guard] 工具调用被拦截！目标文件 '${targetFile}' 不在当前任务白名单 (Allowlist: [${allowlist.join(', ')}]) 范围内，严禁越界修改！`
      };
    }

    return { decision: 'allow' };
  } catch (err) {
    // 降级保护：发生异常时安全放行
    return { decision: 'allow' };
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
  findAllowlistForSession
};
