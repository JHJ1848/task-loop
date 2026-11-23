#!/usr/bin/env node
'use strict';

const { run } = require('./runtime/cli');

try {
  const result = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`project-memory: ${error.message}\n`);
  process.exitCode = 1;
}
