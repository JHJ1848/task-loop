#!/usr/bin/env node
/**
 * [Hook Script] Resolve or Auto-Create Topic Session (PreToolUse)
 * 
 * Google Antigravity PreToolUse Hook for send_message
 * 1. 拦截 send_message 工具调用；
 * 2. 防御检查：若 Recipient 是有效已存在 UUID，直接放行；
 * 3. 别名解析：若 Recipient 为专题别名（如 "hook", "session_control", "subagent"），检查 sessions.json；
 * 4. 幂等复用与防重复创建：若 sessions.json 中已存在该专题的活跃未归档会话，通过 overwrite.Recipient 动态复用；
 * 5. 归档检测：若既有会话已标记归档 (archived: true / status: "archived")，视同已删除，允许重新拉起新专题会话；
 * 6. 自动拉起：调用 agentapi new-conversation 拉起顶层独立会话，登记 sessions.json，并 overwrite 替换；
 * 7. 兜底策略：若拉起失败或环境不支持，安全拦截并输出引导错误信息，杜绝宿主崩溃与误拉起。
 * 
 * Input: stdin JSON ({ toolCall: { name, args: { Recipient, Message } }, conversationId, workspacePaths, ... })
 * Output: stdout JSON ({ decision: "allow" | "deny", reason?: string, overwrite?: { Recipient: string } })
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const KNOWN_TOPICS = {
  'hook': {
    title: '[钩子专题] Hooks体系 & 状态拦截',
    memory_doc: 'docs/memory/hook.md'
  },
  'session_control': {
    title: '[会话专题] SDK接口封装 & 会话管理',
    memory_doc: 'docs/memory/session_control.md'
  },
  'session': {
    alias_for: 'session_control'
  },
  'subagent': {
    title: '[子代理专题] Subagent机制 & 动态模板',
    memory_doc: 'docs/memory/subagent.md'
  },
  'dispatch': {
    title: '[调度专题] 复杂度裁决 & 派单协议',
    memory_doc: 'docs/memory/dispatch.md'
  },
  'memory': {
    title: '[记忆专题] 受控记忆 & 知识沉淀',
    memory_doc: 'docs/MEMORY.md'
  }
};

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function resolveWorkspaceRoot(workspacePaths) {
  if (Array.isArray(workspacePaths) && workspacePaths.length > 0) {
    return workspacePaths[0];
  }
  return process.cwd();
}

function findSessionsRegistry(wsRoot) {
  const candidates = [
    path.join(wsRoot, '.agents', 'task-loop', 'sessions.json'),
    path.join(wsRoot, '.agents', 'sessions.json'),
    path.join(process.cwd(), '.agents', 'task-loop', 'sessions.json')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        return { path: c, data: JSON.parse(raw) };
      } catch {
        // ignore parse error
      }
    }
  }
  return null;
}

function isSessionActive(sessionItem) {
  if (!sessionItem) return false;
  if (sessionItem.archived === true || sessionItem.status === 'archived' || sessionItem.status === 'deleted') {
    return false;
  }
  return true;
}

function findAgentApiBinary() {
  if (process.env.AGENTAPI_PATH && fs.existsSync(process.env.AGENTAPI_PATH)) {
    return process.env.AGENTAPI_PATH;
  }

  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agentapi.exe'),
    path.join(homeDir, '.gemini', 'antigravity', 'bin', 'agentapi'),
    path.join(homeDir, '.antigravity', 'bin', 'agentapi.exe'),
    path.join(homeDir, '.antigravity', 'bin', 'agentapi')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where.exe agentapi' : 'which agentapi';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const firstLine = out.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // ignore
  }

  return null;
}

function normalizeTopicKey(key) {
  if (!key || typeof key !== 'string') return '';
  let cleaned = key.trim().toLowerCase();
  cleaned = cleaned.replace(/^(topic|module):/, '');
  if (KNOWN_TOPICS[cleaned] && KNOWN_TOPICS[cleaned].alias_for) {
    cleaned = KNOWN_TOPICS[cleaned].alias_for;
  }
  return cleaned;
}

function createTopicSessionViaAgentApi(agentApiPath, topicKey, topicMeta) {
  const title = topicMeta.title || `[${topicKey}专题] 领域研发 & 状态治理`;
  const initPrompt = `[${topicKey}专题初始化] 你是 task-loop 项目的【${topicKey}专题负责人】(topic: ${topicKey})。请阅读 ${topicMeta.memory_doc || '相关记忆文档'} 并承接任务。`;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const output = execFileSync(agentApiPath, [
        'new-conversation',
        `--title=${title}`,
        initPrompt
      ], {
        encoding: 'utf8',
        timeout: 8000
      }).trim();

      let newId = null;
      if (UUID_REGEX.test(output)) {
        newId = output;
      } else {
        try {
          const parsed = JSON.parse(output);
          newId = parsed.conversationId || parsed.conversation_id || parsed.id || null;
        } catch {
          const match = output.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
          if (match) {
            newId = match[0];
          }
        }
      }

      if (newId) {
        return { success: true, conversationId: newId, title: title };
      } else {
        lastError = new Error(`未能从 agentapi 输出中提取有效 UUID: ${output}`);
      }
    } catch (err) {
      lastError = err;
    }
  }

  return { success: false, error: (lastError && lastError.message) || '拉起会话超时或执行异常' };
}

function processPayload(payload) {
  try {
    const toolCall = payload.toolCall;
    if (!toolCall || toolCall.name !== 'send_message') {
      return { decision: 'allow' };
    }

    const args = toolCall.args || {};
    const recipient = (args.Recipient || args.recipient || '').trim();

    if (!recipient) {
      return {
        decision: 'deny',
        reason: '[Session Resolver] send_message 缺少必填参数 Recipient。'
      };
    }

    const wsRoot = resolveWorkspaceRoot(payload.workspacePaths);
    const registryObj = findSessionsRegistry(wsRoot);

    // =========================================================================
    // 防御策略 1: 规范 UUID 处理
    // =========================================================================
    if (UUID_REGEX.test(recipient)) {
      if (registryObj) {
        const found = (registryObj.data.sessions || []).find(s => s.session_id === recipient);
        // 如果是已归档会话，提醒用户/调用方
        if (found && !isSessionActive(found)) {
          return {
            decision: 'deny',
            reason: `[Session Resolver] 目标会话 '${recipient}' 已归档 (Archived)。已归档会话不可再接收新消息，请使用专题别名自动拉起新会话。`
          };
        }
      }
      return { decision: 'allow' };
    }

    // =========================================================================
    // 防御策略 2: 专题别名校验与白名单过滤
    // =========================================================================
    const topicKey = normalizeTopicKey(recipient);
    const knownMeta = KNOWN_TOPICS[topicKey];

    let isConfiguredTopic = !!knownMeta;
    if (registryObj && registryObj.data.modules && registryObj.data.modules[topicKey]) {
      isConfiguredTopic = true;
    }

    if (!isConfiguredTopic) {
      return {
        decision: 'deny',
        reason: `[Session Resolver] 拦截未知目标 '${recipient}'！未在已知专题清单中注册。为避免误拉起无用会话，请使用合法专题别名 (如 hook, session_control, subagent) 或直接传入有效会话 UUID。`
      };
    }

    // =========================================================================
    // 防御策略 3: 幂等性与防重复创建（排除已归档会话）
    // =========================================================================
    if (registryObj && registryObj.data.modules && registryObj.data.modules[topicKey]) {
      const modEntry = registryObj.data.modules[topicKey];
      const existingId = modEntry.session_id;
      if (existingId && UUID_REGEX.test(existingId)) {
        // 查找对应 session 对象，验证是否活跃
        const sessionItem = (registryObj.data.sessions || []).find(s => s.session_id === existingId);
        if (isSessionActive(sessionItem) && isSessionActive(modEntry)) {
          return {
            decision: 'allow',
            overwrite: {
              Recipient: existingId
            }
          };
        }
        // 若已归档，则继续往下执行拉起新会话逻辑（已归档视同已删除）
      }
    }

    // 检查 sessions 列表是否有活跃且标题匹配的专题会话
    if (registryObj && Array.isArray(registryObj.data.sessions)) {
      const activeMatched = registryObj.data.sessions.find(s => 
        isSessionActive(s) && (s.title && s.title.toLowerCase().includes(topicKey))
      );
      if (activeMatched && activeMatched.session_id) {
        if (!registryObj.data.modules) registryObj.data.modules = {};
        registryObj.data.modules[topicKey] = {
          session_id: activeMatched.session_id,
          title: activeMatched.title,
          memory_doc: (knownMeta && knownMeta.memory_doc) || `docs/memory/${topicKey}.md`
        };
        try {
          fs.writeFileSync(registryObj.path, JSON.stringify(registryObj.data, null, 2), 'utf8');
        } catch {}

        return {
          decision: 'allow',
          overwrite: {
            Recipient: activeMatched.session_id
          }
        };
      }
    }

    // =========================================================================
    // 自动拉起流程: 调用 agentapi new-conversation
    // =========================================================================
    const agentApiPath = findAgentApiBinary();
    if (!agentApiPath) {
      return {
        decision: 'deny',
        reason: `[Session Resolver] 目标专题 '${topicKey}' 尚未初始化（或旧会话已归档），且当前环境未找到 'agentapi' 工具。请先在终端运行初始化脚本或由主会话使用 invoke_subagent 创建临时子代理。`
      };
    }

    const topicMeta = knownMeta || {
      title: `[${topicKey}专题] 领域研发`,
      memory_doc: `docs/memory/${topicKey}.md`
    };

    const createRes = createTopicSessionViaAgentApi(agentApiPath, topicKey, topicMeta);
    if (!createRes.success) {
      return {
        decision: 'deny',
        reason: `[Session Resolver] 自动拉起专题会话 '${topicKey}' 失败: ${createRes.error}。请检查宿主 agentapi 状态。`
      };
    }

    const newSessionId = createRes.conversationId;

    // 持久化更新 sessions.json
    if (registryObj) {
      if (!registryObj.data.modules) registryObj.data.modules = {};
      registryObj.data.modules[topicKey] = {
        session_id: newSessionId,
        title: createRes.title,
        memory_doc: topicMeta.memory_doc
      };

      if (!Array.isArray(registryObj.data.sessions)) {
        registryObj.data.sessions = [];
      }

      // 若之前有旧的同模块条目，将其标记为 archived
      for (const s of registryObj.data.sessions) {
        if (s.session_id !== newSessionId && s.title && s.title.toLowerCase().includes(topicKey)) {
          s.archived = true;
          s.archived_at = new Date().toISOString();
        }
      }

      registryObj.data.sessions.push({
        session_id: newSessionId,
        vendor: 'antigravity',
        title: createRes.title,
        is_main: false,
        archived: false,
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
        memory_docs: [topicMeta.memory_doc]
      });

      try {
        fs.writeFileSync(registryObj.path, JSON.stringify(registryObj.data, null, 2), 'utf8');
      } catch {
        // ignore write error
      }
    }

    return {
      decision: 'allow',
      overwrite: {
        Recipient: newSessionId
      }
    };
  } catch (err) {
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
  normalizeTopicKey,
  isSessionActive,
  findAgentApiBinary,
  KNOWN_TOPICS
};
