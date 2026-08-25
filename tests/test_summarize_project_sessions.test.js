#!/usr/bin/env node
/**
 * Unit test for Summarize Project Sessions (Node.js)
 */

const assert = require('assert');
const { inferSuggestedModule, formatMarkdownTable } = require('../scripts/summarize_project_sessions');

function testSummarize() {
  const session1 = {
    session_id: 'session-123',
    vendor: 'antigravity',
    title: 'test session control',
    recent_touched_files: ['scripts/providers/get_agy_project_sessions.js']
  };
  const mod1 = inferSuggestedModule(session1);
  assert.strictEqual(mod1, 'session_control');

  const session2 = {
    session_id: 'session-456',
    vendor: 'antigravity',
    title: 'dispatch packet',
    recent_touched_files: ['scripts/new_task_loop_dispatch_packet.js']
  };
  const mod2 = inferSuggestedModule(session2);
  assert.strictEqual(mod2, 'dispatch_engine');

  const table = formatMarkdownTable([session1, session2]);
  assert(table.includes('ANTIGRAVITY'));
  assert(table.includes('`session_control`'));
  assert(table.includes('`dispatch_engine`'));

  console.log('Node.js Summarize project sessions test PASSED!');
}

testSummarize();
