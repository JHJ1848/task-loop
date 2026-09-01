---
name: init
description: "[task-loop] Project initialization, existing session survey, topic mapping recommendation, and onboarding guide for task-loop plugin."
---

# Project Initialization & Session Survey (`init`)

本项目初始化技能专用于新工程接入 `task-loop` 插件时的状态机建立、已有历史会话调查与专题映射建议。

![init 项目初始化与已有会话调查流程](assets/workflow.svg)

---

## 一、定位与适用场景 (When to Use)

当新项目安装或引入 `task-loop` 插件时，工程中往往已经存在了大量历史会话（来自 Antigravity、Codex 或 Claude Code）或既有的专题受控记忆文档（`docs/memory/*.md`）。

`init` 技能践行 **【调度器/SDK 主动程序化创建 + Hook 生命周期被动护航】** 核心架构：
1. **自动扫描历史会话与受控记忆**：无侵入式读取当前工作区的历史会话日志与 `docs/memory/*.md` 记忆文档；
2. **记忆文档 1:1 专题对齐**：确保每一个专题记忆文档均精确对应一个独立顶层根会话（`nestingDepth: 0`）；
3. **缺失会话自动创建 (`--create-missing`)**：对已有记忆文档但缺失顶层会话的模块，自动调用 `agentapi new-conversation`（净化父级环境变量）自动补齐；
4. **启发式标准化命名**：根据标题、摘要与分词，自动规范化为 `[专题名称] 核心功能1 & 核心功能2` 标准命名；
5. **用户交互确认与预览**：以结构化清单呈现给用户，支持 `--dry-run` 预览与确认；
6. **状态机落盘与兜底修改指引**：写入 `.agents/task-loop/sessions.json`，支持随时直接手动修改底层 JSON。

---

## 二、初始化前置注意事项 (Pre-Initialization Considerations)

1. **零污染原则**：初始化仅在 `.agents/task-loop/` 下生成运行态配置文件，严禁修改用户源码或污染项目根目录的 `AGENTS.md`；
2. **只读安全发现**：对历史日志的扫描采用纯只读模式，不修改历史会话内容；
3. **独立根会话规范**：自动创建的专题会话严格保持 `nestingDepth: 0`，直接在 IDE 左侧边栏展示；
4. **多厂商兼容**：自动兼容 AGY、Codex、Claude Code 会话格式。

---

## 三、主会话选定机制与优先级 (Main Session Selection Hierarchy)

在新项目初始化或迁移主治理中枢时，`init` 脚本按以下严格优先级判定与推荐主会话 (`main_thread_id`)：

```json
[
  {
    "priority": 1,
    "source": "--main-session <id>",
    "rule": "用户在命令行显式传入目标会话 ID，强制将其作为主治理中枢。"
  },
  {
    "priority": 2,
    "source": "--current-session <id> / 环境变量 ANTIGRAVITY_CONVERSATION_ID",
    "rule": "自动获取当前发起 /init 的活跃会话 ID，默认推荐当前会话为主治理中枢 [Current Session & Main Candidate]。"
  },
  {
    "priority": 3,
    "source": "历史扫描中的主会话标记",
    "rule": "历史扫描中已带有 is_main: true 或标题包含 [主会话] / 治理中枢 的会话。"
  },
  {
    "priority": 4,
    "source": "建议清单第一项",
    "rule": "扫描清单 suggestions 中的首个会话作为兜底。"
  }
]
```

---

## 四、标准交互与执行流程 (Standard Workflow)

```text
[启动初始化] -> [扫描会话 & 记忆文档] -> [主会话智能选定] -> [1:1 专题映射对齐] -> [输出用户确认卡] -> [按需补齐根会话并落盘] -> [Hook 自动接管]
```

### 1. 扫描与建议清单生成 (预览模式)
执行调查脚本获取建议清单与 1:1 记忆文档对齐状态（推荐显式传入当前会话 ID）：
* **Node.js (推荐)**:
  ```bash
  node scripts/init_task_loop.js --dry-run --current-session <CurrentSessionId>
  ```
* **Python (备选)**:
  ```bash
  python scripts/init_task_loop.py --dry-run --current-session <CurrentSessionId>
  ```

### 2. 用户确认卡输出规范 (User Confirmation Card)
在执行初始化前，主会话或调度器应向用户呈现结构化【初始化确认卡】：

```json
{
  "card_type": "TASK_LOOP_INIT_CONFIRMATION",
  "workspace_root": "<WorkspaceRoot>",
  "chosen_main_session": {
    "session_id": "<MainSessionId>",
    "is_current_session": true,
    "title": "[主会话] 任务编排 & 治理中枢"
  },
  "topic_mappings": [
    {
      "module_key": "hook",
      "session_id": "<HookSessionId>",
      "topic_name": "[钩子专题] 生命周期 & 安全门禁",
      "memory_doc": "docs/memory/hook.md"
    }
  ],
  "missing_sessions_to_create": ["<ModuleKey1>"]
}
```

### 3. 正式执行与缺失会话自动补齐
若需将配置实际落盘，并自动为缺失会话的记忆文档建立顶层根会话：
```bash
node scripts/init_task_loop.js --create-missing --current-session <CurrentSessionId>
```

---

## 五、底层存储与用户兜底修改机制 (Fallback Editing)

初始化完成后，所有专题与会话映射保存在（**Schema v4: 顶层即为厂商分区**）：
* **核心会话映射表**: `<WorkspaceRoot>/.agents/task-loop/sessions.json`
* **专题声明清单**: `<WorkspaceRoot>/.agents/task-loop/topics.json`
* **任务队列**: `<WorkspaceRoot>/.agents/task-loop/todo.json`
* **调度策略**: `<WorkspaceRoot>/.agents/task-loop/policy.json`

### Schema v4 厂商分区结构 (跨 Agent 隔离铁律)

sessions.json 与 topics.json 顶层即为厂商分区，**动态扩展**（新厂商即新键），各宿主工具只读写自身分区，结构上杜绝旧版多 Agent 相互覆写的问题：

```json
{
  "schema_version": 4,
  "updated_at": "<ISO>",
  "vendors": {
    "zcode":       { "vendor": "zcode", "main_thread_id": "<id>", "updated_at": "<ISO>", "modules": {}, "sessions": [] },
    "antigravity": { "vendor": "antigravity", "main_thread_id": "<id>", "updated_at": "<ISO>", "modules": {}, "sessions": [] },
    "codex":       { "vendor": "codex", "main_thread_id": null, "updated_at": null, "modules": {}, "sessions": [] },
    "claude":      { "vendor": "claude", "main_thread_id": null, "updated_at": null, "modules": {}, "sessions": [] }
  }
}
```

**隔离铁律 (Cross-Vendor Write Isolation)**：
1. 每个宿主的工具（init / new-session / Hook / 派单）**只允许读写自身厂商分区**（由宿主环境变量自动判定，如 ZCode 注入 `ZCODE_SESSION_ID`），其余厂商分区零接触；
2. 旧版各 Agent 全量覆写同一份顶层 modules/sessions 导致互相冲掉绑定的问题已在 Schema v4 结构上根除——任何工具都不再写厂商共享的顶层数据；
3. `topics.json` 同构分区（分区内为 `{ vendor, updated_at, topics: [...] }`）；
4. 兼容镜像: 每厂商另有物理文件 `sessions.<vendor>.json` / `topics.<vendor>.json` 供旧版工具直读，由写入方自动同步。

### 快速查询脚本 (Query CLI)

AI 与用户无需通读全文件，直接按键取值（智能体据此**自主选择工具/文档**：先读专题的 `vendor` 与 `resumable` 字段，再按 `references/sdk/README.md` 映射选择对应厂商的会话工具）：

```bash
# 取指定厂商主会话 ID
node scripts/query_task_loop_state.js --vendor zcode --key main_thread_id

# 取指定专题绑定的会话 ID (点路径)
python scripts/query_task_loop_state.py --vendor zcode --key modules.hook.session_id

# 输出整个厂商分区 / 列出全部厂商 / 旧格式一键迁移 v4
node scripts/query_task_loop_state.js --vendor zcode --all
node scripts/query_task_loop_state.js vendors
node scripts/query_task_loop_state.js migrate --vendor zcode
```

### 用户直接修改指引：
如果用户发现专题划分不合理或希望修改某个会话的绑定关系，**可直接打开 `.agents/task-loop/sessions.json` 手动编辑自身厂商分区**：

```json
{
  "schema_version": 4,
  "vendors": {
    "<你的厂商，例如 zcode>": {
      "vendor": "<你的厂商>",
      "main_thread_id": "<主会话ID>",
      "modules": {
        "<module_key>": {
          "session_id": "<目标会话ID>",
          "title": "<自定义专题名称>",
          "tags": ["tag1", "tag2"],
          "memory_doc": "docs/memory/<module_key>.md"
        }
      },
      "sessions": []
    }
  }
}
```
底层 Hook 与调度器会实时读取该文件，改动即刻生效，无需重启任何服务。**严禁修改其他厂商分区**（那会破坏跨 Agent 隔离；误改可用 git 或备份恢复，其余厂商分区不受影响）。

---

## 六、受控记忆与关联参考
* **会话控制专题技能**: `skills/session-control/SKILL.md`
* **新专题会话开辟技能**: `skills/new-session/SKILL.md`
* **钩子专题技能**: `skills/hook/SKILL.md`
* **任务总控技能**: `skills/task-loop/SKILL.md`
* **受控记忆主索引**: `docs/MEMORY.md`
