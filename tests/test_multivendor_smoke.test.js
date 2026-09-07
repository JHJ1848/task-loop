#!/usr/bin/env node
/**
 * Multi-Vendor End-to-End Smoke Test Suite (Node.js)
 * Verifies that universal scanning and introspection work simultaneously across
 * Google Antigravity, ZCode, OpenAI Codex, and Anthropic Claude Code.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanAgySessions } = require('../scripts/providers/get_agy_project_sessions');
const { scanZcodeSessions } = require('../scripts/providers/get_zcode_project_sessions');
const { scanCodexSessions } = require('../scripts/providers/get_codex_project_sessions');
const { scanClaudeSessions, mungeProjectDir } = require('../scripts/providers/get_claude_project_sessions');
const { findSessions } = require('../scripts/find_project_sessions');

function withMockEnvironment(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_smoke_env_js_'));
  try {
    const projectRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project Rules\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# Claude Guidelines\n', 'utf8');

    const normProject = projectRoot.replace(/\\/g, '/');

    // 1. Mock AGY Brain
    const mockBrain = path.join(tempDir, 'brain');
    const agyId = '11111111-1111-1111-1111-111111111111';
    const agyLogDir = path.join(mockBrain, agyId, '.system_generated', 'logs');
    fs.mkdirSync(agyLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: `AGY Task in ${normProject}`, created_at: '2026-09-07T01:00:00Z' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { TargetFile: path.join(projectRoot, 'src/main.js') } }] })
      ].join('\n'),
      'utf8'
    );

    // 2. Mock ZCode Rollout
    const mockRollout = path.join(tempDir, 'zcode_rollout');
    fs.mkdirSync(mockRollout, { recursive: true });
    const zcodeSuffix = '22222222-2222-2222-2222-222222222222';
    fs.writeFileSync(
      path.join(mockRollout, `model-io-sess_${zcodeSuffix}.jsonl`),
      [
        `{"role":"user","text":"ZCode Task in ${normProject}"}`,
        `{"role":"assistant","text":"Working on ${normProject}/src/app.js"}`
      ].join('\n'),
      'utf8'
    );

    // 3. Mock Codex Home
    const mockCodexHome = path.join(tempDir, 'codex_home');
    const codexSessions = path.join(mockCodexHome, 'sessions');
    fs.mkdirSync(codexSessions, { recursive: true });
    const codexId = '33333333-3333-3333-3333-333333333333';
    fs.writeFileSync(
      path.join(codexSessions, 'rollout-sess-003.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'rollout-003',
          session_id: codexId,
          cwd: projectRoot,
          timestamp: '2026-09-07T03:00:00Z',
          thread_source: 'user'
        }
      }) + '\n',
      'utf8'
    );

    // 4. Mock Claude Home
    const mockClaudeHome = path.join(tempDir, 'claude_home');
    const claudeMunged = mungeProjectDir(projectRoot);
    const claudeTargetDir = path.join(mockClaudeHome, 'projects', claudeMunged);
    fs.mkdirSync(claudeTargetDir, { recursive: true });
    const claudeId = '44444444-4444-4444-4444-444444444444';
    fs.writeFileSync(
      path.join(claudeTargetDir, `${claudeId}.jsonl`),
      [
        JSON.stringify({ timestamp: '2026-09-07T04:00:00Z', cwd: normProject }),
        JSON.stringify({ type: 'user', content: `Claude Task in ${normProject}` })
      ].join('\n'),
      'utf8'
    );

    return fn({
      tempDir,
      projectRoot,
      mockBrain,
      mockRollout,
      mockCodexHome,
      mockClaudeHome,
      agyId,
      zcodeId: `sess_${zcodeSuffix}`,
      codexId,
      claudeId
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runSmokeTests() {
  console.log('Running test_multivendor_smoke.test.js (Multi-Vendor Smoke E2E)...');

  withMockEnvironment(env => {
    // 1. Direct provider smoke tests
    const agySessions = scanAgySessions(env.projectRoot, env.mockBrain, true);
    assert.strictEqual(agySessions.length, 1, 'AGY provider should find 1 session');
    assert.strictEqual(agySessions[0].vendor, 'antigravity');
    assert.strictEqual(agySessions[0].session_id, env.agyId);

    const zcodeSessions = scanZcodeSessions(env.projectRoot, { rolloutDir: env.mockRollout }, true);
    assert.strictEqual(zcodeSessions.length, 1, 'ZCode provider should find 1 session');
    assert.strictEqual(zcodeSessions[0].vendor, 'zcode');
    assert.strictEqual(zcodeSessions[0].session_id, env.zcodeId);

    const codexSessions = scanCodexSessions(env.projectRoot, env.mockCodexHome, false);
    assert.strictEqual(codexSessions.length, 1, 'Codex provider should find 1 session');
    assert.strictEqual(codexSessions[0].vendor, 'codex');
    assert.strictEqual(codexSessions[0].session_id, env.codexId);

    const claudeSessions = scanClaudeSessions(env.projectRoot, env.mockClaudeHome, true);
    assert.strictEqual(claudeSessions.length, 1, 'Claude provider should find 1 session');
    assert.strictEqual(claudeSessions[0].vendor, 'claude');
    assert.strictEqual(claudeSessions[0].session_id, env.claudeId);

    // 2. Set environment variables to test findSessions aggregation with mock dirs
    const origBrain = process.env.ANTIGRAVITY_BRAIN_PATH;
    const origRollout = process.env.ZCODE_ROLLOUT_DIR;
    const origCodex = process.env.CODEX_HOME;
    const origClaude = process.env.CLAUDE_HOME;

    process.env.ZCODE_ROLLOUT_DIR = env.mockRollout;
    process.env.CODEX_HOME = env.mockCodexHome;

    try {
      // Find All via universal findSessions
      const allSessions = findSessions(env.projectRoot, 'all', true);
      const vendorsFound = new Set(allSessions.map(s => s.vendor));
      assert.ok(vendorsFound.has('zcode'), 'findSessions should discover zcode');
      assert.ok(vendorsFound.has('codex'), 'findSessions should discover codex');

      // Verify Schema completeness
      for (const s of allSessions) {
        assert.ok(s.vendor, 'Session must have vendor');
        assert.ok(s.session_id, 'Session must have session_id');
        assert.ok(s.title, 'Session must have title');
        assert.ok(s.project_root, 'Session must have project_root');
      }
    } finally {
      if (origRollout) process.env.ZCODE_ROLLOUT_DIR = origRollout;
      else delete process.env.ZCODE_ROLLOUT_DIR;
      if (origCodex) process.env.CODEX_HOME = origCodex;
      else delete process.env.CODEX_HOME;
    }
  });

  console.log('test_multivendor_smoke.test.js PASSED (All 4 Vendors Verified)!');
}

runSmokeTests();
