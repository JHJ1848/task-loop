---
name: session-control
description: "[task-loop] 查询会话身份和登记，或维护会话提供者、宿主调度和只读诊断时使用。"
---

# 会话控制

1. 区分当前宿主、项目根和已登记会话。用查询脚本读取当前分区；会话扫描只用于诊断，正式绑定由 [session-init](../session-init/SKILL.md) 或 [new-session](../new-session/SKILL.md) 管理。
2. 按意图选择原语：查询当前 ID、扫描、创建、发送、管理或等待。选择当前宿主支持的能力。操作前核对正式 ID、项目归属、`resumable` 和授权。读日志只取必要的时间段和字段。
3. **Codex。** 从 `vendors.codex.modules.<key>` 获取 `id_kind: threadId` 的可续接绑定。向已有会话用 `send_message_to_thread`，等待交付用 `wait_threads`。发送回执表示提交，验收以会话回复和证据为准。创建或续接时区分 `PENDING_CREATION`、`PREPARED_ONLY` 和正式回执。

```text
node "<plugin-root>/scripts/query_task_loop_state.js" --workspace "<project-root>" --vendor codex --key "modules.<key>"
```

任务定界和派单看 [create-task](../create-task/SKILL.md)。Codex 工具、CLI 和状态映射见 [Codex SDK](../../references/sdk/codex.md)。其他宿主的 Sidebus、CLI 及 Provider 契约按 [SDK 索引](../../references/sdk/README.md) 选读。
