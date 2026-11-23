---
name: init
description: "[task-loop] 旧 /init 入口。扫描、预览或补齐当前宿主的主会话与长期专题注册。"
---

# 会话初始化兼容入口

以 [session-init](../session-init/SKILL.md) 的检查与执行流程为准。沿用 `init_task_loop.js` 或 `init_task_loop.py` 及原参数。项目记忆框架由 [memory-init](../memory-init/SKILL.md) 管理。

- `--dry-run` 扫描并预览。核对主会话提议、现有绑定和缺失专题。
- 正式 `/init` 以当前宿主分区对齐 `docs/memory/*.md`，复用可续接绑定，对获授权的缺失专题逐项补齐。普通会话先对齐 Main 身份。迁移主会话时用 `--main-session` 指定已核实的目标。
- Codex 的 `PENDING_CREATION` 交由已登记 Main 按 [Desktop 创建契约](../../references/sdk/codex.md#411-init-与-new-session-的-codex-主动创建步骤) 处理。等到正式 `threadId` 后再绑定，重新查询确认复用。其他厂商选读 [SDK 索引](../../references/sdk/README.md)。
