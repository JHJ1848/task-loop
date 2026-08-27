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
        return JSON.parse(raw);
      } catch {
        // ignore parse error
      }
    }
  }
  return null;
}

function findPromptTemplates(wsRoot) {
  const candidates = [
    path.join(wsRoot, 'templates', 'prompt_templates.json'),
    path.join(wsRoot, '.agents', 'task-loop', 'templates', 'prompt_templates.json'),
    path.join(__dirname, '..', '..', 'templates', 'prompt_templates.json'),
    path.join(process.cwd(), 'templates', 'prompt_templates.json')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        return JSON.parse(raw);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function findActiveTodo(wsRoot, conversationId) {
  const candidates = [
    path.join(wsRoot, '.agents', 'task-loop', 'todo.json'),
    path.join(process.cwd(), '.agents', 'task-loop', 'todo.json')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.items)) {
          const item = data.items.find(i => 
            i.assignee_thread_id === conversationId && 
            ['in_progress', 'dispatched', 'pending'].includes(i.status)
          );
          if (item) return item;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * 匹配 sessions.json 解析会话详细属性
 */
function getSessionDetails(conversationId, sessionData) {
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

  const isMain = (sessionData.main_thread_id === conversationId);
  let sessionItem = null;

  if (Array.isArray(sessionData.sessions)) {
    sessionItem = sessionData.sessions.find(s => s.session_id === conversationId);
  }

  let moduleKey = null;
  let moduleMemDocs = [];

  if (sessionData.modules) {
    for (const [key, val] of Object.entries(sessionData.modules)) {
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

  return {
    session_id: conversationId,
    is_main: sessionItem ? (sessionItem.is_main || isMain) : isMain,
    is_unregistered: false,
    title: sessionItem ? sessionItem.title : (isMain ? '[主会话] 任务编排 & 治理中枢' : '专题会话'),
    module_key: moduleKey || (isMain ? 'main' : 'unknown'),
    created_at: sessionItem ? sessionItem.created_at : null,
    last_active_at: sessionItem ? sessionItem.last_active_at : null,
    summary: (sessionItem && sessionItem.summary) || (moduleKey ? `专题模块: ${moduleKey}` : null),
    memory_docs: (sessionItem && Array.isArray(sessionItem.memory_docs) && sessionItem.memory_docs.length > 0)
      ? sessionItem.memory_docs
      : moduleMemDocs
  };
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
      lines.push(`- [Plugin: task-loop | 主会话约束规则]:`);
      lines.push(`  1. 职责边界: 主会话严禁参与任何实际业务代码修改，所有代码更改必须派单至对应专题会话;`);
      lines.push(`  2. 需求加工与定界: 理解用户意图，提炼单一职责目标、验收准则与任务类型 ([EXPLORE] 或 [WORK]);`);
      lines.push(`  3. 防冲突与复用: 派发前强制比对现有专题清单 (modules/tags/docs/memory)，复用优先，严禁重复创建重叠专题;`);
      lines.push(`  4. 任务派单流程: 寻找专题 -> 没有则调用 agentapi new-conversation 新建 -> send_message 定向发信，划定 Allowlist 物理白名单;`);
      lines.push(`  5. 复杂度分级调度: Level 1 就地闭环，Level 2 标准派单自测，Level 3 临时 Subagent 并行协作;`);
      lines.push(`  6. 质检与门禁核验: 依据子会话测试与证据验收，输出用户验证指引卡 (参考 references/dispatch-contract.md 与 skills/task-loop/SKILL.md)。`);
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
function generateInjectionMessage(conversationId, sessionData, activeTodo, templates) {
  const details = getSessionDetails(conversationId, sessionData);
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

    const wsRoot = resolveWorkspaceRoot(payload.workspacePaths);
    const sessionData = findSessionsRegistry(wsRoot);
    const templates = findPromptTemplates(wsRoot);
    const activeTodo = findActiveTodo(wsRoot, conversationId);

    const ephemeralText = generateInjectionMessage(conversationId, sessionData, activeTodo, templates);

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
  processPayload,
  getSessionDetails,
  generateInjectionMessage,
  findSessionsRegistry,
  findPromptTemplates,
  findActiveTodo
};
