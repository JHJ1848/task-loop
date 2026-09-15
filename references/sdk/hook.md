# [SDK Hook] 跨厂商 Hook 生命周期、上下文注入与安全拦截解耦规范

本文档定义了 `task-loop` 中跨厂商智能体生命周期钩子（Lifecycle Hooks）的解耦架构与核心规范，聚焦 Google Antigravity、OpenAI Codex 与 Anthropic Claude Code 三大主流厂商，规范化会话元数据感知注入、物理白名单边界拦截与反向审批机制。

---

## 一、Hook 架构设计哲学与解耦原则 (Architecture & Principles)

### 1. 零污染治理原则 (Zero-Pollution Governance)
传统多智能体开发往往要求在用户项目根目录的规则文件（如 `AGENTS.md` / `CLAUDE.md`）中硬编码各专题职责与派单规则。这极易造成项目规则膨胀、脏数据残留与 Git 历史污染。
`task-loop` 确立**零污染 Hook 治理**：
* 用户项目根目录保持干净纯粹；
* 通过宿主原生的生命周期 Hook，在会话启动（`PreInvocation` / `SessionStart`）与用户提示词输入（`UserPromptSubmit`）时，**瞬态动态注入**当前会话所属的专题职责、会话 ID、关联记忆与反向发信契约；
* 注入仅存在于内存上下文流中，不产生任何工作区物理脏文件。

### 2. 最小权限物理拦截原则 (Surgical Boundary & PreToolUse Guard)
在工具执行前（`PreToolUse`），Hook 强制拦截所有文件写操作（`write_to_file`, `replace_file_content` 等），校验目标文件是否严格处于当前任务的物理修改白名单（`allowlist`）中：
* **白名单内**：放行执行（`allow`）；
* **超出白名单**：硬性拦截（`deny`），并自动生成标准化反向审批模板（`ALLOWLIST_EXPANSION_REQUEST`），引导智能体向主治理中枢申请授权，彻底杜绝越界泛化修改与代码污染。

---

## 二、三大厂商 Hook 原语与机制深度对比 (Three Vendors Comparison)

```json
[
  {
    "vendor": "Google Antigravity (AGY)",
    "config_location": "plugins/task-loop/hooks.json",
    "supported_events": [
      "PreInvocation (每轮会话开始前)",
      "PreToolUse (每次工具调用前)"
    ],
    "io_protocol": "CLI 参数或 stdin 传入上下文，stdout 输出结构化 JSON",
    "intercept_mechanism": "通过 stdout 返回 { decision: 'allow' | 'deny', reason: string } 实施拦截",
    "status": "主力支持 (Primary Native)"
  },
  {
    "vendor": "OpenAI Codex",
    "config_location": "skills/ / codex.json 规则引导",
    "supported_events": [
      "Skill 前置引导注入",
      "fail-closed 降级检查"
    ],
    "io_protocol": "Prompt 注入 + 规则门禁",
    "intercept_mechanism": "在工具调用前后通过前置断言与后置 Diff 审计实施闭环门禁",
    "status": "稳定降级适配 (Stable Degradation Adapter)"
  },
  {
    "vendor": "Anthropic Claude Code",
    "config_location": ".claude/settings.json 中的 hooks 数组",
    "supported_events": [
      "UserPromptSubmit",
      "PreToolUse",
      "SessionStart"
    ],
    "io_protocol": "严格通过 stdin 输入 JSON Payload，stdout 输出 additionalContext",
    "intercept_mechanism": "通过进程 Exit Code 2 强行中断非法工具调用并向模型报错",
    "status": "预留适配 (Standard Adapter)"
  }
]
```

### 1. Google Antigravity (AGY) Hook 机制
* **配置文件**：`hooks.json`
* **PreInvocation 事件**：
  - 调度器调用 `scripts/hooks/inject_session_context.js`；
  - 自动根据当前 `conversationId` 匹配 `.agents/task-loop/sessions.json`，提取专题角色、当前任务、Allowlist、关联记忆路径；
  - 瞬态注入系统指令，明确当前角色定位与收尾必发信契约。
* **PreToolUse 事件**：
  - 调度器调用 `scripts/hooks/enforce_allowlist.js`；
  - 提取当前工具名称（`write_to_file`, `replace_file_content`）与目标文件路径；
  - 校验白名单与豁免路径（`docs/`, `scratch/`, 状态机目录等放行）；
  - 若越界，返回 `decision: "deny"` 并附带标准化反向审批申请模板。

### 2. OpenAI Codex 引导与拦截策略
* Codex 当前通过 Skill 引导与运行时参数传递：
  - 在派单时直接将单一职责目标与 Allowlist 写入派单包；
  - 执行端在读取派单包后严格自律，配合后置 Git Diff 审计，一旦超出 Allowlist 即触发自动驳回重修机制。

### 3. Anthropic Claude Code Hook 管道契约
* **配置文件**：`.claude/settings.json`
* **UserPromptSubmit**：
  - 宿主向 hook 脚本标准输入（stdin）传入包含 `.session_id`、`.cwd`、`.prompt` 的 JSON 对象；
  - 脚本输出 `{ "additionalContext": "..." }`，动态附加在人类提示词前。
* **PreToolUse**：
  - 宿主传入即将执行的工具名与参数；
  - 若检测到越界写操作，Hook 脚本直接以退出码 `2` 退出，并将拦截原因写入 stderr，Claude Code 将向模型报告工具执行失败。

---

## 三、Hook 核心数据协议与数据模型 (Hook Protocol Schema)

### 1. PreInvocation 瞬态上下文注入协议

```json
{
  "PreInvocationInput": {
    "type": "object",
    "properties": {
      "conversationId": { "type": "string", "description": "当前会话的全局 UUID" },
      "workspacePaths": { "type": "array", "items": { "type": "string" } },
      "toolCall": { "type": "object", "description": "若为工具拦截则提供当前工具" }
    },
    "required": ["conversationId"]
  },
  "PreInvocationOutput": {
    "type": "object",
    "properties": {
      "system_prompt_addition": { "type": "string", "description": "瞬态追加的系统规则提示" },
      "metadata": {
        "type": "object",
        "properties": {
          "topic_key": { "type": "string" },
          "role": { "type": "string" },
          "is_main_session": { "type": "boolean" },
          "allowlist": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

### 2. PreToolUse 物理拦截与决策协议

```json
{
  "PreToolUseInput": {
    "type": "object",
    "properties": {
      "toolCall": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "args": { "type": "object" }
        },
        "required": ["name", "args"]
      },
      "conversationId": { "type": "string" }
    },
    "required": ["toolCall"]
  },
  "PreToolUseOutput": {
    "type": "object",
    "properties": {
      "decision": { "type": "string", "enum": ["allow", "deny"] },
      "reason": { "type": "string", "description": "当 decision 为 deny 时的详细拦截与引导信息" }
    },
    "required": ["decision"]
  }
}
```

---

## 四、双轨标准库实现方案 (Dual-Runtime Implementation)

为确保在任何离线与容器环境中开箱即用，所有 Hook 实现保持零外部第三方依赖，全面支持 Node.js 18+ 与 Python 3.8+ 双轨。

### 1. Node.js 18+ Hook 实现核心逻辑 (`enforce_allowlist.js`)

```javascript
// scripts/hooks/enforce_allowlist.js 核心逻辑节选
const fs = require('fs');
const path = require('path');

function isPathAllowed(targetFile, allowlist, wsRoot) {
  const normTarget = normalizePath(path.isAbsolute(targetFile) ? targetFile : path.resolve(wsRoot, targetFile));
  const normWsRoot = normalizePath(wsRoot);

  // 1. 豁免路径直接放行 (docs/, scratch/, temp, 状态机目录)
  if (isExemptPath(normTarget, normWsRoot)) {
    return true;
  }

  // 2. 白名单通配或精确匹配
  for (const entry of allowlist) {
    if (entry === '*') return true;
    const normEntry = normalizePath(path.isAbsolute(entry) ? entry : path.resolve(wsRoot, entry));
    if (normTarget === normEntry || normTarget.startsWith(normEntry + '/')) {
      return true;
    }
  }
  return false;
}

// 统一输入流解析与决策输出
function handleHookExecution(stdinPayload) {
  const { toolCall, conversationId, workspacePaths } = stdinPayload;
  const targetFile = extractTargetFile(toolCall.name, toolCall.args);
  if (!targetFile) {
    return { decision: 'allow' };
  }

  const wsRoot = resolveWorkspaceRoot(workspacePaths);
  const allowlist = findAllowlistForSession(wsRoot, conversationId);
  if (!allowlist) {
    // 未锁定白名单则安全放行或降级
    return { decision: 'allow' };
  }

  if (isPathAllowed(targetFile, allowlist, wsRoot)) {
    return { decision: 'allow' };
  }

  // 拦截并出具标准化反向申请模板
  return {
    decision: 'deny',
    reason: `[task-loop Allowlist Guard] 目标文件 '${targetFile}' 超出白名单，已硬性拦截！请向主中枢发起 ALLOWLIST_EXPANSION_REQUEST 申请放行。`
  };
}
```

### 2. Python 3.8+ Hook 实现核心逻辑 (`enforce_allowlist.py`)

```python
# scripts/hooks/enforce_allowlist.py 核心逻辑节选
import sys
import json
import os

def normalize_path(p: str) -> str:
    if not p:
        return ""
    return os.path.normpath(p).replace("\\", "/").lower()

def is_exempt_path(norm_target: str, norm_ws_root: str) -> bool:
    exempt_subdirs = ["docs", "scratch", ".agents/task-loop"]
    for sub in exempt_subdirs:
        prefix = normalize_path(os.path.join(norm_ws_root, sub))
        if norm_target.startswith(prefix):
            return True
    return False

def check_allowlist(target_file: str, allowlist: list, ws_root: str) -> bool:
    norm_target = normalize_path(os.path.abspath(target_file))
    norm_ws = normalize_path(ws_root)
    if is_exempt_path(norm_target, norm_ws):
        return True
    
    for entry in allowlist:
        if entry == "*":
            return True
        norm_entry = normalize_path(os.path.abspath(os.path.join(ws_root, entry)))
        if norm_target == norm_entry or norm_target.startswith(norm_entry + "/"):
            return True
    return False
```

---

## 五、反向审批闭环与开发陷阱 (Gotchas)

1. **[Gotcha 1] 防重入锁与 CI 并发测试竞争**：
   在密集自动化测试中，Hook 管道可能在毫秒级内被多次唤醒。`inject_session_context` 实现具备防重入文件锁机制；在测试用例中调用时必须传递 `{ isTest: true, skipDedupe: true }`，避免因锁竞争导致返回空结果。
2. **[Gotcha 2] Windows 与 Unix 路径规范化**：
   Windows 盘符不区分大小写且包含反斜杠（`\`），在白名单校验前必须统一转换为 Unix 正斜杠（`/`）并转为全小写，杜绝因盘符大小写（`D:` vs `d:`）导致的误拦截。
3. **[Gotcha 3] 豁免路径必须严密划定**：
   临时调试脚本目录（`scratch/`）、受控记忆沉淀目录（`docs/`）以及状态机本身（`.agents/task-loop/`）属于执行过程中的合法操作目标，必须在 Hook 中设置豁免白名单，防止智能体在沉淀记忆或生成自测脚本时被意外阻断。
4. **[Gotcha 4] 反向审批必须由主中枢裁决**：
   执行端被拦截后，严禁私自修改本地代码绕过检查，必须向主会话发信，由主会话在综合评估排他写权限与业务影响后统一放行。
