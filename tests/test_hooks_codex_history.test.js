#!/usr/bin/env node
'use strict';

/** Bounded transcript-proof tests; no native runtime or persisted dedupe state. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { additionalContext, processPayload } = require('../scripts/hooks/codex_main_intake');

const NOW = Date.parse('2026-11-23T08:00:00Z');
const DAY = 86400000;
const MAIN = 'codex-history-main-thread';
const TOPIC = 'codex-history-topic-thread';
const HINT = additionalContext();
let passed = 0;
let failed = 0;

function message(text = HINT, role = 'developer', type = 'input_text') {
  return { type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } };
}
function event(type = 'token_count') { return { type: 'event_msg', payload: { type } }; }
function mainContext(output) { return Boolean(output.hookSpecificOutput); }

function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-hook-'));
  const transcript = path.join(root, 'current.jsonl');
  const registryFile = path.join(root, '.agents/task-loop/sessions.json');
  const env = { PLUGIN_DATA: path.join(root, 'plugin-data') };
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({ schema_version: 5, vendors: {
    codex: { main_thread_id: MAIN, modules: { hook: { session_id: TOPIC, id_kind: 'threadId', resumable: true } } }
  } }));
  const meta = { type: 'session_meta', payload: { id: MAIN, session_id: MAIN, thread_source: 'user', timestamp: new Date(NOW).toISOString() } };
  const f = {
    root, transcript, registryFile, env, meta,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: MAIN, cwd: root, transcript_path: transcript },
    append(record) { fs.appendFileSync(transcript, JSON.stringify(record) + '\n'); },
    raw(text) { fs.appendFileSync(transcript, text); },
    reset() { fs.writeFileSync(transcript, JSON.stringify(meta) + '\n'); },
    run(now = NOW) { return processPayload(this.payload, env, now); },
    expectSend() { assert.ok(mainContext(this.run()), 'Main reminder should be sent'); },
    expectSkip() { assert.ok(!mainContext(this.run()), 'proven persisted Main reminder should not be repeated'); }
  };
  f.reset();
  try { fn(f); passed += 1; }
  catch (err) { failed += 1; console.error('FAIL ' + name + ': ' + err.stack); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('first valid Main turn injects', f => f.expectSend());
test('three native-shaped turns retain one developer reminder', f => {
  const counts = [];
  for (let turn = 0; turn < 3; turn++) {
    f.append(event('task_started')); f.append(event('user_message'));
    const out = f.run();
    if (mainContext(out)) f.append(message(out.hookSpecificOutput.additionalContext));
    f.append({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } });
    f.append(event('task_complete'));
    const records = fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(JSON.parse);
    counts.push(records.filter(r => r.type === 'response_item' && r.payload.role === 'developer' && r.payload.content[0].text === HINT).length);
  }
  assert.deepStrictEqual(counts, [1, 1, 1]);
});
test('failed injection that never persisted retries immediately', f => { f.expectSend(); f.expectSend(); });
test('failed injection can persist on retry and then deduplicate', f => {
  f.expectSend(); f.expectSend(); f.append(message()); f.expectSkip();
});
test('fresh Hook processes deduplicate persisted history and recover after reset', f => {
  const env = { ...process.env, CODEX_THREAD_ID: MAIN, CODEX_SESSION_ID: MAIN };
  for (const key of ['PLUGIN_DATA', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ZCODE_SESSION_ID']) delete env[key];
  const invoke = () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/hooks/codex_main_intake.js')], {
      input: JSON.stringify(f.payload), encoding: 'utf8', env
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
  const first = invoke(); assert.ok(mainContext(first));
  f.append(message(first.hookSpecificOutput.additionalContext));
  assert.deepStrictEqual(invoke(), {});
  f.reset(); assert.ok(mainContext(invoke()));
});
test('exact developer response item deduplicates', f => { f.append(message()); f.expectSkip(); });
for (const role of ['user', 'assistant', 'system', 'Developer', null]) {
  test('quoted hint with role ' + role + ' is untrusted', f => { f.append(message(HINT, role)); f.expectSend(); });
}
for (const contentType of ['output_text', 'text', '', null]) {
  test('wrong developer content type ' + contentType, f => { f.append(message(HINT, 'developer', contentType)); f.expectSend(); });
}
for (const text of ['prefix ' + HINT, HINT + ' suffix', HINT + ' ', HINT.slice(1), HINT.replace('WORK', 'work')]) {
  test('approximate developer text cannot deduplicate ' + text.length, f => { f.append(message(text)); f.expectSend(); });
}
test('old instruction version cannot deduplicate current version', f => { f.append(message('[task-loop Main] previous instructions')); f.expectSend(); });
test('split text fragments are not an exact full message', f => {
  const record = message();
  record.payload.content = [{ type: 'input_text', text: HINT.slice(0, 30) }, { type: 'input_text', text: HINT.slice(30) }];
  f.append(record); f.expectSend();
});
test('additional developer content is not the exact full message', f => {
  const record = message(); record.payload.content.push({ type: 'input_text', text: 'other' }); f.append(record); f.expectSend();
});
test('event_msg developer imitation is not a response_item', f => {
  const record = message(); record.type = 'event_msg'; f.append(record); f.expectSend();
});
test('assistant event echo is untrusted', f => {
  f.append({ type: 'event_msg', payload: { type: 'agent_message', message: HINT } }); f.expectSend();
});
test('text containing serialized developer JSON is untrusted', f => { f.append(message(JSON.stringify(message()), 'user')); f.expectSend(); });
for (const kind of ['compacted', 'clear', 'context_reset', 'unknown_record', 'session_meta']) {
  test('top-level ' + kind + ' after hint requires reinjection', f => {
    f.append(message()); f.append({ type: kind, payload: {} }); f.expectSend();
  });
}
for (const kind of ['context_compacted', 'context_cleared', 'context_reset', 'history_cleared', 'clear', 'turn_rolled_back', 'unknown_event']) {
  test('event boundary ' + kind + ' after hint requires reinjection', f => {
    f.append(message()); f.append(event(kind)); f.expectSend();
  });
}
test('new hint after compaction can deduplicate', f => { f.append({ type: 'compacted', payload: { message: HINT } }); f.append(message()); f.expectSkip(); });
test('compaction replacement-history quoting hint cannot deduplicate', f => {
  f.append({ type: 'compacted', payload: { replacement_history: [message()] } }); f.expectSend();
});
test('clear then fresh injection establishes a new proof', f => {
  f.append(message()); f.append(event('context_cleared')); f.expectSend(); f.append(message()); f.expectSkip();
});
for (const kind of ['reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call']) {
  test('recognized response item ' + kind + ' preserves proof', f => {
    f.append(message()); f.append({ type: 'response_item', payload: { type: kind } }); f.expectSkip();
  });
}
for (const kind of ['task_started', 'task_complete', 'token_count', 'item_completed', 'user_message', 'agent_message']) {
  test('known event ' + kind + ' preserves proof', f => { f.append(message()); f.append(event(kind)); f.expectSkip(); });
}
for (const kind of ['turn_context', 'token_usage_record']) {
  test('known telemetry ' + kind + ' preserves proof', f => {
    f.append(message()); f.append({ type: kind, payload: {} }); f.expectSkip();
  });
}
test('unknown response item prevents suppression', f => {
  f.append(message()); f.append({ type: 'response_item', payload: { type: 'new_unknown_type' } }); f.expectSend();
});
test('null payload prevents suppression', f => { f.append(message()); f.append({ type: 'event_msg', payload: null }); f.expectSend(); });
test('array payload prevents suppression', f => { f.append(message()); f.append({ type: 'event_msg', payload: [] }); f.expectSend(); });
test('message without content prevents suppression', f => {
  f.append(message()); f.append({ type: 'response_item', payload: { type: 'message', role: 'developer' } }); f.expectSend();
});
test('broken line newer than hint requires reinjection', f => { f.append(message()); f.raw('{broken\n'); f.expectSend(); });
test('partial final line newer than hint requires reinjection', f => { f.append(message()); f.raw('{"type":"event_msg"'); f.expectSend(); });
test('blank line newer than hint requires reinjection', f => { f.append(message()); f.raw('\n'); f.expectSend(); });
test('broken old line before a complete fresh hint does not invalidate it', f => { f.raw('{broken\n'); f.append(message()); f.expectSkip(); });
test('recent hint in long log deduplicates after discarding prefix fragment', f => {
  f.append({ type: 'token_usage_record', payload: { padding: 'x'.repeat(80000) } }); f.append(message()); f.expectSkip();
});
test('hint outside bounded tail is conservatively resent', f => {
  f.append(message()); f.append({ type: 'token_usage_record', payload: { padding: 'x'.repeat(80000) } }); f.expectSend();
});
test('partial candidate cut at tail boundary cannot suppress', f => {
  f.append(message()); f.append({ type: 'token_usage_record', payload: { padding: 'x'.repeat(65300) } }); f.expectSend();
});
test('truncated history recovers reminder', f => { f.append(message()); f.expectSkip(); f.reset(); f.expectSend(); });

function instrument(f, fn) {
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
  const tracked = new Set();
  const counts = { opens: 0, reads: [] };
  fs.openSync = function(file, ...args) {
    const fd = open.call(fs, file, ...args);
    if (String(file) === f.transcript) { tracked.add(fd); counts.opens += 1; }
    return fd;
  };
  fs.readSync = function(fd, buffer, offset, length, position) {
    const n = read.call(fs, fd, buffer, offset, length, position);
    if (tracked.has(fd)) counts.reads.push({ position, requested: length, actual: n });
    return n;
  };
  fs.closeSync = function(fd) { tracked.delete(fd); return close.call(fs, fd); };
  try { return { output: fn(), counts }; }
  finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; }
}
test('16 MiB log has one tail read capped at 64 KiB', f => {
  fs.truncateSync(f.transcript, 16 * 1024 * 1024);
  const { output, counts } = instrument(f, () => f.run());
  assert.ok(mainContext(output));
  const tailReads = counts.reads.filter(r => r.position > 0);
  assert.strictEqual(counts.opens, 1);
  assert.strictEqual(tailReads.length, 1);
  assert.strictEqual(tailReads[0].requested, 65536);
  assert.strictEqual(tailReads[0].actual, 65536);
  assert.ok(counts.reads.reduce((sum, r) => sum + r.actual, 0) <= 4096 + 65536);
});
test('dedupe closes the shared descriptor exactly once', f => {
  f.append(message());
  const open = fs.openSync, close = fs.closeSync;
  let transcriptFd;
  let opens = 0, closes = 0;
  fs.openSync = function(file, ...args) {
    const fd = open.call(fs, file, ...args);
    if (String(file) === f.transcript) { transcriptFd = fd; opens += 1; }
    return fd;
  };
  fs.closeSync = function(fd) {
    if (fd === transcriptFd) closes += 1;
    return close.call(fs, fd);
  };
  try { f.expectSkip(); assert.strictEqual(opens, 1); assert.strictEqual(closes, 1); }
  finally { fs.openSync = open; fs.closeSync = close; }
});
test('unknown message role after hint forces conservative resend', f => {
  f.append(message()); f.append(message('new role', 'future-role')); f.expectSend();
});
test('registered topic does no tail read', f => {
  f.payload.session_id = TOPIC;
  f.meta.payload.id = TOPIC; f.meta.payload.session_id = TOPIC; f.reset();
  fs.truncateSync(f.transcript, 16 * 1024 * 1024);
  const { output, counts } = instrument(f, () => f.run());
  assert.ok(!mainContext(output)); assert.ok(output.systemMessage);
  assert.strictEqual(counts.opens, 1);
  assert.ok(counts.reads.every(r => r.position === 0));
});
test('unregistered session does no transcript read', f => {
  f.payload.session_id = 'unregistered-history-thread';
  const { output, counts } = instrument(f, () => f.run());
  assert.deepStrictEqual(output, {}); assert.strictEqual(counts.opens, 0);
});
test('dedupe is independent of health cooldown', f => {
  f.meta.payload.timestamp = new Date(NOW - 30 * DAY).toISOString(); f.reset();
  const first = f.run(); assert.ok(mainContext(first) && first.systemMessage);
  f.append(message()); assert.deepStrictEqual(f.run(), {});
  const nextWeek = f.run(NOW + 7 * DAY);
  assert.ok(!mainContext(nextWeek) && nextWeek.systemMessage);
});
test('health read/write failure cannot suppress first Main reminder', f => {
  f.meta.payload.timestamp = new Date(NOW - 30 * DAY).toISOString(); f.reset();
  fs.writeFileSync(f.env.PLUGIN_DATA, 'blocked'); f.expectSend();
});
test('health failure cannot make persisted Main reminder repeat', f => {
  f.meta.payload.timestamp = new Date(NOW - 30 * DAY).toISOString(); f.reset();
  fs.writeFileSync(f.env.PLUGIN_DATA, 'blocked'); f.append(message()); assert.deepStrictEqual(f.run(), {});
});
test('deduplication writes no extra marker', f => {
  delete f.env.PLUGIN_DATA;
  const before = fs.readFileSync(f.registryFile, 'utf8');
  f.append(message()); f.expectSkip();
  assert.strictEqual(fs.readFileSync(f.registryFile, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(f.root).sort(), ['.agents', 'current.jsonl']);
});
test('tail read error conservatively resends', f => {
  f.append(message());
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = function(...args) {
    reads += 1;
    if (reads === 2) throw new Error('simulated tail I/O error');
    return original.apply(fs, args);
  };
  try { f.expectSend(); } finally { fs.readSync = original; }
});
test('concurrent append prevents using an outdated tail snapshot', f => {
  f.append(message());
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = function(...args) {
    reads += 1;
    const result = original.apply(fs, args);
    if (reads === 2) f.append(event('context_cleared'));
    return result;
  };
  try { f.expectSend(); } finally { fs.readSync = original; }
});
test('concurrent truncate prevents using an outdated tail snapshot', f => {
  f.append(message());
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = function(...args) {
    reads += 1;
    const result = original.apply(fs, args);
    if (reads === 2) f.reset();
    return result;
  };
  try { f.expectSend(); } finally { fs.readSync = original; }
});
console.log('Codex Main history scenarios: passed=' + passed + ', failed=' + failed);
if (failed) process.exitCode = 1;
