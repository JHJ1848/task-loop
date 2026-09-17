#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');

function parseArgs(argv) {
  const options = { mode: 'queue', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--thread' || arg === '--message' || arg === '--model' || arg === '--reasoning-effort') {
      const key = arg === '--reasoning-effort' ? 'reasoning_effort' : arg.slice(2);
      options[key] = argv[index + 1];
      index += 1;
    } else if (arg === '--resume') {
      options.mode = 'resume';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function normalizeThreadId(options = {}) {
  if (options.clientThreadId || options.client_thread_id || options.id_kind === 'clientThreadId') return null;
  const value = options.threadId || options.thread || options.sessionId;
  return value == null ? null : String(value).trim() || null;
}

function buildCommand(options, codexBin = process.env.CODEX_BIN || 'codex') {
  const thread = normalizeThreadId(options);
  if (!thread || !options.message) {
    throw new Error('formal Codex threadId and message are required; clientThreadId cannot be routed');
  }
  const args = options.mode === 'resume'
    ? ['exec', 'resume', thread, '-']
    : ['queue', '--thread', thread, '--message', options.message];
  if (options.model) args.push('--model', options.model);
  if (options.reasoning_effort) args.push('--config', `model_reasoning_effort="${options.reasoning_effort}"`);
  return { command: codexBin, args, input: options.mode === 'resume' ? options.message : undefined };
}

function prepared(command, reason) {
  return {
    status: 'PREPARED_ONLY',
    submitted: false,
    command: [command.command, ...command.args],
    reason
  };
}

function runCodexCommand(argv, options = {}) {
  return childProcess.spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    windowsHide: true,
    input: options.input
  });
}

function dispatch(options, runCommand = runCodexCommand) {
  let command;
  try {
    command = buildCommand(options);
  } catch (error) {
    return { status: 'PREPARED_ONLY', submitted: false, reason: error.message };
  }
  if (options.dryRun) return prepared(command, 'dry-run; no Codex command was executed');

  const argv = [command.command, ...command.args];
  let result;
  try {
    result = runCommand(argv, { input: command.input });
  } catch (error) {
    return prepared(command, `Codex CLI launch failed: ${error.message}`);
  }
  if (result && result.status === 0 && !result.error) {
    return { status: 'SUBMITTED', submitted: true, command: argv };
  }
  if (result && result.error && result.error.code === 'ENOENT') {
    return prepared(command, 'Codex CLI is unavailable; command was not submitted');
  }
  return {
    status: 'PREPARED_ONLY',
    submitted: false,
    command: argv,
    reason: `Codex CLI exited ${result && typeof result.status === 'number' ? result.status : 'without a status'}`
  };
}

function main(argv = process.argv.slice(2)) {
  const result = dispatch(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.submitted ? 0 : (result.status === 'PREPARED_ONLY' ? 0 : 1);
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, normalizeThreadId, buildCommand, dispatch, main, runCodexCommand };
