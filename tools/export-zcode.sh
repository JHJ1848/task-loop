#!/usr/bin/env bash
# 导出 ZCode 插件副本到仓库外的稳定引用源。
# ZCode 客户端引用 ~/.zcode/plugin-workspace/task-loop，
# 不直接引用 Git 工作区；本脚本是仓库 -> 导出副本的唯一同步路径。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ZCODE_EXPORT_DEST:-$HOME/.zcode/plugin-workspace/task-loop}"
BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
DIRTY="$(git -C "$REPO_ROOT" status --porcelain | head -1)"

if [ "$BRANCH" != "ZCode" ]; then
  echo "export-zcode: 当前分支为 ${BRANCH}，仅允许在 ZCode 分支执行导出。" >&2
  exit 1
fi

if [ -n "${DIRTY}" ]; then
  echo "export-zcode: 检测到未提交改动，将按工作区快照导出（含 ZCode 适配改动）。"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r \
  "$REPO_ROOT/.zcode-plugin" \
  "$REPO_ROOT/hooks" \
  "$REPO_ROOT/skills" \
  "$REPO_ROOT/rules" \
  "$REPO_ROOT/scripts" \
  "$REPO_ROOT/templates" \
  "$REPO_ROOT/references" \
  "$REPO_ROOT/config" \
  "$REPO_ROOT/assets" \
  "$REPO_ROOT/plugin.json" \
  "$REPO_ROOT/hooks.json" \
  "$REPO_ROOT/SKILL.md" \
  "$REPO_ROOT/README.md" \
  "$REPO_ROOT/LICENSE" \
  "$DEST/"

# 清理运行态与缓存残留，保证导出副本纯净
find "$DEST" -type d \( -name '__pycache__' -o -name '.idea' \) -prune -exec rm -rf {} +
find "$DEST" -name '*.pyc' -delete

cat > "$DEST/marketplace.json" <<EOF
{
  "name": "task-loop-local",
  "description": "task-loop 本地插件市场（ZCode 分支引用源）。",
  "plugins": [
    {
      "name": "task-loop",
      "source": "./",
      "description": "通用跨 Agent 任务循环调度器：会话感知注入、Allowlist 白名单硬门禁与跨厂商会话反向内省（ZCode 宿主版）。"
    }
  ]
}
EOF

cat > "$DEST/EXPORT-INFO.md" <<EOF
# 导出副本说明

- 用途：ZCode 本地插件市场引用源，避免引用 Git 工作区（分支切换会改变文件）。
- 来源仓库：$REPO_ROOT
- 来源分支：$BRANCH
- 来源提交：$COMMIT
- 工作区状态：${DIRTY:+含未提交改动（快照导出）}${DIRTY:-干净（HEAD 提交即所导内容）}
- 导出时间：$(date -Iseconds)
- 市场清单：根目录 marketplace.json（市场名 task-loop-local，插件 task-loop）。
- 刷新方式：检出最新 ZCode 分支后执行 bash tools/export-zcode.sh，再在 ZCode 客户端重新加载插件。
EOF

echo "export-zcode: 已导出到 $DEST（分支 $BRANCH，提交 $COMMIT）"
