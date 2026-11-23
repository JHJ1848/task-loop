---
name: session-init
description: "[task-loop] 预览、初始化或修复当前宿主的 Main 注册和专题会话绑定。"
---

# 会话初始化

1. 核对目标项目与记忆状态。新项目先用 [memory-init](../memory-init/SKILL.md)，已有项目沿用 `module_key` 和相对 `memory_doc`。
2. 运行只读预览，核对建议 Main、已有绑定与缺失专题。按需加 `--vendor`、`--current-session` 或 `--main-session`。

```text
node "<plugin-root>/scripts/init_task_loop.js" --workspace "<project-root>" --dry-run
```

3. 获授权后去掉 `--dry-run`，复用可续接绑定。Codex 由已登记 Main 按 [Desktop 创建契约](../../references/sdk/codex.md#411-init-与-new-session-的-codex-主动创建步骤) 处理待创建项，收到正式 `threadId` 再绑定。再次查询确认结果。

缺 Node.js 时用同名 Python 脚本。旧 `init` 入口沿用同一脚本。
