#!/usr/bin/env node
/**
 * [Hook Script] Inject Session Context (PreInvocation)
 * 
 * Google Antigravity PreInvocation Hook
 * 1. 从 stdin (或环境变量) 获取当前会话 ID (conversationId)
 * 2. 匹配 sessions.json 获取会话基础信息 (是否主会话 / 主题 / ID / 创建时间 / 更新时间 / 关联记忆等)
 * 3. 读取 templates/prompt_templates.json 标准化模板
 * 4. 仅注入属于本 Plugin 范围的会话感知与专属规则 (全部带 [Plugin: task-loop | 前缀)，零污染全局外部规范
 * 
 * Input: stdin JSON ({ conversationId, workspacePaths, modelName, invocationNum, ... })
 * Output: stdout JSON ({ injectSteps: [{ ephemeralMessage: "..." }] })
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

function resolveWorkspaceRoot(workspacePaths) {
  if (Array.isArray(workspacePaths) && workspacePaths.length > 0) {
    return workspacePaths[0];
  }
  return process.cwd();
}

function findSessionsRegistry(wsRoot, targetVendor) {
  const candidates = [];
  if (wsRoot) {
    if (targetVendor) {
      candidates.push(path.join(wsRoot, '.agents', 'task-loop', `sessions.${targetVendor}.json`));
    }
    candidates.push(
      path.join(wsRoot, '.agents', 'task-loop', 'sessions.json'),
      path.join(wsRoot, '.agents', 'sessions.json')
    );
  }
  if (process.cwd() && process.cwd() !== wsRoot) {
    if (targetVendor) {
      candidates.push(path.join(process.cwd(), '.agents', 'task-loop', `sessions.${targetVendor}.json`));
    }
    candidates.push(
      path.join(process.cwd(), '.agents', 'task-loop', 'sessions.json'),
      path.join(process.cwd(), '.agents', 'sessions.json')
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        return JSON.parse(raw);
      } catch {
        // ignore parse error
      }
    }
  }
  return null;
}

function findPromptTemplates(wsRoot) {
  const tplPath = path.join(wsRoot, '.agents', 'task-loop', 'prompt-templates.json');
  if (fs.existsSync(tplPath)) {
    try {
      return JSON.parse(fs.readFileSync(tplPath, 'utf8'));
    } catch {}
  }
  return null;
}

function findActiveTodo(wsRoot, conversationId) {
  const todoPath = path.join(wsRoot, '.agents', 'task-loop', 'todo.json');
  if (fs.existsSync(todoPath)) {
    try {
      const todoData = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
      if (Array.isArray(todoData.items)) {
        return todoData.items.find(item => item.assignee_thread_id === conversationId && item.status === 'in_progress') || null;
      }
    } catch {}
  }
  return null;
}

function matchInVendorData(conversationId, data) {
  if (!data || typeof data !== 'object') {
    return {
      session_id: conversationId,
      is_main: false,
      is_unregistered: true,
      title: '未注册会话 (Unregistered Session)',
      module_key: 'unknown',
      created_at: null,
      last_active_at: null,
      summary: null,
      memory_docs: []
    };
  }

  const isMain = (data.main_thread_id === conversationId);
  let sessionItem = null;

  if (Array.isArray(data.sessions)) {
    sessionItem = data.sessions.find(s => s.session_id === conversationId);
  }

  let moduleKey = null;
  let moduleMemDocs = [];

  if (data.modules) {
    for (const [key, val] of Object.entries(data.modules)) {
      if (val && typeof val === 'object' && val.session_id === conversationId) {
        moduleKey = key;
        if (val.memory_doc) {
          moduleMemDocs.push(val.memory_doc);
        } else if (Array.isArray(val.memory_docs)) {
          moduleMemDocs.push(...val.memory_docs);
        }
        break;
      }
    }
  }

  const isRegistered = Boolean(isMain || sessionItem || moduleKey);

  if (!isRegistered) {
    return {
      session_id: conversationId,
      is_main: false,
      is_unregistered: true,
      title: '未注册会话 (Unregistered Session)',
      module_key: 'unknown',
      created_at: null,
      last_active_at: null,
      summary: null,
      memory_docs: []
    };
  }

  const finalIsMain = sessionItem ? (sessionItem.is_main || isMain) : isMain;
  let memoryDocs = (sessionItem && Array.isArray(sessionItem.memory_docs) && sessionItem.memory_docs.length > 0)
    ? sessionItem.memory_docs
    : moduleMemDocs;

  if (finalIsMain && memoryDocs.length === 0) {
    memoryDocs = ['docs/MEMORY.md'];
  }

  return {
    session_id: conversationId,
    is_main: finalIsMain,
    is_unregistered: false,
    title: sessionItem ? sessionItem.title : (isMain ? '[主会话] 任务编排 & 治理中枢' : '专题会话'),
    module_key: moduleKey || (isMain ? 'main' : 'unknown'),
    created_at: sessionItem ? sessionItem.created_at : null,
    last_active_at: sessionItem ? sessionItem.last_active_at : null,
    summary: (sessionItem && sessionItem.summary) || (moduleKey ? `专题模块: ${moduleKey}` : null),
    memory_docs: memoryDocs
  };
}

/**
 * 匹配 sessions.json (或 sessions.<vendor>.json) 解析会话详细属性
 * 支持 Schema v3 vendors 命名空间分区检索与跨分区自适应回退
 */
function getSessionDetails(conversationId, sessionData, targetVendor) {
  if (!sessionData) {
    return {
      session_id: conversationId,
      is_main: false,
      is_unregistered: true,
      title: '未注册会话 (Unregistered Session)',
      module_key: 'unknown',
      created_at: null,
      last_active_at: null,
      summary: null,
      memory_docs: []
    };
  }

  // 1. 如果包含 vendors 分区 (Schema v3)
  if (sessionData.vendors && typeof sessionData.vendors === 'object') {
    if (targetVendor && sessionData.vendors[targetVendor]) {
      const vDetails = matchInVendorData(conversationId, sessionData.vendors[targetVendor]);
      if (!vDetails.is_unregistered) {
        return vDetails;
      }
    }
    // 跨所有 vendor 分区匹配
    for (const [vKey, vData] of Object.entries(sessionData.vendors)) {
      if (vKey === targetVendor) continue;
      const vDetails = matchInVendorData(conversationId, vData);
      if (!vDetails.is_unregistered) {
        return vDetails;
      }
    }
  }

  // 2. 顶层单厂商匹配 (Schema v2 或当前 vendor 顶层数据)
  return matchInVendorData(conversationId, sessionData);
}

/**
 * 获取插件专题专属规则 (全部统一带 [Plugin: task-loop | 前缀)
 */
function getPluginTopicRules(details, templates) {
  const pluginRules = (templates && templates.plugin_rules) || (templates && templates.rules) || {};
  const lines = [];

  if (details.is_unregistered) {
    lines.push(`- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。若需作为主治理中枢，可运行 /init 进行初始化。`);
    return lines;
  }

  if (details.is_main) {
    if (Array.isArray(pluginRules.main_session) && pluginRules.main_session.length > 0) {
      lines.push(...pluginRules.main_session);
    } else {
      lines.push(`- [Plugin: task-loop | 主会话定位与治理硬约束]:`);
      lines.push(`  1. 仅限只读探索 (Explore Only): 主会话仅限执行需求初加工、只读探测与架构诊断 (EXPLORE)，严禁主会话自身直接执行修改落地 (WORK) 或直接编辑业务代码;`);
      lines.push(`  2. 强制派单执行 (Mandatory Delegation): 所有具体的业务代码修改、功能落地与 BugFix (WORK) 强制要求派单至对应的专题会话 (Topic Session) 实施，杜绝主会话分散多方写入造成的上下文错乱与业务冲突;`);
      lines.push(`  3. 需求定界与白名单: 提炼单一职责目标、验收准则与严格的物理白名单 (Allowlist)，明确任务类型 ([EXPLORE] 或 [WORK]);`);
      lines.push(`  4. 防冲突与复用: 派发前强制比对现有专题清单 (modules/tags/docs/memory)，复用优先，严禁重复创建重叠专题;`);
      lines.push(`  5. 缺失专题与不明确流转铁律: 若无可用专题会话或不清楚如何新建/请求会话，必须先查阅文档指导 (references/sdk/README.md, skills/new-session/SKILL.md, skills/session-control/SKILL.md)，若仍需确认必须主动向用户请求指引并询问，绝对禁止主会话自主擅自派遣子代理 Worker 逃避专题治理;`);
      lines.push(`  6. 任务派单流转: 寻找专题 -> 没有则按规范创建顶层专题会话 -> send_message 定向发信，划定 Allowlist 物理白名单;`);
      lines.push(`  7. 复杂度分级调度: Level 1 就地派单，Level 2 标准派单自测，Level 3 临时 Subagent 并行协作;`);
      lines.push(`  8. 质检与门禁核验: 依据子会话测试结果与 Evidence 严格验收，输出用户验证指引卡 (参考 references/dispatch-contract.md 与 skills/task-loop/SKILL.md)。`);
    }
  } else if (details.module_key === 'session_control') {
    if (Array.isArray(pluginRules.session_control) && pluginRules.session_control.length > 0) {
      lines.push(...pluginRules.session_control);
    } else {
      lines.push(`- [Plugin: task-loop | 会话控制专题规则]:`);
      lines.push(`  1. 职责范围: 负责跨厂商会话日志反向内省与 SessionProvider 六大标准原语实现与维护;`);
      lines.push(`  2. 拓扑与受控记忆: 严守只读安全，维护 .agents/task-loop/sessions.json 与受控记忆 docs/memory/session_control.md。`);
    }
  } else if (details.module_key === 'subagent') {
    if (Array.isArray(pluginRules.subagent) && pluginRules.subagent.length > 0) {
      lines.push(...pluginRules.subagent);
    } else {
      lines.push(`- [Plugin: task-loop | 子代理专题规则]:`);
      lines.push(`  1. 职责范围: 负责 AGY 原生子代理编排原语 (invoke/define/manage) 治理与 Workspace 隔离模式;`);
      lines.push(`  2. 原生兜底工作流: 简单任务直接就地改动闭环；复杂未知任务开启 explore + worker + viewer 三角色子代理协作 (各类型建议不超过3个);`);
      lines.push(`  3. 短路迭代与异常中断: 审查未通过直接让 worker 改动 (避免二次长链路重新 explore); worker 中途发现意外/异常须立即停止并反馈专题会话统筹 (参考 references/default-fallback-workflow.md);`);
      lines.push(`  4. 协作与生命周期: 严格遵循响应式唤醒 (Reactive Wakeup，严禁轮询) 与瞬态代理 vs 持久根会话边界，维护 docs/memory/subagent.md。`);
    }
  } else if (details.module_key === 'hook') {
    if (Array.isArray(pluginRules.hook) && pluginRules.hook.length > 0) {
      lines.push(...pluginRules.hook);
    } else {
      lines.push(`- [Plugin: task-loop | 钩子专题规则]:`);
      lines.push(`  1. 职责范围: 负责 AGY 五大生命周期钩子系统维护 (PreInvocation 瞬态注入 / PreToolUse 白名单硬门禁 / PostToolUse / PostInvocation / Stop);`);
      lines.push(`  2. 协议与输出约束: 严守 ephemeralMessage 瞬态注入防历史污染、stdout 纯净输出与 camelCase 命名，维护 docs/memory/hook.md。`);
    }
  } else {
    if (Array.isArray(pluginRules.generic_topic) && pluginRules.generic_topic.length > 0) {
      lines.push(...pluginRules.generic_topic);
    } else {
      lines.push(`- [Plugin: task-loop | 专题会话约束规则]:`);
      lines.push(`  1. 领域攻坚与闭环: 负责所属领域专业排查与代码实施，严守任务 Allowlist 物理白名单;`);
      lines.push(`  2. 兜底执行工作流: 简单目标直接改动；复杂目标调度 explore -> worker -> viewer，评判失败直接 worker 改动，中途遇异常立即停下反馈专题统筹 (参考 references/default-fallback-workflow.md);`);
      lines.push(`  3. 标准执行流程: 承接锁定 -> 边界实施 -> 本地自测 (单测 Exit Code 0) -> 记忆沉淀 (docs/memory/*.md) -> 标准结构化交付。`);
    }
  }

  // 检查是否手动开启 Hook 提示词 dump 调试开关 (默认 false)
  const isHookDumpEnabled = (process.env.ENABLE_HOOK_PROMPT_DUMP === 'true') || 
                            (templates && templates.enable_footer_hook_dump === true);
  if (isHookDumpEnabled) {
    lines.push(`- [Plugin: task-loop | 尾部声明约束]: 在回复结尾除列出【引用规则与记忆文档】外，还须列出当轮【触发的 Hook 提示词】清单 (仅限 [Plugin: task-loop | 开头的实际 Hook 注入项，每项超 50 字截断并加 '...' 省略)。`);
  }

  return lines;
}

/**
 * 构造瞬态注入上下文内容 (100% 纯粹属于 [Plugin: task-loop | 命名空间)
 */
function generateInjectionMessage(conversationId, sessionData, activeTodo, templates, vendor) {
  const details = getSessionDetails(conversationId, sessionData, vendor);
  const parts = [];

  const headerNamespace = (templates && templates.header_namespace) || (templates && templates.plugin_namespace) || '[Plugin: task-loop | 会话上下文感知]';
  parts.push(headerNamespace);
  parts.push(`- 会话 ID: ${details.session_id}`);
  
  if (details.is_unregistered) {
    parts.push(`- 是否主会话: 待定 (Unregistered)`);
  } else {
    parts.push(`- 是否主会话: ${details.is_main ? '是 (Main Thread)' : '否 (Topic Session)'}`);
  }
  parts.push(`- 专题主题: ${details.title}`);

  if (!details.is_unregistered && details.module_key && details.module_key !== 'unknown') {
    parts.push(`- 所属模块: ${details.module_key}`);
  }
  if (details.created_at) {
    parts.push(`- 创建时间: ${details.created_at}`);
  }
  if (details.last_active_at) {
    parts.push(`- 最近更新: ${details.last_active_at}`);
  }

  if (details.is_unregistered) {
    parts.push(`- 角色定位: [待定 / 初始会话]`);
  } else if (details.is_main) {
    parts.push(`- 角色定位: [主会话 / 治理中枢]`);
  } else {
    parts.push(`- 角色定位: [专题会话 / 领域负责人]`);
    if (details.summary) {
      parts.push(`- 专题概述: ${details.summary}`);
    }
  }

  if (Array.isArray(details.memory_docs) && details.memory_docs.length > 0) {
    parts.push(`- 关联记忆文档: ${details.memory_docs.join(', ')}`);
  }

  if (activeTodo) {
    parts.push(`- 当前指派任务 [${activeTodo.id || 'Task'}]: ${activeTodo.title || ''}`);
    if (Array.isArray(activeTodo.allowlist) && activeTodo.allowlist.length > 0) {
      parts.push(`- 物理文件白名单 (Allowlist): [${activeTodo.allowlist.join(', ')}]`);
    }
    if (activeTodo.complexity) {
      parts.push(`- 任务复杂度: Level ${activeTodo.complexity}`);
    }
  }

  // 专属专题规则与约束 (全部带有 [Plugin: task-loop | 前缀)
  parts.push(...getPluginTopicRules(details, templates));

  return parts.join('\n');
}

function processPayload(payload) {
  try {
    let conversationId = payload.conversationId;

    if (!conversationId && process.env.ANTIGRAVITY_CONVERSATION_ID) {
      conversationId = process.env.ANTIGRAVITY_CONVERSATION_ID;
    }

    if (!conversationId) {
      return { injectSteps: [] };
    }

    // 避免工作区插件与全局用户插件同时触发 PreInvocation 产生重复注入 (只要非测试模式即执行 2000ms 独占排他去重)
    const shouldDedupe = !payload.isTest && !payload.skipDedupe;

    if (shouldDedupe) {
      const dedupeLock = path.join(os.tmpdir(), `.task-loop-hook-${conversationId || 'default'}.lock`);
      try {
        let acquired = false;
        try {
          const fd = fs.openSync(dedupeLock, 'wx');
          fs.writeSync(fd, String(Date.now()));
          fs.closeSync(fd);
          acquired = true;
        } catch (err) {
          if (err.code === 'EEXIST') {
            let stats;
            try { stats = fs.statSync(dedupeLock); } catch (_) {}
            const mtime = stats ? stats.mtimeMs : 0;
            if (Date.now() - mtime < 2000) {
              return { injectSteps: [] };
            }
            // 锁已过期 (> 2000ms)，尝试原子争抢：先删除旧文件，再以 'wx' 重新创建
            try { fs.unlinkSync(dedupeLock); } catch (_) {}
            try {
              const fd2 = fs.openSync(dedupeLock, 'wx');
              fs.writeSync(fd2, String(Date.now()));
              fs.closeSync(fd2);
              acquired = true;
            } catch (err2) {
              return { injectSteps: [] };
            }
          }
        }
        if (!acquired) {
          return { injectSteps: [] };
        }
      } catch (e) {
        try {
          if (fs.existsSync(dedupeLock) && (Date.now() - fs.statSync(dedupeLock).mtimeMs < 2000)) {
            return { injectSteps: [] };
          }
        } catch (_) {}
      }
    }

    const wsRoot = resolveWorkspaceRoot(payload.workspacePaths);
    const targetVendor = payload.vendor || (process.env.ZCODE_SESSION_ID ? 'zcode' : (process.env.CODEX_THREAD_ID ? 'codex' : 'antigravity'));
    const sessionData = findSessionsRegistry(wsRoot, targetVendor);
    const templates = findPromptTemplates(wsRoot);
    const activeTodo = findActiveTodo(wsRoot, conversationId);

    const ephemeralText = generateInjectionMessage(conversationId, sessionData, activeTodo, templates, targetVendor);

    return {
      injectSteps: [
        {
          ephemeralMessage: ephemeralText
        }
      ]
    };
  } catch (err) {
    return { injectSteps: [] };
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
  normalizePath,
  resolveWorkspaceRoot,
  findSessionsRegistry,
  findPromptTemplates,
  findActiveTodo,
  matchInVendorData,
  getSessionDetails,
  getPluginTopicRules,
  generateInjectionMessage,
  processPayload
};
