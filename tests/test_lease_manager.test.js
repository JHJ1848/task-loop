#!/usr/bin/env node
/**
 * [Test] LeaseManager 独立模块与并发测试 + Vendor Resolution Policy (Node.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LeaseManager, validateLease } = require('../scripts/task_loop_lease');
const { resolveVendor, detectVendor } = require('../scripts/task_loop_state');

function createTempDir() {
  const tmpBase = os.tmpdir();
  const dir = path.join(tmpBase, `task-loop-test-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

async function testLeaseBasicLifecycle() {
  const tmpDir = createTempDir();
  const leaseFile = path.join(tmpDir, 'lease.json');
  const manager = new LeaseManager({ leasePath: leaseFile, ttlMs: 2000 });

  try {
    // 1. 初始状态: 无租约
    const initialInspect = manager.inspect('sessions');
    assert.strictEqual(initialInspect.active, false);
    assert.strictEqual(initialInspect.lease, null);

    // 2. 正常获取租约
    const ownerA = { vendor: 'antigravity', session_id: 'sess-owner-a' };
    const acqA = manager.acquire('sessions', ownerA);
    assert.strictEqual(acqA.success, true);
    assert.strictEqual(acqA.acquired, true);
    assert.strictEqual(acqA.reentered, false);
    assert.ok(acqA.lease_id);
    assert.strictEqual(acqA.lease.resource, 'sessions');
    assert.strictEqual(acqA.lease.owner.vendor, 'antigravity');
    assert.strictEqual(acqA.lease.owner.session_id, 'sess-owner-a');

    // 3. inspect 检查活跃状态
    const inspectA = manager.inspect('sessions');
    assert.strictEqual(inspectA.active, true);
    assert.strictEqual(inspectA.is_expired, false);
    assert.strictEqual(inspectA.lease.lease_id, acqA.lease_id);

    // 4. 同一 owner 可重入并续期
    const reenterA = manager.acquire('sessions', ownerA);
    assert.strictEqual(reenterA.success, true);
    assert.strictEqual(reenterA.reentered, true);
    assert.strictEqual(reenterA.lease_id, acqA.lease_id);

    // 5. 其他 owner 抢占失败
    const ownerB = { vendor: 'zcode', session_id: 'sess-owner-b' };
    const acqB = manager.acquire('sessions', ownerB);
    assert.strictEqual(acqB.success, false);
    assert.strictEqual(acqB.acquired, false);
    assert.strictEqual(acqB.reason, 'LEASE_HELD_BY_OTHER');
    assert.strictEqual(acqB.active_lease.lease_id, acqA.lease_id);

    // 6. 心跳续期 (Renew)
    const renewRes = manager.renew(acqA.lease_id, ownerA, { ttlMs: 5000 });
    assert.strictEqual(renewRes.success, true);
    assert.strictEqual(renewRes.renewed, true);

    // 7. 非法的 owner 无法续期
    const invalidRenew = manager.renew(acqA.lease_id, ownerB);
    assert.strictEqual(invalidRenew.success, false);
    assert.strictEqual(invalidRenew.renewed, false);
    assert.strictEqual(invalidRenew.reason, 'OWNER_MISMATCH');

    // 8. 强制过期 (Expire)
    const expRes = manager.expire('sessions');
    assert.strictEqual(expRes.success, true);
    assert.strictEqual(expRes.expired, true);

    const inspectExpired = manager.inspect('sessions');
    assert.strictEqual(inspectExpired.active, false);
    assert.strictEqual(inspectExpired.is_expired, true);

    // 9. 过期后其他 owner 可以抢占
    const acqBAfterExp = manager.acquire('sessions', ownerB);
    assert.strictEqual(acqBAfterExp.success, true);
    assert.strictEqual(acqBAfterExp.acquired, true);
    assert.strictEqual(acqBAfterExp.lease.owner.vendor, 'zcode');

    // 10. 释放租约 (Release)
    const relB = manager.release(acqBAfterExp.lease_id, ownerB);
    assert.strictEqual(relB.success, true);
    assert.strictEqual(relB.released, true);

    const inspectAfterRel = manager.inspect('sessions');
    assert.strictEqual(inspectAfterRel.active, false);

    console.log('LeaseBasicLifecycle PASSED!');
  } finally {
    cleanupDir(tmpDir);
  }
}

function testLeaseSchemaValidation() {
  // 合法 lease 校验
  const validLease = {
    schema_version: 5,
    lease_id: 'test-uuid-123',
    resource: 'todo',
    owner: { vendor: 'codex', session_id: 'sess-1' },
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date().toISOString()
  };
  assert.strictEqual(validateLease(validLease), true);

  // 缺少 resource
  assert.throws(() => {
    validateLease({ lease_id: '123', owner: { vendor: 'a', session_id: 'b' } });
  }, (err) => err.code === 'TL_STATE_INVALID_SCHEMA');

  // 缺少 owner
  assert.throws(() => {
    validateLease({ lease_id: '123', resource: 'todo' });
  }, (err) => err.code === 'TL_STATE_INVALID_SCHEMA');

  console.log('LeaseSchemaValidation PASSED!');
}

async function testHighConcurrencyLockContention() {
  const tmpDir = createTempDir();
  const leaseFile = path.join(tmpDir, 'lease.json');
  const manager = new LeaseManager({ leasePath: leaseFile, ttlMs: 30000, lockTimeoutMs: 15000 });

  try {
    const concurrency = 30;
    const writers = [];
    for (let i = 0; i < concurrency; i++) {
      writers.push({
        vendor: i % 2 === 0 ? 'antigravity' : 'zcode',
        session_id: `concurrency-writer-${i}`
      });
    }

    // 30 个并发请求同时抢占同一把锁
    const results = await Promise.all(writers.map(w => {
      return new Promise((resolve) => {
        // 轻量 setImmediate 打散执行顺序，模拟高并发事件循环调度
        setImmediate(() => {
          try {
            const res = manager.acquire('sessions', w);
            resolve({ writer: w, res, error: null });
          } catch (err) {
            resolve({ writer: w, res: null, error: err });
          }
        });
      });
    }));

    // 校验结果
    let acquiredCount = 0;
    let rejectedCount = 0;
    let winner = null;

    for (const item of results) {
      assert.strictEqual(item.error, null, `Writer ${item.writer.session_id} encountered unexpected error`);
      if (item.res.acquired) {
        acquiredCount++;
        winner = item.writer;
      } else {
        rejectedCount++;
        assert.strictEqual(item.res.reason, 'LEASE_HELD_BY_OTHER');
      }
    }

    // 1. 0 duplicate owner: 恰好且仅有 1 个胜出者
    assert.strictEqual(acquiredCount, 1, `Expected exactly 1 acquired lease, got ${acquiredCount}`);
    assert.strictEqual(rejectedCount, concurrency - 1, `Expected ${concurrency - 1} rejections, got ${rejectedCount}`);
    assert.ok(winner !== null);

    // 2. 0 corrupt JSON: 最终落盘文件内容完整有效
    const finalContent = fs.readFileSync(leaseFile, 'utf8');
    let parsedFinal;
    assert.doesNotThrow(() => {
      parsedFinal = JSON.parse(finalContent);
    }, 'Final lease.json must be valid JSON (0 corrupt JSON)');

    assert.strictEqual(validateLease(parsedFinal), true);
    assert.strictEqual(parsedFinal.owner.session_id, winner.session_id, 'Disk owner must match the single winning writer');

    // 3. 0 lost update: 锁正常持有，能够被胜出者顺利释放
    const relRes = manager.release(parsedFinal.lease_id, winner);
    assert.strictEqual(relRes.success, true);
    assert.strictEqual(relRes.released, true);

    console.log(`HighConcurrencyLockContention PASSED (${concurrency} concurrent writers: 0 corrupt, 0 duplicate owner, 0 lost update)!`);
  } finally {
    cleanupDir(tmpDir);
  }
}

function testVendorResolutionPolicyPrecedence() {
  const originalEnv = Object.assign({}, process.env);

  try {
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.ZCODE_SESSION_ID;
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.CLAUDE_CONVERSATION_ID;

    // 1. Explicit vendor (优先级 1)
    const res1 = resolveVendor({ vendor: 'agy', session: { vendor: 'codex' }, env: { ZCODE_SESSION_ID: '123' } });
    assert.strictEqual(res1.vendor, 'antigravity');
    assert.strictEqual(res1.precedence, 1);
    assert.strictEqual(res1.matched_by, 'explicit_vendor');

    // 2. Explicit session payload (优先级 2)
    const res2 = resolveVendor({ session: { vendor: 'zcode' }, env: { ANTIGRAVITY_CONVERSATION_ID: 'abc' } });
    assert.strictEqual(res2.vendor, 'zcode');
    assert.strictEqual(res2.precedence, 2);
    assert.strictEqual(res2.matched_by, 'explicit_session_payload');

    // 3. Registered session identity (优先级 3)
    // 独立沙箱目录，杜绝 CI 环境下缺少本地 .agents/task-loop/ 导致的断言失败
    const mockStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-vendor-node-'));
    const stateDir = path.join(mockStateRoot, '.agents', 'task-loop');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify({
      schema_version: 5,
      vendors: {
        antigravity: {
          vendor: 'antigravity',
          main_thread_id: 'mock-reg-session-id',
          sessions: [{ session_id: 'mock-reg-session-id', vendor: 'antigravity' }]
        }
      }
    }), 'utf8');

    let res3;
    try {
      res3 = resolveVendor({
        sessionId: 'mock-reg-session-id',
        env: { CODEX_THREAD_ID: 'codex-env' },
        projectRoot: mockStateRoot
      });
    } finally {
      fs.rmSync(mockStateRoot, { recursive: true, force: true });
    }
    assert.strictEqual(res3.vendor, 'antigravity');
    assert.strictEqual(res3.precedence, 3);
    assert.strictEqual(res3.matched_by, 'registered_session_identity');

    // 4. Runtime-native environment (优先级 4 - 单一环境正常判定)
    const res4 = resolveVendor({ env: { CODEX_THREAD_ID: 'thread-xyz' } });
    assert.strictEqual(res4.vendor, 'codex');
    assert.strictEqual(res4.precedence, 4);
    assert.strictEqual(res4.matched_by, 'runtime_environment');

    // 5. Runtime-native environment 冲突 (TL_VENDOR_AMBIGUOUS)
    // 环境变量中同时出现 CODEX_THREAD_ID 与 ZCODE_SESSION_ID
    assert.throws(() => {
      resolveVendor({ env: { CODEX_THREAD_ID: 'th-1', ZCODE_SESSION_ID: 'zc-1' } });
    }, (err) => err.code === 'TL_VENDOR_AMBIGUOUS');

    // throws: false 模式返回标准错误
    const resAmbiguous = resolveVendor({ env: { CODEX_THREAD_ID: 'th-1', ZCODE_SESSION_ID: 'zc-1' } }, { throws: false });
    assert.strictEqual(resAmbiguous.error, 'TL_VENDOR_AMBIGUOUS');
    assert.strictEqual(resAmbiguous.vendor, 'UNKNOWN');

    // 6. UNKNOWN (优先级 5)
    const res5 = resolveVendor({ env: {} });
    assert.strictEqual(res5.vendor, 'UNKNOWN');
    assert.strictEqual(res5.precedence, 5);

    console.log('VendorResolutionPolicyPrecedence PASSED!');
  } finally {
    process.env = originalEnv;
  }
}

async function runAll() {
  console.log('=== Running test_lease_manager.test.js ===');
  await testLeaseBasicLifecycle();
  testLeaseSchemaValidation();
  await testHighConcurrencyLockContention();
  testVendorResolutionPolicyPrecedence();
  console.log('ALL LeaseManager & VendorResolution Node.js Tests PASSED SUCCESSFULLY!\n');
}

runAll().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
