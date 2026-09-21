#!/usr/bin/env node
/**
 * Unit test for Claude Code Session Scanner (Node.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { scanClaudeSessions, mungeProjectDir } = require('../scripts/providers/get_claude_project_sessions');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function writeFixture(homeDir, projectDir) {
  const munged = mungeProjectDir(projectDir);
  const sessionDir = path.join(homeDir, 'projects', munged);
  fs.mkdirSync(sessionDir, { recursive: true });

  const cwdField = projectDir.replace(/\\/g, '\\\\');
  const lines = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-24T01:00:00.000Z', sessionId: SESSION_ID, content: 'claude scanner js fixture prompt' }),
    JSON.stringify({ type: 'user', cwd: cwdField, sessionId: SESSION_ID, timestamp: '2026-08-24T01:00:01.000Z', message: { role: 'user', content: 'claude scanner js fixture prompt' } }),
    JSON.stringify({ type: 'assistant', cwd: cwdField, timestamp: '2026-08-24T01:00:02.000Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'demo.js') } }] } })
  ];
  fs.writeFileSync(path.join(sessionDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

function testClaudeScanner() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_scan_proj_js_'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_scan_home_js_'));

  try {
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# rules', 'utf8');
    writeFixture(homeDir, projectDir);

    const sessions = scanClaudeSessions(projectDir, homeDir, true);
    assert.strictEqual(sessions.length, 1, `expected 1 session, got ${sessions.length}`);

    const s = sessions[0];
    assert.strictEqual(s.vendor, 'claude');
    assert.strictEqual(s.session_id, SESSION_ID);
    assert(s.log_path.endsWith(`${SESSION_ID}.jsonl`));
    assert(s.created_at.startsWith('2026-08-24T01:00:00'));
    assert(s.title.includes('claude scanner js fixture prompt'));
    assert(s.recent_prompts.length > 0);
    assert(s.recent_touched_files.includes('src/demo.js'));
    assert(s.rule_files.some(p => p.endsWith('CLAUDE.md')));

    console.log('Node.js Claude scanner test PASSED!');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

testClaudeScanner();
