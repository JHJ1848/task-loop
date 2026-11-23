---
name: task-loop
description: "[task-loop] 主会话协调跨专题任务时使用。核对现有绑定、划定修改范围、派单并验收。"
---

# 专题编排

1. **确认角色。** 从目标项目的 `AGENTS.md` 与当前宿主分区核对权限和 `main_thread_id`。缺少主会话登记时，走 [session-init](../session-init/SKILL.md) 的对齐流程。Main 可做只读调查和授权范围内的文档维护。模块代码交给对应专题。
2. **选入口。** 需求不清时用 [explore](../explore/SKILL.md) 取证。用户要求独立开任务或派单时用 [create-task](../create-task/SKILL.md)。用户明确要求创建或绑定长期专题时用 [new-session](../new-session/SKILL.md)。现有专题优先复用。
3. **定界和派发。** 先按职责匹配专题，核对项目归属、当前宿主和可续接会话 ID。派单附用户原意、必要背景、目标、验收条件及 `EXPLORE` 或 `WORK`。每条 `WORK` 指定加载本插件的 `bugfix-dev`，附项目相对路径 Allowlist。默认直接发信，启用文件状态机时按派遣手册使用队列和租约。
4. **划分工作。** 简单事项直接处理或交一个专题。中等任务由一个专题负责交付。复杂任务只拆为边界独立、写入范围互斥的子任务。Codex 用 `send_message_to_thread` 向已登记的正式 `threadId` 发信，按需用 `wait_threads` 等交付。临时子代理按用户明确要求启用。
5. **验收。** 核对实际加载的 Skill、Diff 白名单、可观察的验收证据及失败情况。需要人工核验时给出最短操作路径和预期结果。超范围先对齐授权。

只读当前相关专题的记忆。派单格式、并行边界与验收细节见[派单契约](../../references/dispatch-contract.md)。厂商原语见 [Codex](../../references/sdk/codex.md) 或 [SDK 索引](../../references/sdk/README.md)。


