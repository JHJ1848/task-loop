#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');

function parseArgs(argv) {
  const options = { mode: 'queue', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--thread' || arg === '--message') {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else if (arg === '--resume') {
      options.mode = 'resume';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function buildCommand(options, codexBin = process.env.CODEX_BIN || 'codex') {
  if (!options.thread || !options.message) {
    throw new Error('--thread and --message are required');
  }
  return options.mode === 'resume'
    ? { command: codexBin, args: ['exec', 'resume', options.thread, options.message] }
    : { command: codexBin, args: ['queue', '--thread', options.thread, '--message', options.message] };
}

function prepared(command, reason) {
  return {
    status: 'PREPARED_ONLY',
    submitted: false,
    command: [command.command, ...command.args],
    reason
  };
}

function dispatch(options, runCommand = childProcess.spawnSync) {
  let command;
  try {
    command = buildCommand(options);
  } catch (error) {
    return { status: 'PREPARED_ONLY', submitted: false, reason: error.message };
  }
  if (options.dryRun) return prepared(command, 'dry-run; no Codex command was executed');

  const result = runCommand(command.command, command.args, { encoding: 'utf8', windowsHide: true });
  if (result && result.status === 0 && !result.error) {
    return { status: 'SUBMITTED', submitted: true, command: [command.command, ...command.args] };
  }
  if (result && result.error && result.error.code === 'ENOENT') {
    return prepared(command, 'Codex CLI is unavailable; command was not submitted');
  }
  return {
    status: 'PREPARED_ONLY',
    submitted: false,
    command: [command.command, ...command.args],
    reason: `Codex CLI exited ${result && typeof result.status === 'number' ? result.status : 'without a status'}`
  };
}

function main(argv = process.argv.slice(2)) {
  const result = dispatch(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.submitted ? 0 : (result.status === 'PREPARED_ONLY' ? 0 : 1);
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, buildCommand, dispatch, main };
