# create-task 派遣手册

本手册用于用户明确要求把独立任务发给已有专题的场景。在当前会话新建任务时，按 [create-task](../SKILL.md) 定界即可。

## 1. 定界与定位

先按目标项目的 `AGENTS.md` 确认主会话身份和派单权限。以一个独立任务为单位保留任务 ID、标题、用户原始需求、职责范围、验收条件和验证方式。将只读取证标为 `EXPLORE`，把已授权的代码或配置修改标为 `WORK`，后者需要项目相对路径白名单。发送前按插件的 `references/dispatch-contract.md` 组织前序任务边界、业务背景、影响分析、实施范围和验收。每条 `WORK` 说明先加载当前宿主实际注册的 `bugfix-dev`。收件人无法加载时先回报，再处理写入。

`$pluginRoot` 指向包含 `scripts/` 与 `references/` 的 task-loop 插件或源码根目录。独立安装的 Skill 应从宿主确认实际插件位置。`$projectRoot` 指向目标项目根，两个路径分别传入。下面以 `$moduleKey` 为已确认的专题键，`$vendor` 为当前宿主的厂商键，示例变量应先赋值再运行。

```powershell
node "$pluginRoot/scripts/query_task_loop_state.js" --workspace "$projectRoot" --vendor "$vendor" --key main_thread_id
node "$pluginRoot/scripts/query_task_loop_state.js" --workspace "$projectRoot" --vendor "$vendor" --key "modules.$moduleKey"
node "$pluginRoot/scripts/query_task_loop_state.js" --workspace "$projectRoot" --file topics --vendor "$vendor" --key topics
```

前两条读取 `.agents/task-loop/sessions.json` 的厂商分区，第三条查询 `topics.json` 的专题清单。按键读取，确需对照多个条目时用 `--all`。核对专题的 `vendor`、`resumable: true`、`session_id` 和项目归属。Codex 还要求 `id_kind: "threadId"`。变量 `$targetId` 使用已核实的接收 ID。找不到可续接绑定时保留待派发任务单。绑定处于 `PENDING_CREATION` 时，等已有创建流程提供正式 ID 并核实绑定后再发送。

## 2. 选择派遣模式

读取目标项目的派单规范和适用的 `config/user_preferences.json`，取 `main_session_policy.enable_file_state_machine`。默认轻量模式直接发送带任务 ID 的正文，复用已有会话注册；本次派单无需新增 `todo.json`、派单包或租约。若宿主的写入 Hook 需要机器可读白名单，按该项目已配置的途径核对本次任务白名单可达；正文里的路径仅供接收人阅读。

文件状态机已开启时，按下一节准备派单包后再发信。用户仅要求草稿或预览时，返回拟派发内容及目标，跳过会产生租约或派单包的命令。

## 3. 文件状态机的 JSON 和脚本

运行目录为目标项目的 `.agents/task-loop/`。预检和生成器兼容在该目录整体缺失时读取旧 `.codex/task-loop/`。同一次派单以实际命中的目录（以下称 `$runtimeDir`）作为状态和回执来源。

- `sessions.json` 是主会话及专题注册表。通过 Query CLI 查绑定。
- `topics.json` 保存已登记的专题定义。用它核对职责范围。
- `todo.json` 的 `items[]` 保留各任务。预检和生成器读取 `state`，预检还要求 `confirmation: "approved"`；Schema 与现有写入 Hook 读取 `status`，Hook 从任务外层读取 `assignee_thread_id` 和 `allowlist`。任务准备使用现有状态管理流程，沿用文件已有 `schema_version` 与其他任务。
- `policy.json` 是项目调度策略。当前生成器在内部请求 25 分钟租约，不通过该文件读取时长。
- `lease.json` 记录 `task_id`、`run_id`、`acquired_at`、`expires_at`。生成器会申请租约，先不单独申请。当前实现没有提供可靠的并发互斥保证，文件模式的调度器应串行操作同一队列。
- `dispatch/<run-id>.json` 是生成的派单包。以生成器回执的 `packet_path` 定位。若项目维护 `run-journal.jsonl`，用已有状态流程记录派发与验收证据。

可以在 PowerShell 按任务 ID 读取当前项，检查 `state` 和 `status` 是否各自在预期阶段。也可使用同一方式读取 `policy.json` 或 `lease.json`。

```powershell
$todo = Get-Content -LiteralPath (Join-Path $runtimeDir 'todo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$task = $todo.items | Where-Object id -eq $taskId
$task | Select-Object id, state, status, confirmation, assignee_thread_id, allowlist
```

下面是准备发出的单个 `WORK` 任务示意，属于 `items[]` 中的一项。内外两处白名单应一致。只读任务标为 `EXPLORE`，写入白名单显式给空数组；发送正文与文件写权限要分别核对。

```json
{
  "id": "<task-id>",
  "title": "<任务标题>",
  "task_type": "WORK",
  "state": "ready",
  "status": "pending",
  "confirmation": "approved",
  "assignee_thread_id": "<已核实的接收会话 ID>",
  "allowlist": ["src/example.js"],
  "agent_goal": {
    "objective": "<单一任务目标>",
    "complexity": 2,
    "allowlist": ["src/example.js"],
    "acceptance_criteria": ["<可观察的验收结果>"],
    "verification": ["<依项目规则约定的验证方式>"]
  }
}
```

1. 用下面第一条执行派单前置检查。只有 `action: "DISPATCH"` 且 `item_id` 等于本次任务才执行第二条。生成器取首个 `state` 不为 `done` 或 `cancelled` 的事项，命令参数无法选择任务 ID。遇到 `DISCUSS`、`NOOP` 或 `INVALID` 时按原因处理，保留已有队列次序。
2. 为执行回合取唯一的 `$runId`（例如 UUID）。同一回合继续使用同一 ID。生成成功返回 `action: "PREPARED"` 和 `packet_path`。读取包后，对照本轮任务核实 `task_id`、`run_id`、`target_thread_id`、目标、白名单及验收条件。省略 `agent_goal.allowlist` 会得到 `["*"]`，应明确填写并按授权核对。包内的 `authorization` 默认值不会扩大用户授予的 Git 或写入权限。将核对后的派单包信息与第 1 节正文一起发送，保留正文中的原始需求及限制。
3. 有发送回执后，按当前项目的状态更新途径将这项任务记为已派发（例如 `state` 和 `status` 均为 `dispatched`）。在获得验收结果或中止本回合后，用第三条释放本回合租约。检查 `lease.json` 的所有者，`NOOP / run_id_mismatch` 表示其他回合持有。包生成或发送失败后，先核实回合状态，避免重复发送或清除其他回合的锁。旧派单包可能被写入 Hook 按目标会话读取，结束时按已有流程归档失效的派单包。

预检并确认返回的是本次任务。

```powershell
$preflight = node "$pluginRoot/scripts/test_task_loop_preflight.js" --root "$projectRoot" | ConvertFrom-Json
$preflight | Select-Object action, reason, item_id
```

仅在预检通过后生成并读取派单包。

```powershell
$receipt = node "$pluginRoot/scripts/new_task_loop_dispatch_packet.js" --root "$projectRoot" --run-id "$runId" --target-thread-id "$targetId" | ConvertFrom-Json
if ($receipt.action -eq 'PREPARED') {
  $packet = Get-Content -LiteralPath (Join-Path $projectRoot $receipt.packet_path) -Raw -Encoding UTF8 | ConvertFrom-Json
  $packet | Select-Object task_id, run_id, target_thread_id, objective, allowlist, acceptance_criteria
}
```

在本回合结束时释放租约。

```powershell
node "$pluginRoot/scripts/release_task_loop_lease.js" --lease "$runtimeDir/lease.json" --run-id "$runId"
```

`$runtimeDir` 指上文实际命中的状态目录。上述命令均有同名 Python 版本，使用 `python` 和 `.py`，标志一致。

## 4. 向已核实的专题发送

将完整派单正文赋给 `$message`。优先使用当前宿主已经提供的原生工具。每个任务只选一个发送入口。

- Codex Desktop 使用 `send_message_to_thread`，传入正式 `threadId` 与完整正文。获得提交回执后使用 `wait_threads` 等待，有需要再用 `read_thread` 拿交付。
- Codex CLI 可用现有派单适配器，`--dry-run` 仅准备命令，获得 `SUBMITTED` 和 `submitted: true` 才记已派发。读取 JSON 回执，退出码 0 也可能对应 `PREPARED_ONLY`。
- Antigravity 优先用原生 `send_message`，CLI 入口按位置传入会话 ID 和正文。唤醒已有任务时引用原任务 ID。
- ZCode 使用 `send` 子命令续接已核实的 `sess_` 会话。Claude Code 使用 `--resume` 续接其原生会话 UUID。CLI 输出按各厂商 SDK 契约核对会话和结果。

```powershell
node "$pluginRoot/scripts/providers/codex_session_dispatch.js" --thread "$targetId" --message "$message"
agentapi.bat send-message "$targetId" "$message"
node "$pluginRoot/scripts/providers/spawn_zcode_session.js" send --session "$targetId" --prompt "$message"
claude -p --resume "$targetId" "$message" --output-format json
```

## 5. 完成、阻塞与退回

回报任务 ID、接收专题、实际派发状态和可用证据。收件回执仅确认请求已提交。交付前核对实际加载的 Skill、变更文件、业务断言和验证结果。Main 按项目规则验收，再把该任务标为完成；验收未通过则回原专题继续同一任务。若发信状态不明，先用宿主回执或目标会话记录核对，再决定是否重试。
