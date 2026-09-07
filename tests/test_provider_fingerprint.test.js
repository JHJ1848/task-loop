#!/usr/bin/env node
/**
 * Test suite for provider schema fingerprint probes and graceful degradation (Node.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanAgySessions } = require('../scripts/providers/get_agy_project_sessions');
const { scanCodexSessions } = require('../scripts/providers/get_codex_project_sessions');
const { scanClaudeSessions } = require('../scripts/providers/get_claude_project_sessions');
const { findSessions } = require('../scripts/find_project_sessions');

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_fingerprint_js_'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('Running test_provider_fingerprint.test.js...');

  // 1. AGY Provider Fingerprint & Corrupted Line Test
  withTempDir(tempDir => {
    const mockBrain = path.join(tempDir, 'brain');
    const projectRoot = path.join(tempDir, 'project');
    const convId = '11111111-2222-3333-4444-555555555555';
    const logDir = path.join(mockBrain, convId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    // Write transcript with mixed valid and corrupted lines
    const logFile = path.join(logDir, 'transcript.jsonl');
    const lines = [
      '{"type": "USER_INPUT", "content": "Valid prompt in ' + projectRoot.replace(/\\/g, '/') + '", "created_at": "2026-09-07T00:00:00Z"}',
      '{corrupted line missing brackets',
      '"not-a-json-object"',
      '{"type": "PLANNER_RESPONSE", "content": "Done"}'
    ];
    fs.writeFileSync(logFile, lines.join('\n'), 'utf8');

    // Intercept stderr to verify warning
    let stderrOutput = '';
    const origStderrWrite = process.stderr.write;
    process.stderr.write = function (chunk) {
      stderrOutput += chunk;
      return true;
    };

    let sessions = [];
    try {
      sessions = scanAgySessions(projectRoot, mockBrain, true);
    } finally {
      process.stderr.write = origStderrWrite;
    }

    assert.strictEqual(sessions.length, 1, 'Valid AGY session should still be extracted despite corrupt lines');
    assert.strictEqual(sessions[0].session_id, convId);
    assert.ok(stderrOutput.includes('[agy-provider] schema mismatch'), 'Stderr should contain structured schema mismatch warning');
  });

  // 2. Codex Provider Fingerprint & Corrupted Line Test
  withTempDir(tempDir => {
    const mockCodexHome = path.join(tempDir, 'codex_home');
    const projectRoot = path.join(tempDir, 'project');
    const sessionsDir = path.join(mockCodexHome, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const sessionFile = path.join(sessionsDir, 'rollout-sess-001.jsonl');
    const lines = [
      '{bad json line',
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'rollout-001',
          session_id: 'codex-sess-001',
          cwd: projectRoot,
          timestamp: '2026-09-07T00:00:00Z',
          thread_source: 'user'
        }
      })
    ];
    fs.writeFileSync(sessionFile, lines.join('\n'), 'utf8');

    let stderrOutput = '';
    const origStderrWrite = process.stderr.write;
    process.stderr.write = function (chunk) {
      stderrOutput += chunk;
      return true;
    };

    let sessions = [];
    try {
      sessions = scanCodexSessions(projectRoot, mockCodexHome, false);
    } finally {
      process.stderr.write = origStderrWrite;
    }

    assert.strictEqual(sessions.length, 1, 'Valid Codex session should be extracted');
    assert.strictEqual(sessions[0].session_id, 'codex-sess-001');
    assert.ok(stderrOutput.includes('[codex-provider] schema mismatch'), 'Stderr should contain codex schema mismatch warning');
  });

  // 3. Claude Provider Fingerprint Test
  withTempDir(tempDir => {
    const mockClaudeHome = path.join(tempDir, 'claude_home');
    const projectRoot = path.join(tempDir, 'project');
    const projectsDir = path.join(mockClaudeHome, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const { mungeProjectDir } = require('../scripts/providers/get_claude_project_sessions');
    const munged = mungeProjectDir(projectRoot);
    const targetDir = path.join(projectsDir, munged);
    fs.mkdirSync(targetDir, { recursive: true });

    const sessFile = path.join(targetDir, 'claude-sess-001.jsonl');
    const lines = [
      '{"timestamp": "2026-09-07T00:00:00Z", "cwd": "' + projectRoot.replace(/\\/g, '/') + '"}',
      '{"type": "user", "content": "Claude initial prompt"}',
      '{corrupted line in claude'
    ];
    fs.writeFileSync(sessFile, lines.join('\n'), 'utf8');

    const sessions = scanClaudeSessions(projectRoot, mockClaudeHome, true);
    assert.strictEqual(sessions.length, 1, 'Valid Claude session should be parsed');
    assert.strictEqual(sessions[0].session_id, 'claude-sess-001');
  });

  // 4. Universal find_project_sessions Safe Isolation Test
  withTempDir(tempDir => {
    const projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    // Calling findSessions on an empty directory should return [] without throwing
    const sessions = findSessions(projectRoot, 'all', true);
    assert.ok(Array.isArray(sessions), 'findSessions should return an array');
  });

  console.log('test_provider_fingerprint.test.js PASSED!');
}

runTests();
