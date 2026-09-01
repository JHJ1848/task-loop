#!/usr/bin/env node
/**
 * [Query CLI] 快速获取 task-loop 状态机 (sessions.json / topics.json) 中指定厂商分区的 key/value
 *
 * 用法:
 *   node scripts/query_task_loop_state.js [--file sessions|topics] --vendor <v> --key <dot.path> [--workspace <dir>]
 *   node scripts/query_task_loop_state.js --vendor <v> --all                       # 输出整个分区
 *   node scripts/query_task_loop_state.js vendors                                  # 列出全部厂商分区键
 *   node scripts/query_task_loop_state.js migrate [--vendor <默认厂商>]            # 旧格式迁移为 v4
 *
 * 示例:
 *   node scripts/query_task_loop_state.js --vendor zcode --key modules.hook.session_id
 *   node scripts/query_task_loop_state.py --file topics --vendor zcode --key topics
 *
 * 退出码: 0 命中; 1 未命中/参数错误。输出恒为该 key 的 JSON 值 (原始类型原样输出)。
 */

const path = require('path');
const store = require('./task_loop_state');

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const wsRoot = path.resolve(opt('--workspace') || process.cwd());
  const sessionsFile = path.join(wsRoot, '.agents', 'task-loop', 'sessions.json');
  const topicsFile = path.join(wsRoot, '.agents', 'task-loop', 'topics.json');

  // 子命令: vendors
  if (args[0] === 'vendors') {
    const kind = opt('--file') === 'topics' ? topicsFile : sessionsFile;
    const raw = store.readJson(kind);
    if (!raw) { console.log('[]'); return; }
    const keys = raw.schema_version === 4
      ? Object.keys(raw.vendors || {})
      : Object.keys((raw.vendors && typeof raw.vendors === 'object') ? raw.vendors : { [raw.current_vendor || 'antigravity']: 1 });
    console.log(JSON.stringify(keys, null, 2));
    return;
  }

  // 子命令: migrate
  if (args[0] === 'migrate') {
    const isTopics = opt('--file') === 'topics';
    const file = isTopics ? topicsFile : sessionsFile;
    const vendor = store.normalizeVendor(opt('--vendor')) || store.detectVendor() || 'antigravity';
    const kind = isTopics ? 'topics' : 'sessions';
    const doc = store.writePartition(file, vendor, {}, { kind });
    console.log(JSON.stringify({ migrated: true, schema_version: doc.schema_version, file: file, vendors: Object.keys(doc.vendors) }, null, 2));
    return;
  }

  const vendor = opt('--vendor') || store.detectVendor();
  const key = opt('--key');
  const all = args.includes('--all');
  const isTopics = opt('--file') === 'topics';

  if (!vendor || (!key && !all)) {
    console.error('用法: query_task_loop_state [--file sessions|topics] --vendor <v> (--key <dot.path> | --all) | vendors | migrate');
    process.exit(1);
  }

  const file = isTopics ? topicsFile : sessionsFile;
  const partition = store.getPartition(file, vendor, {});
  if (!partition) {
    console.error(`未找到厂商分区: ${vendor} (${file})`);
    process.exit(1);
  }

  if (all) {
    console.log(JSON.stringify(partition, null, 2));
    return;
  }

  const value = store.getDotPath(partition, key);
  if (value === undefined) {
    console.error(`key 未命中: ${key} (vendor=${vendor})`);
    process.exit(1);
  }
  console.log(JSON.stringify(value, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { main };
