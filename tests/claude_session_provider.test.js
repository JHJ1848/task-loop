#!/usr/bin/env node
/**
 * Test suite for claude_session_provider.js (Node.js)
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const provider = require('../scripts/providers/claude_session_provider');

console.log('Running claude_session_provider.test.js...');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provider-test-'));
const registryDir = path.join(tempHome, 'sessions');
fs.mkdirSync(registryDir, { recursive: true });

const projectRoot = path.join(tempHome, 'project');
const otherRoot = path.join(tempHome, 'other-project');

const VISIBLE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NO_HOST_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const DEAD_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const BG_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const UNREGISTERED_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

const VISIBLE_HOST = 'local_aaaa1111-0000-4000-8000-000000000001';
const NO_HOST_SESSION_HOST = 'local_bbbb2222-0000-4000-8000-000000000002';

// A live pid other than this test process: a keeper child held open on purpose.
const keeper = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], {
  stdio: 'ignore',
  windowsHide: true
});
const KEEPER_PID = keeper.pid;

// A pid that is guaranteed gone: a child that already exited.
const exited = spawnSync(process.execPath, ['-e', '']);
const DEAD_PID = exited.pid;

function writeEntry(pid, entry) {
  fs.writeFileSync(path.join(registryDir, `${pid}.json`), JSON.stringify({ pid, ...entry }, null, 2));
}

function cleanup() {
  try { keeper.kill(); } catch (error) { /* already gone */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (error) { /* best effort */ }
}

try {
  assert.ok(Number.isInteger(KEEPER_PID) && KEEPER_PID > 0, 'keeper child must expose a pid');
  assert.ok(Number.isInteger(DEAD_PID) && DEAD_PID > 0, 'exited child must expose a pid');
  assert.strictEqual(provider.isPidAlive(process.pid), true, 'current process must be alive');
  assert.strictEqual(provider.isPidAlive(DEAD_PID), false, 'exited pid must be dead');
  assert.strictEqual(provider.isPidAlive(null), false, 'missing pid must be dead');

  writeEntry(process.pid, {
    sessionId: VISIBLE_ID,
    cwd: projectRoot,
    kind: 'interactive',
    entrypoint: 'claude-desktop-3p',
    hostSessionId: VISIBLE_HOST,
    name: 'visible topic session',
    status: 'busy',
    updatedAt: 1792133480972
  });
  writeEntry(KEEPER_PID, {
    sessionId: NO_HOST_ID,
    cwd: projectRoot,
    kind: 'interactive',
    entrypoint: 'claude-desktop-3p',
    name: 'cli session without host id',
    status: 'idle',
    updatedAt: 1792133000000
  });
  writeEntry(DEAD_PID, {
    sessionId: DEAD_ID,
    cwd: projectRoot,
    kind: 'interactive',
    entrypoint: 'claude-desktop-3p',
    hostSessionId: NO_HOST_SESSION_HOST,
    name: 'stale registry entry',
    status: 'idle',
    updatedAt: 1792132000000
  });
  writeEntry(999999, {
    sessionId: BG_ID,
    cwd: otherRoot,
    kind: 'bg',
    entrypoint: 'claude-desktop-3p',
    name: 'background job',
    status: 'idle',
    updatedAt: 1792131000000
  });
  fs.writeFileSync(path.join(registryDir, 'not-a-registry-entry.key'), 'ignored');

  const loaded = provider.loadRegistry(tempHome);
  assert.strictEqual(loaded.length, 4, 'registry loader must read every json entry');

  // Classification: the four gates, in reachability order.
  const visible = provider.classifyEntry(loaded.find(entry => entry.session_id === VISIBLE_ID));
  assert.deepStrictEqual(visible, { sidebar_visible: true, reason: 'interactive_app_session' });
  const bg = provider.classifyEntry(loaded.find(entry => entry.session_id === BG_ID));
  assert.deepStrictEqual(bg, { sidebar_visible: false, reason: 'kind_bg' });
  const noHost = provider.classifyEntry(loaded.find(entry => entry.session_id === NO_HOST_ID));
  assert.deepStrictEqual(noHost, { sidebar_visible: false, reason: 'no_host_session_id' });
  const dead = provider.classifyEntry(loaded.find(entry => entry.session_id === DEAD_ID));
  assert.deepStrictEqual(dead, { sidebar_visible: false, reason: 'pid_dead' });
  assert.deepStrictEqual(provider.classifyEntry(null), { sidebar_visible: false, reason: 'not_registered' });

  // list: default admits only sidebar-visible sessions, --all keeps the rejects with a reason.
  const visibleOnly = provider.listSessions({ claudeHome: tempHome });
  assert.strictEqual(visibleOnly.sidebar_visible_only, true);
  assert.strictEqual(visibleOnly.count, 1);
  assert.strictEqual(visibleOnly.sessions[0].session_id, VISIBLE_ID);
  assert.strictEqual(visibleOnly.sessions[0].verdict_scope, 'live_registry_presence');

  const everything = provider.listSessions({ claudeHome: tempHome, all: true });
  assert.strictEqual(everything.count, 4);
  const byId = new Map(everything.sessions.map(entry => [entry.session_id, entry.reason]));
  assert.strictEqual(byId.get(BG_ID), 'kind_bg');
  assert.strictEqual(byId.get(NO_HOST_ID), 'no_host_session_id');
  assert.strictEqual(byId.get(DEAD_ID), 'pid_dead');
  assert.strictEqual(byId.get(VISIBLE_ID), 'interactive_app_session');
  assert.strictEqual(everything.sessions[0].session_id, VISIBLE_ID, 'list must sort by updated_at desc');

  const scoped = provider.listSessions({ claudeHome: tempHome, all: true, cwd: projectRoot });
  assert.strictEqual(scoped.count, 3, 'cwd filter must exclude the bg entry living elsewhere');

  // verify: accepts either namespace.
  const byUuid = provider.verifySession(VISIBLE_ID, { claudeHome: tempHome });
  assert.strictEqual(byUuid.sidebar_visible, true);
  assert.strictEqual(byUuid.reason, 'interactive_app_session');
  assert.strictEqual(byUuid.host_session_id, VISIBLE_HOST);
  assert.strictEqual(byUuid.verdict_scope, 'live_registry_presence');
  assert.strictEqual(provider.VERDICT_SCOPE, 'live_registry_presence');

  const byHostId = provider.verifySession(VISIBLE_HOST, { claudeHome: tempHome });
  assert.strictEqual(byHostId.query_kind, 'host_session_id');
  assert.strictEqual(byHostId.sidebar_visible, true);
  assert.strictEqual(byHostId.session_id, VISIBLE_ID);

  assert.strictEqual(provider.verifySession(BG_ID, { claudeHome: tempHome }).reason, 'kind_bg');
  assert.strictEqual(provider.verifySession(NO_HOST_ID, { claudeHome: tempHome }).reason, 'no_host_session_id');
  assert.strictEqual(provider.verifySession(DEAD_ID, { claudeHome: tempHome }).reason, 'pid_dead');

  const unknown = provider.verifySession(UNREGISTERED_ID, { claudeHome: tempHome });
  assert.strictEqual(unknown.found, false);
  assert.strictEqual(unknown.sidebar_visible, false);
  assert.strictEqual(unknown.reason, 'not_registered');
  assert.strictEqual(unknown.verdict_scope, 'live_registry_presence');
  assert.strictEqual(provider.verifySession('local_missing', { claudeHome: tempHome }).reason, 'not_registered');

  // resolve: bridges the App namespace back to the CLI/hook namespace.
  const resolved = provider.resolveHostSession(VISIBLE_HOST, { claudeHome: tempHome });
  assert.strictEqual(resolved.resolved, true);
  assert.strictEqual(resolved.session_id, VISIBLE_ID);
  assert.strictEqual(resolved.sidebar_visible, true);
  assert.strictEqual(resolved.verdict_scope, 'live_registry_presence');

  const resolvedDead = provider.resolveHostSession(NO_HOST_SESSION_HOST, { claudeHome: tempHome });
  assert.strictEqual(resolvedDead.session_id, DEAD_ID, 'resolve must still return the bare UUID for a stale entry');
  assert.strictEqual(resolvedDead.sidebar_visible, false);
  assert.strictEqual(resolvedDead.reason, 'pid_dead');

  const unresolved = provider.resolveHostSession('local_missing', { claudeHome: tempHome });
  assert.strictEqual(unresolved.resolved, false);
  assert.strictEqual(unresolved.session_id, null);

  // CLI exit codes.
  const scriptPath = path.join(__dirname, '..', 'scripts', 'providers', 'claude_session_provider.js');
  const cliVerify = spawnSync(process.execPath, [scriptPath, 'verify', '--session', VISIBLE_ID, '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(cliVerify.status, 0, `verify must exit 0 for a visible session: ${cliVerify.stderr}`);
  assert.strictEqual(JSON.parse(cliVerify.stdout).sidebar_visible, true);

  const cliVerifyHidden = spawnSync(process.execPath, [scriptPath, 'verify', '--session', DEAD_ID, '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(cliVerifyHidden.status, 1, 'verify must exit non-zero for a hidden session');
  assert.strictEqual(JSON.parse(cliVerifyHidden.stdout).reason, 'pid_dead');

  const cliResolve = spawnSync(process.execPath, [scriptPath, 'resolve', '--host', VISIBLE_HOST, '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(cliResolve.status, 0, `resolve must exit 0 on a hit: ${cliResolve.stderr}`);
  assert.strictEqual(JSON.parse(cliResolve.stdout).session_id, VISIBLE_ID);

  const cliResolveMiss = spawnSync(process.execPath, [scriptPath, 'resolve', '--host', 'local_missing', '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(cliResolveMiss.status, 1, 'resolve must exit non-zero on a miss');

  const cliList = spawnSync(process.execPath, [scriptPath, 'list', '--all', '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(cliList.status, 0, `list must exit 0: ${cliList.stderr}`);
  assert.strictEqual(JSON.parse(cliList.stdout).count, 4);

  const cliListDefault = spawnSync(process.execPath, [scriptPath, 'list', '--claude-home', tempHome], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(cliListDefault.stdout).count, 1, 'list without --all must hide non-visible sessions');

  const cliUnknown = spawnSync(process.execPath, [scriptPath, 'frobnicate'], { encoding: 'utf8' });
  assert.strictEqual(cliUnknown.status, 2, 'an unknown subcommand must exit 2');

  console.log('claude_session_provider Node.js tests PASSED!');
} finally {
  cleanup();
}
