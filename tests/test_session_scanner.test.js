#!/usr/bin/env node
/**
 * Unit test for Find Project Sessions (Node.js)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { findSessions } = require('../scripts/find_project_sessions');

function testScanner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test_scanner_js_'));
  try {
    const sessions = findSessions(tempDir, 'Auto');
    assert(Array.isArray(sessions));
    console.log(`Node.js Scanner test passed. Discovered sessions count: ${sessions.length}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testScanner();
