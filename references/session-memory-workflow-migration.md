# session-memory-workflow 合并与接入契约

本文件描述首个 Codex 合并候选包的实施范围和验收条件。以当前 `task-loop` 仓库为合并落点，完成候选包后逐个验收 Antigravity、Claude Code 和 ZCode。

## 来源与导入范围

- 会话和宿主适配以 `task-loop@ae6d498` 为基线。开发规范和记忆运行时以 `jiaohuan-dev@0914bf8` 为基线，工程规范来源见 [工程原则](../rules/engineering-principles.md)。
- 首批导入 `skills/project-memory/`、`skills/memory-get/`、`skills/memory-put/`，保留脚本、配置与被引用的参考文档。`memory-init` 使用同一套 `project-memory.js init` 实现。记忆模块按来源仓库的 Node.js 20+ 要求验收，现有会话功能继续按各自的 Node.js 与 Python 契约验收。
- 已接入 `workflow`、`bugfix-dev`、`explore` 和 `session-gotcha-extractor`。旧 `dev` 与 `bugfix` 路由统一调用 `bugfix-dev`，项目记忆初始化使用 `memory-init`。审查由宿主的 `code-review` 提供，缺少独立审查能力时报告未执行。

## 数据归属与初始化入口

- `memory-init` 管理 `docs/MEMORY.md`、`docs/memory/`、`docs/change/` 和 `.agents/project-memory/`。原项目规则继续由相应 `AGENTS.md` 提供。
- `session-init` 管理 `.agents/task-loop/` 内的厂商分区和会话绑定。保留 `init_task_loop.*` 的脚本入口，延续现有 `module_key`、`memory_doc`、正式 `threadId` 及厂商隔离语义。
- 联接字段为 `module_key` 和项目相对路径 `memory_doc`。新专题由记忆模块建档并登记索引，之后由会话模块关联已有会话或创建并绑定。已有专题沿用原物理文件和绑定；待宿主返回正式 ID 的任务继续保留待创建状态。
- 安装候选包时保持项目文件原样。已有项目先调用 `project-memory.js inspect --project-root <project-root>`。检查 `framework.status`，进入 `ready` 后再走常规检索。`get` 在框架未就绪时返回状态和处理指引，旧记忆可显式使用 `get --mode keep` 只读检索。初始化和迁移由 `memory-init` 执行，受控归档继续要求确认。
- 会话脚本使用 `project-memory.js provision --project-root <project-root> --module-key <key> --title <title>` 建档。仅在回执为 `provisioned` 或 `reused` 且模块和文档路径通过检查时继续会话操作。使用 `--dry-run` 时只预览。

## 首批实施交接

1. **插件打包专题 `plugin_spec`**。负责导入记忆技能及工程规则的引用，提供 `memory-init`，在 Codex 候选包清单中给出新插件 ID。改动范围限于 `.codex-plugin/`、候选包的市场清单与打包入口、`skills/project-memory/`、`skills/memory-get/`、`skills/memory-put/`、`skills/memory-init/` 及本契约涉及的规则引用。明确插件根与目标项目根，运行时从包内定位程序并显式传目标项目根。导出验证覆盖 `contracts/`、规则和 Hook 脚本的实际可达性；发布内容检查个人路径、凭据及会话标识。一个 Codex Hook 提供主会话派单提示与长会话提醒。来源仓库探测旧全局 `task-loop` 安装的白名单包装器留在旧包。
2. **会话专题 `session_control`**。承接打包专题给出的记忆建档调用契约，负责 `session-init` 与 `new-session` 接缝。改动范围限于 `skills/init/`、`skills/session-init/`、`skills/new-session/`、`scripts/init_task_loop.*`、`scripts/new_topic_session.*` 与会话接口说明。先验证既有绑定并处理预览分支，再调用建档或宿主写入。旧 CLI、现有正式 ID、厂商分区和历史文档均可继续使用。
3. 主会话核对范围、跨专题契约和验收回执。两专题按现有 Codex 正式绑定续接。更新本机 `task-loop` 时，先核对工作流和记忆入口已可发现，再卸载 `jiaohuan-dev`。GitHub 发布与其他宿主安装另行处理。

## Codex 候选导出

```text
node scripts/export_codex_plugin.js --out "<仓库外且尚不存在的目录>"
```

输出目录的父目录须已存在。导出内容包括候选清单、市场入口、Skill、规则及 Codex Hook。Codex 默认展示专用工作流入口。兼容入口 `init` 和记忆索引 `project-memory` 可通过 `$` 点名调用。

## 验收与回退

- 旧项目样本先核对 `main_thread_id`、专题正式 `threadId` 和记忆相对路径。用独立 Codex 配置安装候选并信任 Hook，再提交实际消息。验证已登记 Main 收到一条派单提示，普通会话安静，现有专题可续接。
- 如果用户级 `task_loop_event_router` 也生成 Main 提示，先在隔离配置复现并确认新版正常覆盖，再为目标项目收敛到一个提示来源。保留已有状态采集及其他项目使用的旧功能。
- 新项目样本依次走 `memory-init`、记忆建档、`session-init`、一次授权派单和一次经确认的 `memory-put`。核对主索引、专题索引和会话状态的职责；重复初始化仍复用既有绑定，预览与检索保持项目文件原样。
- 本机切换前保存插件启用配置、Hook 配置及对应旧版本。回退时切回上一组启用项并复核会话、记忆和宿主触发记录。保留期间经用户确认形成的业务记忆。
