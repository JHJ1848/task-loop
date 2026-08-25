#!/usr/bin/env node
/**
 * Invoke Task Loop Tick (Node.js)
 * Executes a single tick of topic reconcile and queue preflight.
 */

const fs = require('fs');
const path = require('path');
const { reconcileTopics } = require('./reconcile_task_loop_topics');
const { preflight } = require('./test_task_loop_preflight');

function invokeTick(projectRoot = '.') {
  const root = path.resolve(projectRoot);
  let runtime = path.join(root, '.agents', 'task-loop');
  if (!fs.existsSync(runtime)) {
    runtime = path.join(root, '.codex', 'task-loop');
  }

  const manifestFile = path.join(runtime, 'topics.json');
  const registryFile = path.join(runtime, 'sessions.json');

  let reconcileResult = null;
  if (fs.existsSync(manifestFile) && fs.existsSync(registryFile)) {
    reconcileResult = reconcileTopics(root, manifestFile, registryFile);
  }

  const preflightResult = preflight({ projectRoot: root });

  return {
    tick_at: new Date().toISOString(),
    reconcile: reconcileResult,
    preflight: preflightResult
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = '.';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else if (!args[i].startsWith('-')) root = args[i];
  }

  const result = invokeTick(root);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { invokeTick };
