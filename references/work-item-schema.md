# Universal Task Loop State Format

所有路径相对于项目根目录，默认存放在被 Git 忽略的 `.agents/task-loop/`（向下兼容 `.codex/task-loop/`）：

```json
[
  {
    "file": "todo.json",
    "owner": "main",
    "purpose": "用户事项、标准化目标、Q&A 和生命周期状态。"
  },
  {
    "file": "sessions.json",
    "owner": "main",
    "purpose": "main_thread_id、全量会话列表、模块键、会话 ID、标签/功能简述与模块记忆相对路径。"
  },
  {
    "file": "topics.json",
    "owner": "main",
    "purpose": "专题文档、模块键和长期专题会话标题的声明式来源。"
  },
  {
    "file": "policy.json",
    "owner": "main",
    "purpose": "节奏策略、活动厂商配置（active_vendor）、租约时长与模型分级配置。"
  },
  {
    "file": "lease.json",
    "owner": "lease 持有者",
    "purpose": "当前单一派发的原子锁，防止多会话写入冲突。"
  },
  {
    "file": "run-journal.jsonl",
    "owner": "main",
    "purpose": "调度扫描、状态流转、阻塞与派单证据。"
  }
]
```

---

## `sessions.json` 结构规范（Schema v4: 顶层厂商分区, 动态扩展, 跨 Agent 隔离）

Schema v4 起 sessions.json 与 topics.json 顶层即为**厂商分区**（zcode / antigravity / codex / claude / 任意新厂商动态扩展），各宿主工具只读写自身分区，结构上杜绝旧版多 Agent 全量覆写同一份顶层数据导致的互相冲绑问题。查询请用 `scripts/query_task_loop_state.js|.py`（`--vendor <v> --key <dot.path>`），旧格式（v1/v2/v3）在首次写入时自动整体迁移为 v4，其余厂商分区不受影响。

```json
{
  "schema_version": 4,
  "updated_at": "2026-08-31T12:00:00.000Z",
  "vendors": {
    "zcode": {
      "vendor": "zcode",
      "main_thread_id": "sess_<uuid>",
      "updated_at": "2026-08-31T12:00:00.000Z",
      "modules": {
        "hook": {
          "session_id": "sess_<uuid>",
          "title": "[钩子专题] 生命周期 & 安全门禁",
          "tags": ["hook", "topic"],
          "memory_doc": "docs/memory/hook.md",
          "vendor": "zcode",
          "resumable": true,
          "dispatch_hint": "可续接: 经当前宿主会话 SDK send/resume 原语定向派单",
          "summary": "专题模块: [钩子专题] 生命周期 & 安全门禁"
        }
      },
      "sessions": [
        {
          "session_id": "sess_<uuid>",
          "vendor": "zcode",
          "title": "[钩子专题] 生命周期 & 安全门禁",
          "is_main": false,
          "module_key": "hook",
          "resumable": true,
          "summary": "专题模块: [钩子专题] 生命周期 & 安全门禁",
          "memory_docs": ["docs/memory/hook.md"]
        }
      ]
    },
    "antigravity": { "vendor": "antigravity", "main_thread_id": null, "updated_at": null, "modules": {}, "sessions": [] },
    "codex": { "vendor": "codex", "main_thread_id": null, "updated_at": null, "modules": {}, "sessions": [] },
    "claude": { "vendor": "claude", "main_thread_id": null, "updated_at": null, "modules": {}, "sessions": [] }
  }
}
```

`topics.json` 同构：顶层 `vendors.<vendor>.topics[]`（条目含 `topic_key/name/session_id/vendor/resumable/tags/memory_doc`）。另有兼容镜像物理文件 `sessions.<vendor>.json` / `topics.<vendor>.json` 由写入方自动同步，供旧版宿主工具按 `targetVendor` 直读。

**厂商自选择规则 (Vendor Self-Selection)**：智能体派单或选择工具/文档前，先经查询脚本读取目标专题条目的 `vendor` 与 `resumable` 字段——`resumable: true` 时按该 `vendor` 经对应宿主 SessionProvider send/resume 原语派单；`false` 为只读遗留，仅可历史内省或经 new-session 重建。厂商与工具/文档映射总表见 `references/sdk/README.md`。

---

## 1/2/3 复杂度分级与 Subagent 策略（JSON 规范）

```json
[
  {
    "complexity": 1,
    "alias": "simple",
    "subagent_policy": "none",
    "execution_rule": "极速直发：直接派发到专题会话单线程执行，无需复杂 Q&A，快速修改并验证闭环。"
  },
  {
    "complexity": 2,
    "alias": "standard",
    "subagent_policy": "optional",
    "execution_rule": "标准派发：专题会话在边界内执行标准开发、验证与专题记忆回写。按需由专题决定是否启动子代理。"
  },
  {
    "complexity": 3,
    "alias": "complex",
    "subagent_policy": "mandatory",
    "execution_rule": "强制 Subagent 编排：跨模块或重构任务，专题会话作为调度中枢，必须调用 invoke_subagent 拆分 Research/Worker/Reviewer 子代理并行处理。"
  }
]
```
