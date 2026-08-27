---
name: new-session
description: "[task-loop] Provisions dedicated top-level root topic sessions from controlled memory documents (docs/memory/*.md). Supports manual targeting of specific memory docs or automatic discovery and creation of missing topic sessions."
---

# New Topic Session Provisioner (`new-session`)

本项目专属技能用于**从受控记忆文档 (`docs/memory/*.md`) 主动读取并建立独立的顶层根会话 (`nestingDepth: 0`)**，支持手动指定特定记忆文档，或自动发现并批量补齐尚未建立会话的专题记忆。

---

## 一、定位与适用场景 (When to Use)

1. **新建全新专题与会话 (用户明确要求或意图新建专题)**:
   * 当用户明确要求新建一个新领域专题（例如：“新建一个质量核验专题”、“创建新专题 mock_quality”）时；
   * 一同创建受控记忆文档 `docs/memory/<module_key>.md`（包含架构架构、物理白名单与已知事实模板）与对应的独立顶层物理根会话（`nestingDepth: 0`）。
2. **手动指定既有专题文档初始化 (Targeted Existing Provisioning)**:
   * 用户指定某个既有记忆文档（如 `docs/memory/quality_inspect.md`）为其拉起专属物理会话；
   * 自动提取其标题、物理白名单与架构事实，生成规范命名（`[专题名称] 核心功能1 & 核心功能2`）并注入初始上下文。
3. **自动发现与批量补齐 (Auto-Discovery Provisioning)**:
   * 用户未指定具体文档且未要求新建专题时，自动扫描 `docs/memory/*.md`；
   * 找出所有尚未建立物理会话的专题文档并批量补齐，杜绝随意捏造无用专题。
4. **顶层根会话规范保障**:
   * 严格净化父级环境变量（清除 `ANTIGRAVITY_CONVERSATION_ID` 等），确保新建会话为真正的 `nestingDepth: 0` 独立根会话，直接在 IDE 左侧边栏呈现。

---

## 二、三模式运行契约规范 (Execution Modes JSON)

```json
[
  {
    "mode": "1. 新建全新专题与会话 (Brand-New Topic & Session)",
    "trigger_condition": "用户明确要求新建专题或指定 --create-topic <key>",
    "command_node": "node scripts/new_topic_session.js --create-topic <key> [--topic-title \"<title>\"]",
    "command_python": "python scripts/new_topic_session.py --create-topic <key> [--topic-title \"<title>\"]",
    "behavior": "自动生成 docs/memory/<key>.md 记忆文档模板，并同步拉起独立顶层根会话并完成持久化绑定。"
  },
  {
    "mode": "2. 手动指定既有专题文档 (Targeted Existing Memory Doc)",
    "trigger_condition": "用户指定已有文档路径或模块 Key",
    "command_node": "node scripts/new_topic_session.js --doc docs/memory/<topic>.md",
    "command_python": "python scripts/new_topic_session.py --doc docs/memory/<topic>.md",
    "behavior": "精准读取目标受控记忆文档，提炼白名单与架构事实，建立顶层会话（若已存在则报告现有会话 ID，支持 --force 重新创建）。"
  },
  {
    "mode": "3. 专题对齐调查与交互确认 (Survey & Interactive Gate)",
    "trigger_condition": "用户仅输入 /new-session 未指定参数时的默认行为",
    "command_node": "node scripts/new_topic_session.js",
    "command_python": "python scripts/new_topic_session.py",
    "behavior": "纯只读扫描 docs/memory/*.md 与 sessions.json，列出已绑定专题与待建会话记忆清单，并向用户提示操作选项，严禁擅自盲创。"
  },
  {
    "mode": "4. 批量补齐全量未建会话 (Batch Provisioning)",
    "trigger_condition": "用户显式要求全量补齐或指定 --all / -y 参数",
    "command_node": "node scripts/new_topic_session.js --all",
    "command_python": "python scripts/new_topic_session.py --all",
    "behavior": "批量为所有未建物理会话的 docs/memory/*.md 建立顶层根会话并更新状态机。"
  }
]
```

---

## 三、命令行参数与选项 (CLI Options JSON)

```json
[
  {
    "option": "--doc <path>",
    "description": "指定单个受控记忆文档的相对或绝对路径 (例如: --doc docs/memory/hook.md)"
  },
  {
    "option": "--topic <module_key>",
    "description": "通过模块 Key 自动推导记忆路径 (例如: --topic hook 等价于 --doc docs/memory/hook.md)"
  },
  {
    "option": "--dry-run, -d",
    "description": "开启预览模式，仅展示拟创建的专题标题与绑定状态，不实际调用 agentapi 创建会话"
  },
  {
    "option": "--force, -f",
    "description": "当专题会话已存在时，强制重新拉起新会话并覆盖 sessions.json 中的绑定记录"
  },
  {
    "option": "--workspace <dir>",
    "description": "指定工作区根目录 (默认为当前工作目录)"
  }
]
```

---

## 四、标准执行流程 (Standard Workflow)

```text
[触发 new-session]
       │
       ├─► 指定了具体文档 (--doc / --topic):
       │     └─► 解析文档 -> 提炼规范标题与白名单 -> 检查 sessions.json -> 创建独立根会话
       │
       └─► 未指定具体文档 (默认自动发现):
             └─► 扫描 docs/memory/*.md -> 筛选缺失项 -> 批量调用 agentapi 创建
       │
       ▼
[原子更新状态机 .agents/task-loop/sessions.json & topics.json]
       │
       ▼
[Hook 被动接管: 会话激活时自动感知并注入该专题专属记忆上下文]
```

---

## 五、受控记忆与关联参考
* **初始化总览技能**: `skills/init/SKILL.md`
* **钩子专题技能**: `skills/hook/SKILL.md`
* **会话控制技能**: `skills/session-control/SKILL.md`
* **状态机存储**: `.agents/task-loop/sessions.json`
