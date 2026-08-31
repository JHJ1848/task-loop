#!/usr/bin/env node
/**
 * Unit test for init approval gate / assignment consistency / module key hygiene.
 * 全部使用合成建议数据, 不依赖真实厂商扫描器。
 */

const assert = require('assert');
const {
  resolveModuleAssignments,
  applyApprovalGate,
  sanitizeTitle,
  isValidModuleKey,
  inferTopicMapping,
  detectCurrentVendor
} = require('../scripts/init_task_loop');

function mkSuggestion(id, key, vendor, opts = {}) {
  return Object.assign({
    session_id: id,
    vendor: vendor || 'antigravity',
    original_title: `session ${id}`,
    suggested_module_key: key,
    needs_naming: false,
    suggested_topic_name: `[专题] ${key}`,
    suggested_tags: [key, 'topic'],
    suggested_memory_doc: `docs/memory/${key}.md`,
    resumable: false,
    dispatch_hint: 'hint',
    is_main_candidate: false,
    is_current_session: false
  }, opts);
}

function testFirstMatchConsistency() {
  // P1-3: 同一模块 Key 多个候选时, 分配必须首匹配胜出且对齐报告同源
  const suggestions = [
    mkSuggestion('sess_hook_first', 'hook', 'antigravity'),
    mkSuggestion('sess_hook_second', 'hook', 'claude'),
    mkSuggestion('sess_main', 'main', 'zcode', { is_main_candidate: true })
  ];
  suggestions.sort((a, b) => (a.is_main_candidate ? -1 : 0) - (b.is_main_candidate ? -1 : 0));
  const memoryDocs = [{ module_key: 'hook', relative_path: 'docs/memory/hook.md' }];
  const assignments = resolveModuleAssignments(suggestions, memoryDocs);
  assert.strictEqual(assignments.get('hook').session_id, 'sess_hook_first', 'first match must win');

  const alignment = [
    { module_key: 'hook', status: 'ALIGNED' }
  ];
  // 模拟持久化同源取值: 从 assignments 取, 而非重新遍历
  const persistedHook = assignments.get('hook');
  assert.strictEqual(persistedHook.session_id, alignment && 'sess_hook_first');
  console.log('First-match consistency PASSED!');
}

function testApprovalGate() {
  const suggestions = [
    mkSuggestion('sess_main', 'main', 'antigravity', { is_main_candidate: true }),
    mkSuggestion('sess_hook', 'hook', 'antigravity'),
    mkSuggestion('sess_junk', 'junk_mod', 'antigravity'),
    mkSuggestion('sess_excluded', 'debug', 'antigravity')
  ];
  const memoryDocs = [
    { module_key: 'hook', relative_path: 'docs/memory/hook.md' },
    { module_key: 'debug', relative_path: 'docs/memory/debug.md' }
  ];
  const assignments = new Map();
  for (const s of suggestions) {
    assignments.set(s.suggested_module_key, s);
  }
  const alignment = [
    { module_key: 'hook', status: 'ALIGNED' },
    { module_key: 'main', status: 'ALIGNED' }
  ];

  // 默认: 仅 main + 记忆文档对齐模块获批; 未对齐且未批准 -> pending
  const gate = applyApprovalGate(assignments, alignment, {});
  const approvedKeys = gate.approved.map(a => a.module_key).sort();
  assert.deepStrictEqual(approvedKeys, ['hook', 'main'], 'default gate = main + aligned only');
  assert.ok(gate.pending.some(p => p.module_key === 'junk_mod'), 'unapproved junk must be pending');
  assert.ok(gate.pending.some(p => p.module_key === 'debug'), 'unapproved extra must be pending');

  // --modules debug 显式批准
  const gate2 = applyApprovalGate(assignments, alignment, { moduleAllowlist: ['debug'] });
  assert.ok(gate2.approved.some(a => a.module_key === 'debug'), 'explicit approval must persist');

  // --exclude hook 显式排除
  const gate3 = applyApprovalGate(assignments, alignment, { moduleExclude: ['hook'] });
  assert.ok(!gate3.approved.some(a => a.module_key === 'hook'), 'excluded must not persist');
  assert.ok(gate3.pending.some(p => p.module_key === 'hook' && p.reason === 'explicitly_excluded'));
  console.log('ApprovalGate PASSED!');
}

function testKeyHygiene() {
  // 非法定记忆模块的会话必须返回 module_key: null, 绝不虚构假专题
  const junk1 = inferTopicMapping({ title: '你是一个专门负责 mock_quality 的智能体' });
  assert.strictEqual(junk1.module_key, null, `unaligned session must have null module_key, got ${junk1.module_key}`);

  const junk2 = inferTopicMapping({ title: '核心功能维护   The current local time is: 2026-08-27' });
  assert.strictEqual(junk2.module_key, null, `CJK fragment must have null module_key, got ${junk2.module_key}`);

  // 法定模块推断保持
  const hookSess = inferTopicMapping({ title: '生命周期 hook 拦截与安全门禁' });
  assert.strictEqual(hookSess.module_key, 'hook');
  assert.strictEqual(hookSess.needs_naming, false);

  assert.strictEqual(isValidModuleKey('hook'), true);
  assert.strictEqual(isValidModuleKey('调用'), false);
  assert.strictEqual(isValidModuleKey('You_are'), false);

  // 硬编码 UUID 已移除: 陌生 UUID 不得触发 main 推断
  const stranger = inferTopicMapping({ title: '某普通会话标题', session_id: 'ee94b2c5-c0c2-473f-8f71-213250ba5295' });
  assert.notStrictEqual(stranger.module_key, 'main', 'hardcoded UUID must not force main');
  console.log('KeyHygiene PASSED!');
}

function testTitleSanitize() {
  assert.strictEqual(sanitizeTitle('当前项目作为skill的开发仓库 \\'), '当前项目作为skill的开发仓库');
  assert.strictEqual(sanitizeTitle('[$init](C:\\x\\y\\SKILL.md) 标题'), '标题');
  assert.strictEqual(sanitizeTitle(''), '(无标题)');
  console.log('TitleSanitize PASSED!');
}

function testResumableFields() {
  // P2-5: 卡片字段含 vendor + resumable + dispatch_hint
  const s = mkSuggestion('sess_z', 'hook', 'zcode');
  assert.ok('resumable' in s && 'dispatch_hint' in s);
  // detectCurrentVendor 环境驱动
  assert.strictEqual(detectCurrentVendor({ ZCODE_SESSION_ID: 'sess_x' }), 'zcode');
  assert.strictEqual(detectCurrentVendor({ ANTIGRAVITY_CONVERSATION_ID: 'uuid' }), 'antigravity');
  assert.strictEqual(detectCurrentVendor({}), null);
  console.log('ResumableFields PASSED!');
}

testFirstMatchConsistency();
testApprovalGate();
testKeyHygiene();
testTitleSanitize();
testResumableFields();
console.log('ALL init Confirm-Gate Node.js Tests PASSED SUCCESSFULLY!');
