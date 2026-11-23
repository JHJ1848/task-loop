#!/usr/bin/env node
'use strict';

/**
 * Deterministic Codex hook scenarios and an opt-in real-process comparison.
 * Run: node tests/test_hooks_codex.test.js
 * Benchmark: node tests/test_hooks_codex.test.js --benchmark --baseline <installed-plugin-root>
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const intake = require('../scripts/hooks/codex_main_intake');
const health = require('../scripts/hooks/codex_session_health');
const exporter = require('../scripts/export_codex_plugin');

const ROOT = path.resolve(__dirname, '..');
const MAIN = '01a1e232-ad27-78e1-a944-4eba8b7ae3dd';
const TOPIC = '01a0aeb3-646e-7463-8da6-d5d68cb15083';
const OTHER = '01a1e233-ad27-78e1-a944-4eba8b7ae3dd';
const NOW = Date.parse('2026-11-23T04:00:00Z');
const DAY = 86400000;
const MIB = 1024 * 1024;
let passed = 0;
let failed = 0;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-loop-codex-'));
  const registryFile = path.join(root, '.agents', 'task-loop', 'sessions.json');
  const transcript = path.join(root, 'current.jsonl');
  const env = { PLUGIN_DATA: path.join(root, 'plugin-data') };
  const registry = {
    schema_version: 5, vendors: {
      codex: { vendor: 'codex', main_thread_id: MAIN, modules: {
        hook: { session_id: TOPIC, resumable: true, id_kind: 'threadId' }
      }, sessions: [] },
      antigravity: { main_thread_id: OTHER }
    }
  };
  const meta = { id: MAIN, session_id: MAIN, thread_source: 'user', timestamp: new Date(NOW).toISOString() };
  writeJson(registryFile, registry);
  const f = {
    root, registryFile, transcript, env, registry, meta,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: MAIN, cwd: root, transcript_path: transcript },
    saveRegistry() { writeJson(registryFile, registry); },
    saveMeta(value = meta) {
      fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: value }) + '\n', 'utf8');
    },
    run(payload = this.payload, envValue = env, now = NOW) { return intake.processPayload(payload, envValue, now); },
    close() { fs.rmSync(root, { recursive: true, force: true }); }
  };
  f.saveMeta();
  return f;
}

function test(name, fn) {
  const f = fixture();
  try { fn(f); passed += 1; }
  catch (err) { failed += 1; console.error('FAIL ' + name + ': ' + err.stack); }
  finally { f.close(); }
}

function isMain(output) { return Boolean(output.hookSpecificOutput && output.hookSpecificOutput.additionalContext); }
function isHealth(output) { return typeof output.systemMessage === 'string'; }
function quiet(f, payload = f.payload, env = f.env) { assert.deepStrictEqual(f.run(payload, env), {}); }
function age(f, days) { f.meta.timestamp = new Date(NOW - days * DAY).toISOString(); f.saveMeta(); }
function topic(f) {
  f.payload.session_id = TOPIC;
  f.meta.id = TOPIC; f.meta.session_id = TOPIC;
  f.meta.thread_source = 'agent_created_thread'; f.saveMeta();
}

function countIO(fn, transcript, registryFile) {
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const descriptors = new Set();
  const counts = { transcriptOpens: 0, transcriptBytes: 0, registryReads: 0 };
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(fs, file, ...args);
    if (String(file) === transcript) { descriptors.add(fd); counts.transcriptOpens += 1; }
    return fd;
  };
  fs.readSync = function(fd, ...args) {
    const n = originalRead.call(fs, fd, ...args);
    if (descriptors.has(fd)) counts.transcriptBytes += n;
    return n;
  };
  fs.readFileSync = function(file, ...args) {
    if (String(file) === registryFile) counts.registryReads += 1;
    return originalReadFile.call(fs, file, ...args);
  };
  fs.closeSync = function(fd) {
    descriptors.delete(fd);
    return originalClose.call(fs, fd);
  };
  try { return { output: fn(), counts }; }
  finally { fs.openSync = originalOpen; fs.readSync = originalRead; fs.readFileSync = originalReadFile; fs.closeSync = originalClose; }
}

test('registered Main produces a short dispatch context', f => {
  const out = f.run();
  assert.ok(isMain(out)); assert.ok(!isHealth(out));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  for (const text of ['send_message_to_thread', 'wait_threads', 'bugfix-dev', 'Allowlist', 'resumable=true', 'id_kind=threadId']) {
    assert.ok(out.hookSpecificOutput.additionalContext.includes(text));
  }
  assert.ok(Buffer.byteLength(out.hookSpecificOutput.additionalContext, 'utf8') <= 300);
});
test('fresh registered topic has no Main context or health output', f => { topic(f); quiet(f); });
test('registered agent-created topic receives health', f => { topic(f); age(f, 30); assert.ok(isHealth(f.run())); });
test('agent-created registered Main is a top-level thread', f => { f.meta.thread_source = 'agent_created_thread'; f.saveMeta(); assert.ok(isMain(f.run())); });
test('Main dispatch and health coexist', f => { age(f, 30); const out = f.run(); assert.ok(isMain(out) && isHealth(out)); });
test('unregistered old thread stays quiet', f => { f.payload.session_id = OTHER; f.meta.id = OTHER; f.meta.session_id = OTHER; age(f, 90); quiet(f); });
test('no registry stays quiet', f => { fs.unlinkSync(f.registryFile); quiet(f); });
test('missing transcript is not top-level proof', f => { delete f.payload.transcript_path; quiet(f); });
test('missing transcript file stays quiet', f => { fs.unlinkSync(f.transcript); quiet(f); });
test('relative transcript path is rejected', f => { f.payload.transcript_path = 'current.jsonl'; quiet(f); });
test('directory transcript is rejected', f => { f.payload.transcript_path = f.root; quiet(f); });
test('environment session ID alone is not proof', f => { delete f.payload.transcript_path; quiet(f, f.payload, { CODEX_THREAD_ID: MAIN }); });
for (const event of ['SessionStart', 'Stop', 'PreToolUse', '', 'userpromptsubmit']) {
  test('unregistered event ' + event, f => { quiet(f, { ...f.payload, hook_event_name: event }); });
}
for (const value of [null, [], {}, 'text', 1]) {
  test('malformed payload ' + JSON.stringify(value), f => quiet(f, value));
}
for (const id of [null, '', '../outside', 'client-new-thread:queued', 123]) {
  test('invalid session ID ' + id, f => quiet(f, { ...f.payload, session_id: id }));
}
for (const vendor of ['antigravity', 'claude', 'zcode', 'unknown']) {
  test('other declared vendor ' + vendor, f => quiet(f, { ...f.payload, vendor }));
}
for (const key of ['ANTIGRAVITY_CONVERSATION_ID', 'ZCODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDECODE']) {
  test('other host environment ' + key, f => quiet(f, f.payload, { ...f.env, [key]: 'other-host' }));
}
for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
  test('conflicting current identity ' + key, f => quiet(f, f.payload, { ...f.env, [key]: OTHER }));
}
for (const key of ['sessionId', 'sessionID']) {
  test('supported identity alias ' + key, f => {
    const p = { ...f.payload }; delete p.session_id; p[key] = MAIN; assert.ok(isMain(f.run(p)));
  });
}
for (const key of ['hookEventName', 'event', 'eventName']) {
  test('supported event alias ' + key, f => {
    const p = { ...f.payload }; delete p.hook_event_name; p[key] = 'UserPromptSubmit'; assert.ok(isMain(f.run(p)));
  });
}
for (const key of ['parent_thread_id', 'parentThreadId', 'parent_session_id', 'parentSessionId', 'is_subagent', 'isSubagent']) {
  test('nested payload evidence ' + key, f => quiet(f, { ...f.payload, [key]: 'parent' }));
}
for (const source of ['subagent', 'unknown', { subagent: { parent_thread_id: MAIN } }]) {
  test('nested payload source ' + JSON.stringify(source), f => quiet(f, { ...f.payload, thread_source: source }));
}
test('nested transcript with inherited parent session ID', f => {
  f.meta.thread_source = 'subagent'; f.meta.parent_thread_id = MAIN; f.saveMeta(); quiet(f);
});
test('transcript parent alone disqualifies root label', f => { f.meta.parent_thread_id = OTHER; f.saveMeta(); quiet(f); });
test('conflicting transcript id is rejected even if session_id matches', f => { f.meta.id = OTHER; f.saveMeta(); quiet(f); });
test('conflicting transcript session_id is rejected even if id matches', f => { f.meta.session_id = OTHER; f.saveMeta(); quiet(f); });
test('matching legacy metadata id alone is supported', f => { delete f.meta.session_id; f.saveMeta(); assert.ok(isMain(f.run())); });
test('matching metadata session_id alone is supported', f => { delete f.meta.id; f.saveMeta(); assert.ok(isMain(f.run())); });
test('metadata without identity is rejected', f => { delete f.meta.id; delete f.meta.session_id; f.saveMeta(); quiet(f); });
test('metadata without source is rejected', f => { delete f.meta.thread_source; f.saveMeta(); quiet(f); });
test('wrong first-record type stays quiet', f => {
  fs.writeFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: f.meta }) + '\n'); quiet(f);
});
test('malformed first record stays quiet', f => { fs.writeFileSync(f.transcript, '{broken\n'); quiet(f); });
test('incomplete first record stays quiet', f => { fs.writeFileSync(f.transcript, JSON.stringify({ type: 'session_meta', payload: f.meta })); quiet(f); });
test('oversized metadata stays bounded and quiet', f => {
  f.meta.padding = 'x'.repeat(262144); f.saveMeta();
  const { output, counts } = countIO(() => f.run(), f.transcript, f.registryFile);
  assert.deepStrictEqual(output, {}); assert.strictEqual(counts.transcriptBytes, 262144);
});
test('UTF-8 metadata split across chunks is read correctly', f => {
  f.meta.padding = '上下文'.repeat(2500); f.saveMeta(); assert.ok(isMain(f.run()));
});
for (const version of [3, 4, 5]) {
  test('partitioned registry version ' + version, f => { f.registry.schema_version = version; f.saveRegistry(); assert.ok(isMain(f.run())); });
}
test('Codex mirror used only if unified registry is absent', f => {
  fs.renameSync(f.registryFile, path.join(path.dirname(f.registryFile), 'sessions.codex.json')); assert.ok(isMain(f.run()));
});
test('flat explicit Codex mirror remains supported', f => {
  fs.unlinkSync(f.registryFile);
  writeJson(path.join(path.dirname(f.registryFile), 'sessions.codex.json'), { schema_version: 2, vendor: 'codex', main_thread_id: MAIN });
  assert.ok(isMain(f.run()));
});
test('legacy Codex v1 registration remains supported', f => {
  fs.unlinkSync(f.registryFile); writeJson(path.join(f.root, '.codex/task-loop/sessions.json'), { schema_version: 1, main_thread_id: MAIN });
  assert.ok(isMain(f.run()));
});
test('current unified registry overrides stale mirror and legacy Main', f => {
  f.registry.vendors.codex.main_thread_id = OTHER; f.saveRegistry();
  writeJson(path.join(path.dirname(f.registryFile), 'sessions.codex.json'), { schema_version: 2, vendor: 'codex', main_thread_id: MAIN });
  writeJson(path.join(f.root, '.codex/task-loop/sessions.json'), { schema_version: 1, main_thread_id: MAIN });
  quiet(f);
});
test('missing Codex partition cannot borrow another vendor', f => { delete f.registry.vendors.codex; f.registry.vendors.antigravity.main_thread_id = MAIN; f.saveRegistry(); quiet(f); });
test('corrupt unified registry cannot fall back to legacy', f => {
  fs.writeFileSync(f.registryFile, '{broken'); writeJson(path.join(f.root, '.codex/task-loop/sessions.json'), { schema_version: 1, main_thread_id: MAIN }); quiet(f);
});
test('v4 without vendors cannot claim legacy Main', f => { writeJson(f.registryFile, { schema_version: 4, vendor: 'codex', main_thread_id: MAIN }); quiet(f); });
test('partition vendor mismatch is rejected', f => { f.registry.vendors.codex.vendor = 'claude'; f.saveRegistry(); quiet(f); });
test('retired Main binding stays quiet', f => { f.registry.vendors.codex.modules.main = { session_id: MAIN, resumable: false }; f.saveRegistry(); quiet(f); });
test('non-formal Main binding stays quiet', f => { f.registry.vendors.codex.modules.main = { session_id: MAIN, id_kind: 'clientThreadId' }; f.saveRegistry(); quiet(f); });
for (const change of [{ resumable: false }, { id_kind: 'rollout_id' }, { resumable: undefined }, { vendor: 'claude' }]) {
  test('invalid topic binding ' + JSON.stringify(change), f => {
    topic(f); age(f, 30); Object.assign(f.registry.vendors.codex.modules.hook, change); f.saveRegistry(); quiet(f);
  });
}
test('session-array is_main cannot override main_thread_id', f => {
  f.registry.vendors.codex.main_thread_id = OTHER;
  f.registry.vendors.codex.sessions = [{ session_id: MAIN, is_main: true }]; f.saveRegistry(); quiet(f);
});
test('module named main cannot override main_thread_id', f => {
  f.registry.vendors.codex.main_thread_id = OTHER;
  f.registry.vendors.codex.modules.main = { session_id: MAIN, resumable: true, id_kind: 'threadId' };
  f.saveRegistry(); assert.ok(!isMain(f.run()));
});
test('subdirectory resolves nearest registered project', f => {
  f.payload.cwd = path.join(f.root, 'src/deep'); fs.mkdirSync(f.payload.cwd, { recursive: true }); assert.ok(isMain(f.run()));
});
test('nested project cannot inherit parent Main over own registration', f => {
  const child = path.join(f.root, 'child');
  writeJson(path.join(child, '.codex/task-loop/sessions.json'), { schema_version: 1, main_thread_id: OTHER });
  f.payload.cwd = child; quiet(f);
});
function linkedWorktree(f) {
  const linked = path.join(f.root, 'linked');
  const admin = path.join(f.root, '.git', 'worktrees', 'linked');
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ' + admin + '\n');
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(admin, 'gitdir'), path.join(linked, '.git') + '\n');
  f.payload.cwd = linked;
  f.meta.cwd = linked; f.saveMeta();
  return { linked, admin };
}
test('linked worktree reuses main checkout registration without a subprocess', f => {
  linkedWorktree(f); assert.ok(isMain(f.run()));
});
test('linked registered topic gets health from shared checkout registry', f => {
  linkedWorktree(f); topic(f); age(f, 30); assert.ok(isHealth(f.run()));
});
test('relative gitdir worktree marker remains supported', f => {
  const { linked, admin } = linkedWorktree(f);
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ' + path.relative(linked, admin) + '\n');
  assert.ok(isMain(f.run()));
});
test('worktree missing reciprocal pointer stays quiet', f => {
  const { admin } = linkedWorktree(f); fs.unlinkSync(path.join(admin, 'gitdir')); quiet(f);
});
test('worktree wrong reciprocal pointer stays quiet', f => {
  const { admin } = linkedWorktree(f); fs.writeFileSync(path.join(admin, 'gitdir'), f.transcript); quiet(f);
});
test('worktree local registry overrides shared registration', f => {
  const { linked } = linkedWorktree(f);
  writeJson(path.join(linked, '.agents/task-loop/sessions.json'), { schema_version: 4, vendors: { codex: { main_thread_id: OTHER } } });
  quiet(f);
});
test('independent nested Git repository cannot borrow parent registration', f => {
  const child = path.join(f.root, 'independent'); fs.mkdirSync(path.join(child, '.git'), { recursive: true });
  f.payload.cwd = child; quiet(f);
});
test('invalid Git marker stops ancestor registration search', f => {
  const child = path.join(f.root, 'independent'); fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, '.git'), 'invalid'); f.payload.cwd = child; quiet(f);
});
for (const [days, expectedTier] of [[29, 0], [30, 1], [59, 1], [60, 2]]) {
  test('exact age boundary ' + days, f => {
    age(f, days); const out = f.run(); assert.strictEqual(isHealth(out), expectedTier > 0);
    if (expectedTier) assert.ok(out.systemMessage.includes(expectedTier === 2 ? '已明显增长' : '已接近'));
  });
}
for (const [size, tier] of [[8 * MIB - 1, 0], [8 * MIB, 1], [16 * MIB - 1, 1], [16 * MIB, 2]]) {
  test('exact size boundary ' + size, f => {
    fs.truncateSync(f.transcript, size);
    assert.strictEqual(isHealth(f.run()), tier > 0);
    assert.strictEqual(health.warningTier(size, 0), tier);
  });
}
test('future timestamp does not create a false age warning', f => { age(f, -5); assert.ok(!isHealth(f.run())); });
test('invalid timestamp still allows size warning', f => {
  f.meta.timestamp = 'invalid'; f.saveMeta(); fs.truncateSync(f.transcript, 8 * MIB);
  assert.ok(f.run().systemMessage.includes('创建时间未知'));
});
test('health tier suppressed within seven days without suppressing Main', f => {
  age(f, 30); assert.ok(isHealth(f.run())); const next = f.run(); assert.ok(isMain(next)); assert.ok(!isHealth(next));
});
test('health tier repeats exactly seven days later', f => {
  age(f, 30); f.run(); assert.ok(!isHealth(f.run(f.payload, f.env, NOW + 7 * DAY - 1)));
  assert.ok(isHealth(f.run(f.payload, f.env, NOW + 7 * DAY)));
});
test('health tier upgrade is immediate', f => {
  age(f, 30); f.run(); fs.truncateSync(f.transcript, 16 * MIB); assert.ok(isHealth(f.run()));
});
test('independent prompts always get Main context', f => { assert.ok(isMain(f.run())); assert.ok(isMain(f.run())); });
test('missing PLUGIN_DATA cannot remove Main dispatch', f => { age(f, 60); assert.ok(isMain(f.run(f.payload, {}))); });
test('unwritable data path cannot remove Main dispatch', f => {
  age(f, 60); fs.writeFileSync(f.env.PLUGIN_DATA, 'blocked');
  assert.ok(isMain(f.run()));
});
test('corrupt cooldown cannot remove Main dispatch', f => {
  age(f, 60); fs.mkdirSync(path.join(f.env.PLUGIN_DATA, 'codex-session-health'), { recursive: true });
  fs.writeFileSync(path.join(f.env.PLUGIN_DATA, 'codex-session-health', MAIN + '.json'), '{broken');
  assert.ok(isMain(f.run()));
});
test('no project state writes for Main advisory', f => {
  const before = fs.readFileSync(f.registryFile, 'utf8'); f.run();
  assert.strictEqual(fs.readFileSync(f.registryFile, 'utf8'), before);
  assert.ok(!fs.existsSync(f.env.PLUGIN_DATA));
});
test('combined long Main shares identity read and bounds its history proof', f => {
  age(f, 60); fs.truncateSync(f.transcript, 16 * MIB);
  const { output, counts } = countIO(() => f.run(), f.transcript, f.registryFile);
  assert.ok(isMain(output) && isHealth(output));
  assert.strictEqual(counts.transcriptOpens, 1); assert.strictEqual(counts.registryReads, 1);
  assert.ok(counts.transcriptBytes <= 4096 + 65536);
});
test('unregistered prompt never opens transcript', f => {
  const { output, counts } = countIO(() => f.run({ ...f.payload, session_id: OTHER }), f.transcript, f.registryFile);
  assert.deepStrictEqual(output, {}); assert.strictEqual(counts.transcriptOpens, 0);
});
test('ordinary long prompt creates no cooldown files', f => {
  age(f, 60); quiet(f, { ...f.payload, session_id: OTHER }); assert.ok(!fs.existsSync(f.env.PLUGIN_DATA));
});
for (const raw of ['', '{broken', 'null', '[]', '42']) {
  test('real process invalid stdin ' + raw, f => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/hooks/codex_main_intake.js')], { input: raw, encoding: 'utf8' });
    assert.strictEqual(res.status, 0); assert.strictEqual(res.stdout, ''); assert.strictEqual(res.stderr, '');
  });
}
test('real process emits one JSON containing both reminders', f => {
  age(f, 60);
  const env = { ...process.env, CODEX_THREAD_ID: MAIN, CODEX_SESSION_ID: MAIN, PLUGIN_DATA: f.env.PLUGIN_DATA };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ZCODE_SESSION_ID']) delete env[key];
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/hooks/codex_main_intake.js')], { input: JSON.stringify(f.payload), encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout); assert.ok(isMain(out) && isHealth(out));
  assert.strictEqual(res.stderr, '');
});
test('Codex manifest registers exactly the combined entry', f => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex-plugin/plugin.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, manifest.hooks), 'utf8'));
  assert.deepStrictEqual(Object.keys(config.hooks), ['UserPromptSubmit']);
  const commands = config.hooks.UserPromptSubmit.flatMap(group => group.hooks).map(hook => hook.command);
  assert.deepStrictEqual(commands, ['node "${PLUGIN_ROOT}/scripts/hooks/codex_main_intake.js"']);
  assert.ok(!JSON.stringify(config).includes('resolve_or_create_session'));
});
function copyHookPackage(f) {
  const target = path.join(f.root, 'package');
  for (const file of ['hooks/codex-session-health.json', 'scripts/hooks/codex_main_intake.js', 'scripts/hooks/codex_session_health.js']) {
    const dest = path.join(target, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), dest);
  }
  return target;
}
test('isolated exported Hook dependency closure executes both reminders', f => {
  const target = copyHookPackage(f);
  exporter.validateHookReachability(target);
  age(f, 60);
  const out = require(path.join(target, 'scripts/hooks/codex_main_intake.js')).processPayload(f.payload, f.env, NOW);
  assert.ok(isMain(out) && isHealth(out));
  assert.ok(!fs.existsSync(path.join(target, 'scripts/hooks/resolve_or_create_session.js')));
});
test('export rejects extra auto-provisioner command', f => {
  const target = copyHookPackage(f);
  const file = path.join(target, 'hooks/codex-session-health.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'node "${PLUGIN_ROOT}/scripts/hooks/resolve_or_create_session.js"' });
  writeJson(file, config);
  assert.throws(() => exporter.validateHookReachability(target));
});
test('export rejects misplaced lifecycle event', f => {
  const target = copyHookPackage(f);
  const file = path.join(target, 'hooks/codex-session-health.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.hooks.PreToolUse = config.hooks.UserPromptSubmit; delete config.hooks.UserPromptSubmit;
  writeJson(file, config);
  assert.throws(() => exporter.validateHookReachability(target));
});
test('export rejects missing health dependency', f => {
  const target = copyHookPackage(f);
  fs.unlinkSync(path.join(target, 'scripts/hooks/codex_session_health.js'));
  assert.throws(() => exporter.validateHookReachability(target));
});
test('source check and formal export report the same candidate skill summary', f => {
  const source = exporter.validateSource(ROOT);
  const exported = exporter.exportCandidate(ROOT, path.join(f.root, 'candidate'));
  assert.deepStrictEqual(exported.skill_summary, source.skill_summary);
  assert.strictEqual(source.skill_summary.count, exporter.SOURCE_DIRS.filter(value => value.startsWith('skills/')).length);
  assert.strictEqual(source.skill_summary.entry_utf8.budget_per_skill_bytes, 2048);
  assert.ok(source.skill_summary.entry_utf8.total_bytes >= source.skill_summary.description_utf8.total_bytes);
});
test('candidate skill checks reject missing entries and unpackaged local references', f => {
  const root = path.join(f.root, 'skill-check');
  const skillPath = path.join(root, 'skills', 'demo');
  fs.mkdirSync(skillPath, { recursive: true });
  const sourceDirs = ['skills/demo'];
  const validate = () => exporter.validateSkillEntrypoints(
    root,
    exporter.buildPackageInventory(root, sourceDirs, [], []),
    sourceDirs,
  );
  assert.throws(validate, /缺少必需文件/);
  fs.writeFileSync(
    path.join(skillPath, 'SKILL.md'),
    '---\nname: demo\ndescription: local link check\n---\n[missing](../../outside.md)\n',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'outside.md'), '# not packaged\n', 'utf8');
  assert.throws(validate, /未打包的本地资源/);
});
test('oversized but valid Skill entry remains exportable with an advisory', f => {
  const root = path.join(f.root, 'skill-budget');
  const skillPath = path.join(root, 'skills', 'demo');
  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(skillPath, 'empty'), { recursive: true });
  const sourceDirs = ['skills/demo'];
  fs.writeFileSync(path.join(skillPath, 'resource (v1).md'), '# Resource\n', 'utf8');
  fs.writeFileSync(
    path.join(skillPath, 'SKILL.md'),
    `---\nname: demo\ndescription: ${'x'.repeat(2049)}\n---\n# Demo\n[remote](https://example.test) [section](#demo) [local](<resource (v1).md>) [root](../..) [empty](empty/) \`[example](not-packaged.md)\`\n`,
    'utf8',
  );
  const summary = exporter.validateSkillEntrypoints(
    root,
    exporter.buildPackageInventory(root, sourceDirs, [], []),
    sourceDirs,
  );
  assert.strictEqual(summary.entry_utf8.over_budget_entries.length, 1);
  assert.ok(summary.entry_utf8.advisory);
  assert.strictEqual(summary.description_utf8.max_bytes, 2049);
});

console.log('Codex hook scenarios: passed=' + passed + ', failed=' + failed);
if (failed) process.exitCode = 1;

function benchmark(baselineRoot) {
  const f = fixture();
  try {
    const baseline = path.resolve(baselineRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(baseline, '.codex-plugin/plugin.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(baseline, manifest.hooks), 'utf8'));
    const oldScripts = config.hooks.UserPromptSubmit.flatMap(group => group.hooks).map(hook => {
      const match = hook.command.match(/\$\{PLUGIN_ROOT\}\/([^"]+)"/);
      assert.ok(match, 'baseline command must be plugin-root relative');
      return path.join(baseline, match[1]);
    });
    const newScripts = [path.join(ROOT, 'scripts/hooks/codex_main_intake.js')];
    const env = { ...process.env, CODEX_THREAD_ID: MAIN, CODEX_SESSION_ID: MAIN, PLUGIN_DATA: f.env.PLUGIN_DATA };
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ZCODE_SESSION_ID']) delete env[key];
    const run = (scripts, payload) => {
      const started = performance.now();
      for (const script of scripts) {
        const runEnv = { ...env, CODEX_THREAD_ID: payload.session_id, CODEX_SESSION_ID: payload.session_id };
        const res = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', env: runEnv });
        assert.strictEqual(res.status, 0, res.stderr);
      }
      return performance.now() - started;
    };
    const summary = values => {
      values.sort((a, b) => a - b);
      return { median_ms: +values[Math.floor(values.length / 2)].toFixed(2), p95_ms: +values[Math.ceil(values.length * .95) - 1].toFixed(2) };
    };
    for (const [scenario, payload] of [['registered-main', f.payload], ['unregistered', { ...f.payload, session_id: OTHER }]]) {
      // Warm both paths, then alternate to avoid systematically favoring one.
      run(oldScripts, payload); run(newScripts, payload);
      const oldTimes = [], newTimes = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2) { newTimes.push(run(newScripts, payload)); oldTimes.push(run(oldScripts, payload)); }
        else { oldTimes.push(run(oldScripts, payload)); newTimes.push(run(newScripts, payload)); }
      }
      console.log(JSON.stringify({ benchmark: scenario, samples: 20, baseline_processes: oldScripts.length, current_processes: 1, baseline: summary(oldTimes), current: summary(newTimes) }));
    }
    age(f, 60); fs.truncateSync(f.transcript, 16 * MIB);
    const oldIntake = require(path.join(baseline, 'scripts/hooks/codex_main_intake.js'));
    const oldHealth = require(path.join(baseline, 'scripts/hooks/codex_session_health.js'));
    const oldIO = countIO(() => {
      oldIntake.processPayload(f.payload, f.env);
      oldHealth.checkSession(f.payload, f.env, NOW);
    }, f.transcript, f.registryFile).counts;
    const newIO = countIO(() => f.run(), f.transcript, f.registryFile).counts;
    console.log(JSON.stringify({ benchmark: '16-MiB-transcript-IO', baseline: oldIO, current: newIO }));
  } finally { f.close(); }
}

if (!failed && process.argv.includes('--benchmark')) {
  const index = process.argv.indexOf('--baseline');
  assert.ok(index >= 0 && process.argv[index + 1], '--baseline <installed-plugin-root> is required');
  benchmark(process.argv[index + 1]);
}
