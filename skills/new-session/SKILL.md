---
name: new-session
description: "[task-loop] 用户明确要求创建长期专题会话，或将已有会话绑定到专题时使用。"
---

# 创建或绑定专题会话

1. 按当前宿主的 `main_thread_id` 判断角色。确认专题职责、`module_key`、标题 `[专题名称] 核心功能1 & 核心功能2` 和 `docs/memory/<key>.md`。优先复用同项目、同宿主的现有可续接绑定。缺少记忆框架时先用 [memory-init](../memory-init/SKILL.md)。
2. **预览。** `new_topic_session --dry-run` 只推导标题、路径及状态。仅指定 `--doc` 或 `--topic` 的正式调用要求已有文档。用 `--create-topic <key> --topic-title "<标题>"` 指定新专题。确认后的重建才用 `--force`；批量补齐须单独授权。
3. **执行。** 已登记 Main 按确认的范围创建顶层专题；已有顶层会话需要登记时用 `--bind-current` 就地绑定。身份、项目归属或授权不明确时先对齐。任务定界与派单使用 [create-task](../create-task/SKILL.md)。

## Codex

- Main 按 [Desktop 创建契约](../../references/sdk/codex.md#411-init-与-new-session-的-codex-主动创建步骤) 核对项目，调用 `create_thread`。Git 项目用 worktree，其余用 local。沿用用户选择或已有模型设置。
- 只用正式 `threadId` 绑定；排队回执或 `clientThreadId` 保留为 `PENDING_CREATION`，追踪同一请求。

```text
node "<plugin-root>/scripts/new_topic_session.js" --workspace "<project-root>" --vendor codex --doc "<memory-doc>" --bind-current "<threadId>" --id-kind threadId
```

绑定新专题时可将 `--doc` 换成 `--create-topic` 和 `--topic-title`。缺 Node.js 时用同名 Python 脚本。完成后重查当前厂商分区，确认正式 ID 和记忆文件。其他厂商操作看 [SDK 索引](../../references/sdk/README.md)。
