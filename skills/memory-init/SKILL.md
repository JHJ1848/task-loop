---
name: memory-init
plugin: session-memory-workflow
description: "[session-memory-workflow] 用户明确要求初始化、迁移或补齐项目记忆时使用。"
---

# 记忆初始化与建档

脚本为 `skills/project-memory/scripts/project-memory.js`。每次显式传 `--project-root <目标项目根>`，先执行 `inspect` 核对状态，再执行获授权的 `init`。

- 出现 `requires_memory_mode` 时请用户确认。用 `--mode migrate` 迁移，`--mode keep` 保留旧正文，或在明确授权后用 `--mode reset --confirm-reset` 重置。迁移和重置会先备份。旧框架可通过 `get --mode keep` 只读检索。
- 框架 `ready` 后可用 `provision --module-key <key> --title "<标题>"` 建档。Key 使用 1–64 位小写字母、数字、连字符或下划线。重复调用保留已有正文。
- 以回执中的 `status`、`module_key` 和项目相对 `memory_doc` 核对结果。会话绑定由 `session-init` 或 `new-session` 处理。
