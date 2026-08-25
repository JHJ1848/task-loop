#!/usr/bin/env node
/**
 * Get Task Loop Statistics (Node.js)
 * Calculates summary statistics of the task-loop queue and registered topics.
 */

const fs = require('fs');
const path = require('path');

function getStatistics(projectRoot = '.') {
  const root = path.resolve(projectRoot);
  let runtime = path.join(root, '.agents', 'task-loop');
  if (!fs.existsSync(runtime)) {
    runtime = path.join(root, '.codex', 'task-loop');
  }

  const todoFile = path.join(runtime, 'todo.json');
  const sessionsFile = path.join(runtime, 'sessions.json');

  const stats = {
    total_items: 0,
    ready: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    registered_modules: 0
  };

  if (fs.existsSync(todoFile)) {
    try {
      const todo = JSON.parse(fs.readFileSync(todoFile, 'utf8'));
      const items = todo.items || [];
      stats.total_items = items.length;
      stats.ready = items.filter(i => i.state === 'ready').length;
      stats.in_progress = items.filter(i => ['dispatched', 'in_progress', 'verifying'].includes(i.state)).length;
      stats.done = items.filter(i => i.state === 'done').length;
      stats.blocked = items.filter(i => i.state === 'blocked').length;
    } catch (e) {}
  }

  if (fs.existsSync(sessionsFile)) {
    try {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const modules = sessions.modules || {};
      stats.registered_modules = Object.keys(modules).length;
    } catch (e) {}
  }

  return stats;
}

function main() {
  const args = process.argv.slice(2);
  let root = '.';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
    else if (!args[i].startsWith('-')) root = args[i];
  }

  const stats = getStatistics(root);
  console.log(JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { getStatistics };
