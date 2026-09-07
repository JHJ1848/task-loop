#!/usr/bin/env node
/**
 * Unified Test Suite Runner (Node.js)
 * Discovers and executes all tests/*.test.js suites with consistent output,
 * error aggregation, and strict exit code propagation.
 *
 * Usage:
 *   node scripts/run_all_tests.js             # Runs all Node.js tests (*.test.js)
 *   node scripts/run_all_tests.js --all       # Runs both Node.js and Python tests
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

function findTestFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => pattern.test(file))
    .sort()
    .map(file => path.join(dir, file));
}

function runSingleTest(filePath, isPython = false) {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const cmd = isPython ? (process.platform === 'win32' ? 'python' : 'python3') : process.execPath;
  const env = Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    NODE_ENV: 'test'
  });

  const startTime = Date.now();
  const res = spawnSync(cmd, [filePath], {
    cwd: rootDir,
    env,
    stdio: 'inherit'
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  if (res.status === 0) {
    return { relPath, success: true, duration };
  } else {
    return { relPath, success: false, duration, code: res.status ?? 1 };
  }
}

function main() {
  const args = process.argv.slice(2);
  const runPythonToo = args.includes('--all') || args.includes('--both');

  console.log('====================================================');
  console.log(' task-loop Test Runner (Node.js Primary)');
  console.log('====================================================');

  const nodeFiles = findTestFiles(testsDir, /\.test\.js$/);
  const pyFiles = runPythonToo ? findTestFiles(testsDir, /^test_.*\.py$/) : [];

  const total = nodeFiles.length + pyFiles.length;
  console.log(`Found ${nodeFiles.length} Node.js test suites` + (runPythonToo ? ` and ${pyFiles.length} Python test suites.` : '.'));
  console.log('----------------------------------------------------');

  const results = [];
  let index = 0;

  for (const f of nodeFiles) {
    index++;
    const rel = path.relative(rootDir, f).replace(/\\/g, '/');
    console.log(`\n[${index}/${total}] RUNNING: ${rel}`);
    const r = runSingleTest(f, false);
    results.push(r);
  }

  for (const f of pyFiles) {
    index++;
    const rel = path.relative(rootDir, f).replace(/\\/g, '/');
    console.log(`\n[${index}/${total}] RUNNING: ${rel} (Python)`);
    const r = runSingleTest(f, true);
    results.push(r);
  }

  console.log('\n====================================================');
  console.log(' TEST EXECUTION SUMMARY');
  console.log('====================================================');

  const failed = results.filter(r => !r.success);
  for (const r of results) {
    const status = r.success ? 'PASS' : `FAIL (code ${r.code})`;
    console.log(`  ${r.relPath.padEnd(45)} [${status}] (${r.duration}s)`);
  }

  console.log('----------------------------------------------------');
  const passedCount = results.length - failed.length;
  console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.error(`\nFAILED SUITES (${failed.length}):`);
    for (const f of failed) {
      console.error(`  - ${f.relPath}`);
    }
    process.exit(1);
  } else {
    console.log('\nALL TEST SUITES PASSED SUCCESSFULLY!');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { findTestFiles, runSingleTest };
