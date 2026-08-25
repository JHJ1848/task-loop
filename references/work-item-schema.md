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

## `sessions.json` 结构规范（支持全量会话持久化与功能映射）

```json
{
  "schema_version": 1,
  "main_thread_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
  "sessions": [
    {
      "session_id": "ee94b2c5-c0c2-473f-8f71-213250ba5295",
      "vendor": "antigravity",
      "title": "[主会话] 任务编排 & 治理中枢",
      "is_main": true,
      "created_at": "2026-08-21T08:54:04Z",
      "last_active_at": "2026-08-25T01:43:46Z",
      "log_path": "path/to/transcript.jsonl",
      "recent_prompts": ["..."]
    },
    {
      "session_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
      "vendor": "antigravity",
      "title": "[会话专题] SDK接口封装 & 会话管理",
      "is_main": false,
      "created_at": "2026-08-25T01:41:05Z",
      "last_active_at": "2026-08-25T01:43:39Z",
      "log_path": "path/to/transcript.jsonl",
      "recent_prompts": ["..."]
    }
  ],
  "modules": {
    "session_control": {
      "thread_id": "cdd1ca5c-3532-4489-b844-15c6f34055fa",
      "title": "[会话专题] SDK接口封装 & 会话管理",
      "title_prefix": "session-",
      "tags": ["session", "sdk", "controller"],
      "summary": "负责会话 SDK 接口封装、便利性脚本维护及专题记忆归档",
      "memory_docs": ["docs/memory/session_control.md"],
      "log_path": "path/to/transcript.jsonl"
    }
  }
}
```

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
