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
const hostVendor = require('./host_vendor.js');

const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VENDOR_ALIASES = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  zcode: 'zcode',
  'z-code': 'zcode',
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude'
};

function normalizeVendor(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return VENDOR_ALIASES[key] || (/^[a-z][a-z0-9_-]{0,31}$/.test(key) ? key : null);
}

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
  const vendor = normalizeVendor(targetVendor);
  if (wsRoot) {
    if (vendor) {
      candidates.push(path.join(wsRoot, '.agents', 'task-loop', `sessions.${vendor}.json`));
    }
    candidates.push(
      path.join(wsRoot, '.agents', 'task-loop', 'sessions.json'),
      path.join(wsRoot, '.agents', 'sessions.json')
    );
  }
  if (process.cwd() && process.cwd() !== wsRoot) {
    if (vendor) {
      candidates.push(path.join(process.cwd(), '.agents', 'task-loop', `sessions.${vendor}.json`));
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
  const roots = [wsRoot];
  if (process.cwd() && process.cwd() !== wsRoot) {
    roots.push(process.cwd());
  }
  for (const root of roots) {
    const tplPath = path.join(root, 'templates', 'prompt_templates.json');
    if (fs.existsSync(tplPath)) {
      try {
        return JSON.parse(fs.readFileSync(tplPath, 'utf8'));
      } catch {}
    }
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

function detectVendorFromSessionId(sessionId, fallbackVendor) {
  // Session ID shapes are shared or vendor-specific aliases owned by an explicit adapter.
  // The generic AGY hook must never infer ZCode from sess_* or CLAUDE_SESSION_ID.
  return normalizeVendor(fallbackVendor);
}

function resolveTargetVendor(payload, conversationId) {
  if (payload && payload.vendor) return normalizeVendor(payload.vendor);
  if (process.env.CODEX_THREAD_ID && (!conversationId || process.env.CODEX_THREAD_ID === conversationId)) return 'codex';
  if (process.env.CODEX_SESSION_ID && (!conversationId || process.env.CODEX_SESSION_ID === conversationId)) return 'codex';
  if (process.env.ZCODE_SESSION_ID && (!conversationId || process.env.ZCODE_SESSION_ID === conversationId)) return 'zcode';
  if (process.env.ANTIGRAVITY_CONVERSATION_ID && (!conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID === conversationId)) return 'antigravity';
  if (typeof conversationId === 'string' && /^sess_/i.test(conversationId)) return null;
  return typeof conversationId === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)
    ? 'antigravity'
    : null;
}

function checkAndAcquireDedupeLock(conversationId) {
  const dedupeLock = path.join(os.tmpdir(), `.task-loop-hook-${conversationId || 'default'}.lock`);
  const now = Date.now();

  try {
    const fd = fs.openSync(dedupeLock, 'wx');
    fs.writeSync(fd, String(now));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        let content = '';
        try { content = fs.readFileSync(dedupeLock, 'utf8').trim(); } catch (_) {}
        const timestamp = parseInt(content, 10);
        if (!isNaN(timestamp)) {
          const age = now - timestamp;
          if (age >= 0 && age < 2000) {
            return false;
          }
        }
        const stats = fs.statSync(dedupeLock);
        if (stats && stats.mtimeMs > 0) {
          const mtimeAge = now - stats.mtimeMs;
          if (mtimeAge >= 0 && mtimeAge < 2000) {
            return false;
          }
        }
        try { fs.unlinkSync(dedupeLock); } catch (_) {}
        const fd2 = fs.openSync(dedupeLock, 'wx');
        fs.writeSync(fd2, String(now));
        fs.closeSync(fd2);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }
}

/**
 * 匹配 sessions.json (或 sessions.<vendor>.json) 解析会话详细属性
 * 支持 Schema v4/v3 vendors 命名空间分区检索与自适应厂商判定
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

  const effectiveVendor = normalizeVendor(targetVendor) || detectVendorFromSessionId(conversationId);

  if (effectiveVendor === 'codex') {
    return {
      session_id: conversationId,
      is_main: false,
      is_unregistered: true,
      title: 'Codex vendor unsupported',
      module_key: 'unknown',
      created_at: null,
      last_active_at: null,
      summary: null,
      memory_docs: []
    };
  }

  // 1. 如果包含 vendors 分区 (Schema v4 / v3)
  if (sessionData.vendors && typeof sessionData.vendors === 'object') {
    const vendorData = effectiveVendor ? sessionData.vendors[effectiveVendor] : null;
    if (vendorData) {
      const vDetails = matchInVendorData(conversationId, vendorData);
      if (!vDetails.is_unregistered) {
        return vDetails;
      }
    }
    return matchInVendorData(conversationId, vendorData);
  }

  // 2. 顶层单厂商匹配 (Schema v2 或当前 vendor 顶层数据)
  return matchInVendorData(conversationId, sessionData);
}

/**
 * 获取插件专题专属规则 (全部统一带 [Plugin: task-loop | 前缀)
 */
function extractMainThreadId(sessionData, targetVendor) {
  if (!sessionData) return null;
  if (sessionData.vendors && typeof sessionData.vendors === 'object') {
    const effectiveVendor = normalizeVendor(targetVendor);
    const vendorData = effectiveVendor ? sessionData.vendors[effectiveVendor] : null;
    return vendorData && vendorData.main_thread_id ? vendorData.main_thread_id : null;
  }
  return sessionData.main_thread_id || null;
}

/**
 * 获取插件专题专属规则 (全部统一带 [Plugin: task-loop | 前缀)
 */
function getPluginTopicRules(details, templates, mainThreadId) {
  const pluginRules = (templates && templates.plugin_rules) || (templates && templates.rules) || {};
  const lines = [];

  if (details.is_unregistered) {
    if (mainThreadId) {
      lines.push(`- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。本项目主治理中枢为 ${mainThreadId}。当前会话严禁执行 /init 初始化或擅自创建专题会话。若需执行任务，请等待主会话派单或向主会话请示。`);
    } else {
      lines.push(`- [Plugin: task-loop | 会话提示]: 当前会话未在 task-loop 状态机中注册。当前项目尚未初始化，可运行 /init 初始化主治理中枢。`);
    }
    return lines;
  }

  if (details.is_main) {
    if (Array.isArray(pluginRules.main_session) && pluginRules.main_session.length > 0) {
      lines.push(...pluginRules.main_session);
    } else {
      lines.push(`- [Plugin: task-loop | 主会话定位与治理硬约束]:`);
      lines.push(`  1. 仅限只读探索 (Explore Only): 主会话仅限执行需求初加工、只读探测与架构诊断 (EXPLORE)，严禁主会话自身直接执行修改落地 (WORK) 或直接编辑业务代码;`);
      lines.push(`  2. 强制 sidebus 派单执行 (Mandatory Sidebus Delegation): 所有具体的业务代码修改、功能落地与 BugFix (WORK) 强制要求通过 sidebus (send_message / agentapi) 派单至对应的专题会话 (Topic Session) 实施，杜绝主会话直接修改或擅自派遣临时 Worker 造成的上下文错乱与业务冲突;`);
      lines.push(`  3. 主会话子代理派遣权限严格受限 (Reviewer & Explorer Only): 主会话严禁派遣 Worker (落地/写代码子代理)，主会话仅限派遣 reviewer (代码审查走查) 与 explorer / research (架构只读探索);`);
      lines.push(`  4. 实体会话与 KV Cache 价值: 主会话与专题会话为长期存在的物理会话实体 (Permanent Physical Session Entities)，常驻 IDE 左侧边栏列表中，存储历史积累并极大提升大模型 Prompt Token Cache (KV Cache) 命中率，大幅降低延迟与成本;`);
      lines.push(`  5. 需求定界与白名单: 提炼单一职责目标、验收准则与严格的物理白名单 (Allowlist)，明确任务类型 ([EXPLORE] 或 [WORK]);`);
      lines.push(`  6. 专题职责正交对齐与严禁跨界污染 (Strict Topic Ownership & Anti-Pollution): 严禁逮着同一个活跃会话持续薅！派单前必须严格根据修改文件的物理路径与领域职责 (如 scripts/hooks 归 hook, providers/session 归 session_control, subagent 归 subagent, install/plugin 归 plugin_spec) 精确路由到法定专题。严禁把无关改动塞入其他专题导致上下文与 KV Cache 污染；若为全新业务需求，必须通过 /new-session 建立独立业务专题;`);
      lines.push(`  7. 缺失专题与不明确流转铁律: 若无可用专题会话或不清楚如何新建/请求会话，必须先查阅文档指导 (references/sdk/README.md, skills/new-session/SKILL.md, skills/session-control/SKILL.md)，若仍需确认必须主动向用户请求指引并询问，绝对禁止主会话自主擅自派遣子代理 Worker 逃避专题治理;`);
      lines.push(`  8. 任务派单流转与权责核验 (Dispatch Workflow & Seam Gate): 寻找专题 -> 没有则按规范创建顶层专题会话 -> 派单前必须在思维链中核验拟下发 Allowlist 物理文件是否 100% 属于目标专题权责 (严禁搭便车派单) -> sidebus (send_message) 定向发信，划定 Allowlist 物理白名单;`);
      lines.push(`  9. 复杂度分级调度: Level 1 就地派单，Level 2 标准派单自测，Level 3 专题会话内 Subagent 并行协作;`);
      lines.push(`  10. 四大绝对门禁与双轮驱动质检 (Dual-Engine Verification & Loop Rejection): 严禁充当传声筒盲目轻信放行！主会话必须严格执行双轮驱动质检与四大绝对门禁：① 门禁1 (原有逻辑破坏防御): 逐行逆向审视 Diff，严禁专题擅自删除或弱化旧有 if 校验、业务门禁、前置条件或提前落盘，发现违规必须下发 DELIVERABLE_REJECTED 驳回重修；② 门禁2 (最小改动自证与注释溯源): 核验《最小改动自证说明》与代码改动原因注释，超出 Allowlist 或无关重构一律驳回；③ 门禁3 (双轮驱动质检与全局风险评估): 执行【轮1: 需求清单逐项逆向比对】(排查遗漏与假交付 GOTCHA-001/003) 与【轮2: 宏观上下文深度质检】(防误伤误改/防分支冲突/推演状态机乱序/边界空值/并发原子性风险)；④ 门禁4 (Loop 闭环仲裁与主动打回): 门禁未 100% 全过时主动打回专题修复，杜绝让用户充当质检员 (参考 references/dispatch-contract.md 与 gotchas.md);`);
      lines.push(`  11. 双阶梯进度监测与动态监督机制 (Dynamic Progress Supervision & Inspection): 派单后挂载 30s 进度监测器 (schedule DurationSeconds=30)。30s 触发时执行 node scripts/inspect_agy_sessions.js --monitor-dispatch <session_id> 检查真活跃 (thread_running/is_working)；定期审视目标专题的思考链 (Thinking) 与工具调用 (Tool Calls)，识别死循环、走弯路或消极退化特征并主动纠偏，杜绝消极挂起。【门禁分流】: ① 若 is_working === false (未见 MODEL 步/未激活)，绝对严禁挂载 120s 巡检任务！必须立即出具【🔴 专题未激活告警卡】、调用 agentapi.bat send-message 补发唤醒，并继续挂载 30s 进度监测器循环监控直至激活；② 仅当确凿返回 is_working === true (检测到线程工作) 时，才准入挂载 120s 巡检任务 (参考 references/dispatch-contract.md 与 gotchas.md)。`);
    }
  } else if (details.module_key === 'session_control') {
    if (Array.isArray(pluginRules.session_control) && pluginRules.session_control.length > 0) {
      lines.push(...pluginRules.session_control);
    } else {
      lines.push(`- [Plugin: task-loop | 会话控制专题规则]:`);
      lines.push(`  1. 职责范围: 负责跨厂商会话日志反向内省与 SessionProvider 六大标准原语实现与维护;`);
      lines.push(`  2. 物理实体会话治理: 维护长期常驻物理会话拓扑与状态机持久化 (.agents/task-loop/sessions.json 与 docs/memory/session_control.md)，保障大模型 KV Cache 高效复用。`);
    }
  } else if (details.module_key === 'subagent') {
    if (Array.isArray(pluginRules.subagent) && pluginRules.subagent.length > 0) {
      lines.push(...pluginRules.subagent);
    } else {
      lines.push(`- [Plugin: task-loop | 子代理专题规则]:`);
      lines.push(`  1. 职责范围: 负责 AGY 原生子代理编排原语 (invoke/define/manage) 治理与 Workspace 隔离模式;`);
      lines.push(`  2. 定位与边界: 子代理 (subagents / workers) 仅为专题会话内部按需临时拉起的轻量隔离沙箱，任务完成后即销毁；主会话禁止派遣 Worker 子代理，仅可派遣 reviewer / explorer;`);
      lines.push(`  3. 智能派遣门槛与防干等: 严禁单子代理串行干等反模式！必须满足并发度 >= 2 (多分支并发加速) 或存在 Workspace='branch' 物理强隔离沙箱需求时才允许派遣子代理，单线任务一律由专题自身直接执行 (参考 references/default-fallback-workflow.md);`);
      lines.push(`  4. 短路迭代与异常中断: 审查未通过直接让 worker 改动 (避免二次长链路重新 explore); worker 中途发现意外/异常须立即停止并反馈专题会话统筹;`);
      lines.push(`  5. 协作与生命周期: 严格遵循响应式唤醒 (Reactive Wakeup，严禁轮询) 与瞬态代理 vs 持久物理实体会话边界，维护 docs/memory/subagent.md。`);
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
      lines.push(`  1. 物理实体与领域深耕: 作为长期常驻 IDE 侧边栏的物理会话实体，持续沉淀领域上下文并最大化大模型 KV Cache 命中率;`);
      lines.push(`  2. 领域攻坚与闭环: 负责所属领域专业排查与代码实施，严守任务 Allowlist 物理白名单;`);
      lines.push(`  3. 专题内子代理协同门槛: 仅在满足并发度 >= 2 (多分支并发加速) 或物理强隔离沙箱时才允许拉起子代理，严禁单子代理串行让专题干等，单线任务一律由专题自身直接实施闭环;`);
      lines.push(`  4. 标准执行与自查流程: 承接锁定 -> 边界实施 (附带代码注释溯源) -> 专题自主语法检查与功能自测 -> 记忆沉淀 (docs/memory/*.md) -> 强制提供包含最小改动自证、注释溯源、原有逻辑自查与自测证据的规范交付物并通过 sidebus 汇报。`);
    }
  }

  // 专题会话收尾强制发信契约注入 (对于所有非主会话的已注册专题会话生效，且目标主会话不能为自身，杜绝自发自收死循环)
  if (!details.is_main) {
    const targetMainId = mainThreadId || '<main_thread_id>';
    if (targetMainId !== details.session_id) {
      lines.push(`- [Plugin: task-loop | 专题强制收尾与反向汇报契约]:`);
      lines.push(`  1. 任务收尾必发信: 当在本专题会话中完成功能开发、修复或自主自测通过后，严禁仅在当前窗口输出文本结束！`);
      lines.push(`  2. 强制调用 send_message: 必须且强制在最后一轮调用 send_message(recipient="${targetMainId}", message="[专题交付: WORK]...") 向主治理中枢汇报包含【核心摘要、最小改动自证、代码注释溯源、原有逻辑审查、改动清单与自主自测证据】的结构化交付报告，触发主会话双轮驱动质检与四大绝对门禁验收！`);
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

function extractSessionId(payload, env) {
  env = env || process.env;
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    (env && env.ANTIGRAVITY_CONVERSATION_ID) ||
    (env && env.CLAUDE_CODE_SESSION_ID) ||
    (env && env.CLAUDE_SESSION_ID) ||
    (env && env.ZCODE_SESSION_ID) ||
    null
  );
}

function resolveWorkspace(payload, env) {
  env = env || process.env;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0) {
    return payload.workspacePaths[0];
  }
  if (payload.cwd && typeof payload.cwd === 'string') {
    return payload.cwd;
  }
  return (
    (env && env.ZCODE_PROJECT_DIR) ||
    (env && env.CLAUDE_PROJECT_DIR) ||
    process.cwd()
  );
}

function extractEventName(payload) {
  const raw = payload.hook_event_name || payload.hookEventName || '';
  if (raw === 'SessionStart' || raw === 'UserPromptSubmit') {
    return raw;
  }
  return 'UserPromptSubmit';
}

/**
 * 动态计算当前会话运行态 (Lifecycle State)
 */
function computeLifecycleState(details, activeTodo) {
  if (activeTodo) {
    const status = activeTodo.status || 'in_progress';
    if (status === 'in_progress' || status === 'dispatched') {
      return {
        label: '[⚡ 工作中 (WORKING)]',
        code: 'WORKING',
        desc: `当前指派任务 [${activeTodo.id || 'Task'}]: ${activeTodo.title || ''}`
      };
    } else if (status === 'rejected') {
      return {
        label: '[⚠️ 质检打回重修中 (REVISING)]',
        code: 'REVISING',
        desc: `任务 [${activeTodo.id || 'Task'}] 被驳回重修，请重点审查驳回清单中的逻辑破坏项`
      };
    } else if (status === 'awaiting_approval') {
      return {
        label: '[⏳ 等待审批中 (AWAITING_APPROVAL)]',
        code: 'AWAITING_APPROVAL',
        desc: `当前正在等待主会话白名单或方案审批`
      };
    } else {
      return {
        label: `[⚡ 任务中 (${status.toUpperCase()})]`,
        code: status.toUpperCase(),
        desc: `当前任务 [${activeTodo.id || 'Task'}]`
      };
    }
  }

  if (details.is_main) {
    return {
      label: '[🧭 治理与调度中 (ORCHESTRATING)]',
      code: 'ORCHESTRATING',
      desc: '作为主治理中枢，仅限只读探索与任务编排，严禁自身修改业务代码'
    };
  }

  if (!details.is_unregistered) {
    return {
      label: '[🟢 空闲待命 (IDLE)]',
      code: 'IDLE',
      desc: '当前无挂起任务，处于待命状态；请等待主会话派单，禁止擅自修改业务代码'
    };
  }

  return {
    label: '[⚪ 未注册 (UNREGISTERED)]',
    code: 'UNREGISTERED',
    desc: '未在 task-loop 状态机中注册'
  };
}

/**
 * 针对主会话计算集群全局态势 (Fleet Overview)
 */
function computeFleetOverview(sessionData, wsRoot, targetVendor) {
  if (!sessionData) return null;
  const effectiveVendor = normalizeVendor(targetVendor);
  let modules = null;
  if (sessionData.vendors && effectiveVendor && sessionData.vendors[effectiveVendor]) {
    modules = sessionData.vendors[effectiveVendor].modules;
  } else if (sessionData.modules) {
    modules = sessionData.modules;
  }
  if (!modules || typeof modules !== 'object') return null;

  const activeTodos = [];
  const todoPath = path.join(wsRoot, '.agents', 'task-loop', 'todo.json');
  if (fs.existsSync(todoPath)) {
    try {
      const todoData = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
      if (Array.isArray(todoData.items)) {
        for (const item of todoData.items) {
          if (['in_progress', 'dispatched'].includes(item.status)) {
            activeTodos.push(item);
          }
        }
      }
    } catch {}
  }

  const parts = [];
  for (const [modKey, modVal] of Object.entries(modules)) {
    if (!modVal || typeof modVal !== 'object') continue;
    const sessId = modVal.session_id;
    const matchedTodo = activeTodos.find(t => t.assignee_thread_id === sessId || t.assignee === modKey);
    if (matchedTodo) {
      parts.push(`${modKey} [⚡ WORKING: ${matchedTodo.id}]`);
    } else {
      parts.push(`${modKey} [🟢 IDLE]`);
    }
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * 构造瞬态注入上下文内容 (100% 纯粹属于 [Plugin: task-loop | 命名空间)
 */
function generateInjectionMessage(conversationId, sessionData, activeTodo, templates, vendor, dynamicContext) {
  dynamicContext = dynamicContext || {};
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

  // 动态运行状态注入
  const lifecycle = computeLifecycleState(details, activeTodo);
  parts.push(`- 运行状态: ${lifecycle.label}`);

  if (dynamicContext.invocationNum !== undefined && dynamicContext.invocationNum !== null) {
    parts.push(`- 交互轮次: 第 ${dynamicContext.invocationNum} 轮推理 (Turn #${dynamicContext.invocationNum})`);
  }

  if (details.is_main) {
    const wsRoot = dynamicContext.wsRoot || resolveWorkspaceRoot([]);
    const fleet = computeFleetOverview(sessionData, wsRoot, vendor);
    if (fleet) {
      parts.push(`- 专题集群态势: ${fleet}`);
    }
  }

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
  } else if (!details.is_main && !details.is_unregistered) {
    parts.push(`- 待命指引: 当前无进行中任务，处于空闲待命状态；请等待主会话派单，严禁擅自修改业务代码。`);
  }

  // 专属专题规则与约束 (全部带有 [Plugin: task-loop | 前缀)
  const mainThreadId = extractMainThreadId(sessionData, vendor);
  parts.push(...getPluginTopicRules(details, templates, mainThreadId));

  return parts.join('\n');
}

function processPayload(payload, env, argv) {
  try {
    env = env || process.env;
    payload = payload || {};
    let conversationId = extractSessionId(payload, env);

    const wsRoot = resolveWorkspace(payload, env);
    const declaredVendor = hostVendor.resolveVendor(payload, env, argv);

    // 协议识别: 若存在 hook_event_name 或 hookEventName 或 CLI 参数含 --event 或 session_id 形如 sess_*，或传入 cwd 且无 workspacePaths，判定为 ZCode/Claude Code 模式
    const isZcodeProtocol = Boolean(
      payload.requested_vendor === 'zcode' ||
      payload.hook_event_name ||
      payload.hookEventName ||
      payload.requested_event ||
      (argv && argv.includes('--event')) ||
      (payload.cwd && !Array.isArray(payload.workspacePaths)) ||
      (env && (env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.ZCODE_SESSION_ID || env.ZCODE_PROJECT_DIR || env.CLAUDE_PROJECT_DIR)) ||
      (conversationId && conversationId.startsWith('sess_')) ||
      declaredVendor === 'zcode' ||
      declaredVendor === 'claude'
    );

    if (isZcodeProtocol) {
      if (!conversationId) return {};
      if (!declaredVendor && !conversationId.startsWith('sess_') && UUID_SESSION_ID.test(conversationId)) {
        return {};
      }
      const vendor = declaredVendor || 'zcode';

      const shouldDedupe = !payload.isTest && !payload.skipDedupe;
      if (shouldDedupe && checkAndAcquireDedupeLock && !checkAndAcquireDedupeLock(conversationId)) {
        return {};
      }

      let eventName = extractEventName(payload);
      if (payload.requested_event === 'SessionStart' || (argv && argv.includes('SessionStart'))) {
        eventName = 'SessionStart';
      }

      const sessionData = findSessionsRegistry(wsRoot, vendor);
      const templates = findPromptTemplates(wsRoot);
      const activeTodo = findActiveTodo(wsRoot, conversationId);

      const dynamicContext = {
        wsRoot,
        invocationNum: payload.invocationNum !== undefined ? payload.invocationNum : (payload.invocation_num !== undefined ? payload.invocation_num : null)
      };

      const additionalContext = generateInjectionMessage(conversationId, sessionData, activeTodo, templates, vendor, dynamicContext);

      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: additionalContext
        },
        suppressOutput: true
      };
    }

    // 默认 AGY 协议
    const targetVendor = resolveTargetVendor(payload, conversationId);
    if (targetVendor === 'codex') {
      return {
        supported: false,
        vendor: 'codex',
        hook: 'PreInvocation',
        status: 'unsupported',
        reasonCode: 'CODEX_AUTOMATIC_HOOK_UNSUPPORTED',
        reason: 'Codex automatic PreInvocation hook is unsupported; no context injection was performed.'
      };
    }

    if (!conversationId && env.ANTIGRAVITY_CONVERSATION_ID) {
      conversationId = env.ANTIGRAVITY_CONVERSATION_ID;
    }

    if (!conversationId || !targetVendor) {
      return { injectSteps: [] };
    }

    // 避免工作区插件与全局用户插件同时触发 PreInvocation 产生重复注入 (只要非测试模式即执行 2000ms 独占排他去重)
    const shouldDedupe = !payload.isTest && !payload.skipDedupe;

    if (shouldDedupe && !checkAndAcquireDedupeLock(conversationId)) {
      return { injectSteps: [] };
    }

    const sessionData = findSessionsRegistry(wsRoot, targetVendor);
    const templates = findPromptTemplates(wsRoot);
    const activeTodo = findActiveTodo(wsRoot, conversationId);

    const dynamicContext = {
      wsRoot,
      invocationNum: payload.invocationNum !== undefined ? payload.invocationNum : (payload.invocation_num !== undefined ? payload.invocation_num : null)
    };

    const ephemeralText = generateInjectionMessage(conversationId, sessionData, activeTodo, templates, targetVendor, dynamicContext);

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

    // CLI --event flag (ZCode compatibility)
    const eventIdx = process.argv.indexOf('--event');
    if (eventIdx !== -1 && process.argv[eventIdx + 1] === 'SessionStart') {
      payload.hook_event_name = payload.hook_event_name || 'SessionStart';
    }

    const result = processPayload(payload, process.env, process.argv);
    if (Object.keys(result).length === 0) {
      return;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizePath,
  resolveWorkspaceRoot,
  resolveWorkspace,
  findSessionsRegistry,
  findPromptTemplates,
  findActiveTodo,
  matchInVendorData,
  detectVendorFromSessionId,
  resolveTargetVendor,
  checkAndAcquireDedupeLock,
  extractMainThreadId,
  extractSessionId,
  extractEventName,
  computeLifecycleState,
  computeFleetOverview,
  getSessionDetails,
  getPluginTopicRules,
  generateInjectionMessage,
  processPayload,
  main
};

