#!/usr/bin/env node
/**
 * [Conformance Test] Golden Fixture Conformance Runner (Node.js)
 *
 * 读取 contracts/fixtures/ 下的黄金一致性测试固件并断言:
 * 1. vendor/vendor-precedence.json: 5级优先级、别名归一化与 TL_VENDOR_AMBIGUOUS 冲突检测;
 * 2. allowlist/allowlist-cases.json: 物理白名单边界拦截、前缀碰撞、路径穿越与豁免路径;
 * 3. state/state-v5-sample.json: Schema v5 结构验证、OCC revision 乐观锁冲突拦截与 v4->v5 迁移.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const rootDir = path.resolve(__dirname, '..');
const fixturesDir = path.join(rootDir, 'contracts', 'fixtures');

const { resolveVendor, validateStateDocument, writePartition, migrateToV5 } = require('../scripts/task_loop_state');
const { isPathAllowed } = require('../scripts/hooks/enforce_allowlist');

function loadFixture(relPath) {
  const fullPath = path.join(fixturesDir, relPath);
  assert.ok(fs.existsSync(fullPath), `Fixture file must exist: ${fullPath}`);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function createMockProjectRoot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-vendor-node-'));
  const stateDir = path.join(tmpDir, '.agents', 'task-loop');
  fs.mkdirSync(stateDir, { recursive: true });
  const mockSessions = {
    schema_version: 5,
    revision: 1,
    updated_at: new Date().toISOString(),
    vendors: {
      antigravity: {
        vendor: 'antigravity',
        main_thread_id: 'mock-registered-session-id',
        updated_at: new Date().toISOString(),
        modules: {
          session_control: {
            session_id: 'cdd1ca5c-3532-4489-b844-15c6f34055fa',
            memory_doc: 'docs/memory/session_control.md'
          }
        },
        sessions: [
          { session_id: 'mock-registered-session-id', vendor: 'antigravity' },
          { session_id: 'cdd1ca5c-3532-4489-b844-15c6f34055fa', vendor: 'antigravity' }
        ]
      }
    }
  };
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify(mockSessions, null, 2), 'utf8');
  return tmpDir;
}

function testVendorPrecedenceConformance() {
  const fixture = loadFixture('vendor/vendor-precedence.json');
  console.log(`- Running ${fixture.cases.length} vendor precedence conformance cases...`);

  const mockRoot = createMockProjectRoot();
  try {
    for (const tc of fixture.cases) {
      const inp = Object.assign({}, tc.input, { projectRoot: mockRoot });
      if (tc.expected) {
        const res = resolveVendor(inp);
        assert.strictEqual(res.vendor, tc.expected.vendor, `[${tc.name}] vendor mismatch: expected ${tc.expected.vendor}, got ${res.vendor}`);
        assert.strictEqual(res.precedence, tc.expected.precedence, `[${tc.name}] precedence mismatch: expected ${tc.expected.precedence}, got ${res.precedence}`);
        assert.strictEqual(res.matched_by, tc.expected.matched_by, `[${tc.name}] matched_by mismatch: expected ${tc.expected.matched_by}, got ${res.matched_by}`);
      } else if (tc.expected_error) {
        // 必须捕获或返回预期错误码
        assert.throws(() => {
          resolveVendor(inp, { throws: true });
        }, (err) => {
          return err.code === tc.expected_error.code;
        }, `[${tc.name}] expected error code ${tc.expected_error.code}`);

        const resNoThrow = resolveVendor(inp, { throws: false });
        assert.strictEqual(resNoThrow.error, tc.expected_error.code, `[${tc.name}] non-throwing mode must return error code`);
      }
    }
  } finally {
    fs.rmSync(mockRoot, { recursive: true, force: true });
  }

  console.log('  ✔ Vendor Precedence Conformance PASSED!');
}

function testAllowlistConformance() {
  const fixture = loadFixture('allowlist/allowlist-cases.json');
  const wsRoot = rootDir;
  console.log(`- Running ${fixture.cases.length} allowlist boundary conformance cases...`);

  for (const tc of fixture.cases) {
    const isAllowed = isPathAllowed(tc.target_file, tc.allowlist, wsRoot);
    const expectedAllowed = tc.expected_decision === 'allow';
    assert.strictEqual(isAllowed, expectedAllowed, `[${tc.name}] target '${tc.target_file}' expected decision '${tc.expected_decision}', but got '${isAllowed ? 'allow' : 'deny'}'`);
  }

  console.log('  ✔ Allowlist Boundary Conformance PASSED!');
}

function testStateV5Conformance() {
  const fixture = loadFixture('state/state-v5-sample.json');
  console.log(`- Running state Schema v5 & OCC conformance cases...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-state-node-'));
  const testStateFile = path.join(tmpDir, 'sessions.json');

  try {
    const sampleDoc = fixture.sample_document;
    fs.writeFileSync(testStateFile, JSON.stringify(sampleDoc, null, 2), 'utf8');

    for (const tc of fixture.cases) {
      if (tc.name === 'schema_v5_validation_success') {
        const valRes = validateStateDocument(sampleDoc, 'sessions');
        assert.strictEqual(valRes.valid, tc.expected_valid, `[${tc.name}] sample document must pass schema validation`);
      } else if (tc.name === 'occ_revision_match_success') {
        const written = writePartition(testStateFile, 'antigravity', tc.partition_update, {
          expectedRevision: tc.expected_revision
        });
        assert.strictEqual(written.schema_version, 5);
        assert.strictEqual(written.revision, tc.resulting_revision, `[${tc.name}] revision must increment to ${tc.resulting_revision}`);
      } else if (tc.name === 'occ_revision_mismatch_conflict') {
        assert.throws(() => {
          writePartition(testStateFile, 'antigravity', tc.partition_update, {
            expectedRevision: tc.expected_revision
          });
        }, (err) => {
          return err.code === tc.expected_error_code;
        }, `[${tc.name}] must throw ${tc.expected_error_code} when revision mismatches`);
      } else if (tc.name === 'legacy_v4_migration_to_v5') {
        const migrated = migrateToV5(tc.legacy_input, 'sessions', 'antigravity');
        assert.strictEqual(migrated.schema_version, tc.expected_version);
        assert.ok(migrated.revision >= tc.expected_min_revision);
        assert.ok(migrated.vendors && migrated.vendors.antigravity);
      }
    }

    console.log('  ✔ State Schema v5 & OCC Conformance PASSED!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runAll() {
  console.log('====================================================');
  console.log(' Golden Fixture Conformance Runner (Node.js)');
  console.log('====================================================');
  testVendorPrecedenceConformance();
  testAllowlistConformance();
  testStateV5Conformance();
  console.log('ALL Golden Fixture Conformance Node.js Tests PASSED SUCCESSFULLY!\n');
}

runAll();
