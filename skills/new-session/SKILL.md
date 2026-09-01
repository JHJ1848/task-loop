---
name: new-session
description: "[task-loop] Provisions and binds permanent physical topic sessions from controlled memory documents (docs/memory/*.md). Supports branch A for main session (creates new top-level physical root session with mandatory alignment gate) and branch B for non-main session (binds current physical session in-place as target topic)."
---

# New Topic Session Provisioner & In-Place Binder (`new-session`)

本项目专属技能用于**开辟、初始化或就地注册持久化的专题物理会话实体 (Permanent Physical Session Entities)**，并与受控记忆文档 (`docs/memory/*.md`) 建立 1:1 强绑定。

---

## 一、核心定位与实体会话治理价值 (Core Value & KV Cache Maximization)

### 1. 物理会话实体 vs 临时子代理 (Physical Sessions vs Ephemeral Subagents)
* **长期物理会话实体 (Permanent Physical Session Entities)**:
  - 本工作流中涉及的所有“主会话”与“专题会话”**绝非**临时子代理 (subagents) 或瞬态会话；
  - 它们是**真实常驻在 IDE / Agent 左侧边栏列表中**的长期物理实体会话；
  - **核心价值**: 存储长期积累的完整会话轨迹、近期改动与领域上下文，方便频繁变动需求时的精准对齐与上下文复用；
  - **KV Cache 极大化命中**: 长期复用固定物理会话能够最大化大模型的 **Prompt Token Cache (KV Cache)** 命中率，大幅缩短首字生成时间 (TTFT) 并降低 Token 消耗成本达 50%~90%；
  - **职责主体**: 所有具体业务代码落地、功能扩展与 BugFix (WORK) 均以对应的专题物理会话为核心主体。
* **临时子代理 (Ephemeral Subagents)**:
  - 子代理仅为专题会话承接任务后，在其内部按需拉起的轻量级隔离沙箱；
  - 单次任务完成交付后即时回收销毁，不常驻 IDE 侧边栏，不具备跨任务长期记忆积累能力；
  - **主会话权限红线**: 主会话严禁派遣 Worker (写代码/落地) 子代理逃避专题治理，主会话只能派遣 `reviewer` (代码走查/审查) 和 `explorer` / `research` (架构探索) 子代理。

### 2. Hook 上下文感知机制 (Hook Context Introspection)
* 运行时 `PreInvocation` Hook 在每次用户提问或触发调用时，会自动将当前会话的元数据瞬态注入上下文：
  - 会话 ID (`session_id`)；
  - 是否主会话 (`is_main: true/false`)；
  - 专题主题 (`title`) 与角色定位 (`role`)；
  - 所属模块 (`module_key`) 与关联记忆文档 (`memory_docs`)；
* `/new-session` 技能接收到调用时，**优先读取该注入上下文**，自动判定当前所处分支并进入对应的交互流转。

---

## 二、双轨交互分支规范 (Dual-Branch Interactive Execution Flow)

```text
[触发 /new-session]
       │
       ▼
[读取 PreInvocation Hook 会话上下文感知 (is_main)]
       │
       ├─► 分支 A: 主会话环境 (is_main: true)
       │     ├─ 1. 上下文初加工: 给出高概率候选专题名 [专题名称] 核心功能1 & 核心功能2 与 docs/memory/<key>.md
       │     ├─ 2. 结构化对齐确认: 与用户交互对齐确认专题范围、标题与 Key
       │     ├─ 3. 拉起顶层根会话: agentapi new-conversation (nestingDepth: 0) 并写入 sessions.json / topics.json
       │     └─ 4. Sidebus 派单: 严禁主会话直接落地或派遣 Worker，通过 sidebus (send_message) 派发任务
       │
       └─► 分支 B: 专题会话/非主会话环境 (is_main: false)
             ├─ 1. 就地复用原则 (In-Place Binding): 将当前物理实体会话直接作为新专题就地注册/绑定
             ├─ 2. 结构化对齐确认: 与用户交互对齐拟承接的专题名称、模块 Key 与受控记忆文档
             └─ 3. 原子回写落盘: scripts/new_topic_session.js --bind-current <id> 更新状态机并生成记忆文档
```

### 1. 分支 A: 主会话环境 (`is_main: true`) — 候选推导与独立根会话拉起流
1. **意图初加工与候选推导**:
   - 主会话基于用户描述及对话上下文，提炼出高概率候选专题名称；
   - 专题标题必须严格遵循命名规范：`[专题名称] 核心功能1 & 核心功能2`；
   - 自动推导模块 Key 及目标记忆文档路径：`docs/memory/<key>.md`。
2. **强制人机结构化对齐门禁**:
   - 向用户呈现结构化确认提示卡（拟建专题标题、模块 Key、记忆路径、核心职责范围），待用户确认。
3. **独立顶层根会话创建与注册**:
   - 确认后执行创建脚本：
     `node scripts/new_topic_session.js --create-topic <key> --topic-title "[专题名称] 核心功能1 & 核心功能2"`
   - 底层调用宿主原生拉起能力（如 `agentapi new-conversation`，净化环境变量保持 `nestingDepth: 0`），生成受控记忆文档并原子写入 `.agents/task-loop/sessions.json` 与 `topics.json`。
4. **Sidebus 派单执行**:
   - 主会话严禁在自身会话中编写业务代码或擅自拉起 Worker 子代理，创建完毕后通过 sidebus (`send_message` / `agentapi`) 将具体任务派发给新专题会话实施。

### 2. 分支 B: 专题会话/非主会话环境 (`is_main: false`) — 就地注册绑定流
1. **就地复用原则 (In-Place Binding)**:
   - 当前会话本身已是一个常驻在左侧边栏的独立物理实体，**默认直接将当前物理会话就地注册/绑定为目标专题会话**，严禁在当前会话内再次套娃新建顶层根会话。
2. **强制人机对齐门禁**:
   - 与用户对齐当前物理会话拟承接的业务专题名称（`[专题名称] 核心功能1 & 核心功能2`）、模块 Key 以及对应的受控记忆文档。
3. **就地原子回写**:
   - 执行绑定命令：
     `node scripts/new_topic_session.js --create-topic <key> --topic-title "<title>" --bind-current <current_session_id>`
   - 自动生成/补齐 `docs/memory/<key>.md`，并将当前会话 ID 登记为该专题物理实体，更新 `.agents/task-loop/sessions.json` 与 `topics.json`。

---

## 三、运行模式与命令速查 (Execution Modes JSON)

```json
[
  {
    "mode": "1. 新建并拉起独立根会话 (Branch A: Main Session Only)",
    "trigger_condition": "当前为主会话 (is_main: true) 且经用户对齐确认新建专题",
    "command_node": "node scripts/new_topic_session.js --create-topic <key> --topic-title \"<title>\"",
    "command_python": "python scripts/new_topic_session.py --create-topic <key> --topic-title \"<title>\"",
    "behavior": "创建 docs/memory/<key>.md 受控记忆模板，净化父级环境拉起独立顶层根会话 (nestingDepth: 0)，写入 sessions.json / topics.json。"
  },
  {
    "mode": "2. 当前会话就地注册绑定 (Branch B: Non-Main Session In-Place Binding)",
    "trigger_condition": "当前为非主会话 (is_main: false) 且经用户对齐确认就地绑定为专题",
    "command_node": "node scripts/new_topic_session.js --create-topic <key> --topic-title \"<title>\" --bind-current <session_id>",
    "command_python": "python scripts/new_topic_session.py --create-topic <key> --topic-title \"<title>\" --bind-current <session_id>",
    "behavior": "创建/复用 docs/memory/<key>.md，将当前物理会话 ID 登记为该专题 session_id 并更新 sessions.json / topics.json。"
  },
  {
    "mode": "3. 手动指定既有专题文档拉起会话",
    "trigger_condition": "用户指定既有记忆文档路径并要求为其拉起专属物理会话",
    "command_node": "node scripts/new_topic_session.js --doc docs/memory/<topic>.md",
    "command_python": "python scripts/new_topic_session.py --doc docs/memory/<topic>.md",
    "behavior": "精准读取受控记忆文档，拉起独立顶层根会话并完成持久化绑定（若已存在则提示现有 ID，支持 --force 重新拉起）。"
  },
  {
    "mode": "4. 专题对齐调查与清单输出 (Survey & Align Mode)",
    "trigger_condition": "未提供参数时的纯只读安全检查",
    "command_node": "node scripts/new_topic_session.js",
    "command_python": "python scripts/new_topic_session.py",
    "behavior": "扫描 docs/memory/*.md 与 sessions.json，输出已绑定专题与待建会话清单，提示用户后续指令。"
  },
  {
    "mode": "5. 批量补齐全量未建会话 (Batch Provisioning)",
    "trigger_condition": "用户显式要求全量批量补齐缺失物理会话",
    "command_node": "node scripts/new_topic_session.js --all",
    "command_python": "python scripts/new_topic_session.py --all",
    "behavior": "批量为所有未建物理会话的 docs/memory/*.md 建立顶层根会话并更新状态机。"
  }
]
```

---

## 四、命令行参数与选项 (CLI Options JSON)

```json
[
  {
    "option": "--create-topic <key>",
    "description": "指定新建或绑定的模块 Key（例如: --create-topic quality_inspect）"
  },
  {
    "option": "--topic-title \"<title>\"",
    "description": "指定专题标准标题，格式: [专题名称] 核心功能1 & 核心功能2"
  },
  {
    "option": "--bind-current [session_id]",
    "description": "就地注册模式：将当前或指定的物理会话直接绑定为该专题会话，不新建顶层根会话"
  },
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

## 五、受控记忆与关联参考
* **初始化总览技能**: `skills/init/SKILL.md`
* **钩子专题技能**: `skills/hook/SKILL.md`
* **会话控制专题技能**: `skills/session-control/SKILL.md`
* **子代理专题技能**: `skills/subagent/SKILL.md`
* **任务总控技能**: `skills/task-loop/SKILL.md`
* **受控记忆主索引**: `docs/MEMORY.md`
