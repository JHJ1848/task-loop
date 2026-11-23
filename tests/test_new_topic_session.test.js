const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseMemoryDoc,
  createTopicMemoryDoc,
  provisionSingleDoc,
  provisionAllMissing
  } = require('../scripts/new_topic_session');

function runNewSessionSkillTests() {
  console.log('--- Running test_new_topic_session.test.js ---');

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'task_loop_new_session_test_'));
  const tmpMemoryDir = path.join(tmpWs, 'docs', 'memory');
  fs.mkdirSync(tmpMemoryDir, { recursive: true });

  try {
    // Test 1: parseMemoryDoc with structured content
    const sampleDoc = path.join(tmpMemoryDir, 'sample_topic.md');
    fs.writeFileSync(sampleDoc, `# [专题受控记忆] 样本功能专题 (sample_topic)
* 物理白名单: src/sample/**/*, tests/test_sample/**/*
`, 'utf8');

    const meta = parseMemoryDoc(sampleDoc, tmpWs);
    assert.strictEqual(meta.module_key, 'sample_topic');
    assert.strictEqual(meta.title, '[sample_topic专题] 核心功能维护 & 记忆沉淀');
    assert.ok(meta.allowlist.includes('src/sample/**/*'));

    // Test 2: createTopicMemoryDoc
    const createdDoc = createTopicMemoryDoc('brand_new', 'Brand New Topic', { wsRoot: tmpWs });
    assert.ok(fs.existsSync(createdDoc.docPath));
    const createdContent = fs.readFileSync(createdDoc.docPath, 'utf8');
    assert.ok(createdContent.includes('# [专题受控记忆] Brand New Topic (brand_new)'));

    // Test 3: provisionSingleDoc dry-run
    const dryRes = provisionSingleDoc(sampleDoc, tmpWs, { dryRun: true });
    assert.strictEqual(dryRes.status, 'DRY_RUN');
    assert.strictEqual(dryRes.module_key, 'sample_topic');

    // Test 4: provisionAllMissing dry-run
    const missingRes = provisionAllMissing(tmpWs, { dryRun: true });
    assert.strictEqual(missingRes.count, 2); // sample_topic.md and brand_new.md

    // Test 5: surveyMemoryDocsStatus safe survey
    const { surveyMemoryDocsStatus } = require('../scripts/new_topic_session');
    const survey = surveyMemoryDocsStatus(tmpWs);
    assert.strictEqual(survey.allDocs.length, 2);
    assert.strictEqual(survey.missing.length, 2);
    assert.strictEqual(survey.aligned.length, 0);

    // Codex creates through Desktop create_thread; this path only emits a request template.
    const { spawnRootConversation } = require('../scripts/new_topic_session');
    const previousCodexThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = 'codex-test-thread';
    try {
      const res = spawnRootConversation('[测试专题] x', '初始化', tmpWs);
      assert.strictEqual(res.status, 'PENDING_CREATION');
      assert.strictEqual(res.host_action, 'create_thread');
    } finally {
      if (previousCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousCodexThread;
    }

    console.log('✔ All new-session skill Node.js tests PASSED!');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
}

runNewSessionSkillTests();

function runCodexMemoryUpgradeTests() {
  const sessions = require('../scripts/new_topic_session');
  const { initialize } = require('../skills/project-memory/scripts/runtime/framework');
  const provider = require('../scripts/providers/codex_session_provider');
  const previousCreate = provider.create;
  provider.create = () => ({ status: 'PENDING_CREATION' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex memory upgrade '));
  const workspace = (name, ready = false) => {
    const ws = path.join(root, name);
    fs.mkdirSync(ws);
    if (ready) initialize(ws, {});
    return ws;
  };
  const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? Object.entries(snapshot(full)).map(([key, value]) => [entry.name + '/' + key, value])
      : [[entry.name, fs.readFileSync(full).toString('base64')]];
  }));

  try {
    const ready = workspace('已就绪项目', true);
    const title = '[专题 A] Windows 路径 & 中文标题';
    const result = sessions.createTopicAndSession('topic_a', title, ready, { vendor: 'codex' });
    assert.strictEqual(result.status, 'PENDING_CREATION');
    const doc = path.join(ready, 'docs/memory/topic_a.md');
    assert.ok(fs.readFileSync(doc, 'utf8').includes('project-memory:features:start'));
    assert.ok(fs.readFileSync(path.join(ready, 'docs/MEMORY.md'), 'utf8').includes('memory/topic_a.md'));
    assert.ok(!fs.existsSync(path.join(ready, '.agents/task-loop')));

    const bound = sessions.bindCurrentSession('bound', title, 'formal-test-id', ready, { vendor: 'codex', id_kind: 'threadId' });
    assert.strictEqual(bound.status, 'BOUND');
    fs.unlinkSync(path.join(ready, 'docs/memory/bound.md'));
    const boundSnapshot = snapshot(ready);
    assert.strictEqual(sessions.createTopicAndSession('bound', 'Changed', ready, { vendor: 'codex' }).status, 'EXISTS');
    assert.deepStrictEqual(snapshot(ready), boundSnapshot);

    for (const isReady of [false, true]) {
      const ws = workspace('preserve-' + isReady, isReady);
      const legacy = path.join(ws, 'docs/memory/existing.md');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, '# [既有专题] 核心 & 事实\n原有正文\n');
      const before = snapshot(ws);
      sessions.createTopicMemoryDoc('existing', 'Replacement', { wsRoot: ws, vendor: 'codex', force: true });
      assert.strictEqual(sessions.createTopicAndSession('existing', 'Replacement', ws, { vendor: 'codex', force: true }).status, 'PENDING_CREATION');
      assert.deepStrictEqual(snapshot(ws), before);
      sessions.bindCurrentSession('existing', 'Replacement', 'bound-test-id', ws, { vendor: 'codex', id_kind: 'threadId', force: true });
      assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '# [既有专题] 核心 & 事实\n原有正文\n');
    }

    const legacy = workspace('unmigrated');
    fs.mkdirSync(path.join(legacy, 'docs'));
    fs.writeFileSync(path.join(legacy, 'docs/MEMORY.md'), '# 原有主记忆\n业务事实\n');
    sessions.createTopicMemoryDoc('legacy', title, { wsRoot: legacy, vendor: 'codex' });
    assert.ok(fs.readFileSync(path.join(legacy, 'docs/memory/legacy.md'), 'utf8').startsWith('# [专题受控记忆]'));
    assert.strictEqual(fs.readFileSync(path.join(legacy, 'docs/MEMORY.md'), 'utf8'), '# 原有主记忆\n业务事实\n');
    assert.ok(!fs.existsSync(path.join(legacy, 'AGENTS.md')));

    const otherVendor = workspace('other-vendor', true);
    const otherIndex = fs.readFileSync(path.join(otherVendor, 'docs/MEMORY.md'), 'utf8');
    sessions.createTopicMemoryDoc('other', title, { wsRoot: otherVendor, vendor: 'antigravity' });
    assert.ok(fs.readFileSync(path.join(otherVendor, 'docs/memory/other.md'), 'utf8').startsWith('# [专题受控记忆]'));
    assert.strictEqual(fs.readFileSync(path.join(otherVendor, 'docs/MEMORY.md'), 'utf8'), otherIndex);

    const preview = workspace('preview', true);
    const previewSnapshot = snapshot(preview);
    sessions.createTopicAndSession('preview', title, preview, { vendor: 'codex', dryRun: true, force: true });
    sessions.bindCurrentSession('preview', title, 'preview-id', preview, { vendor: 'codex', dryRun: true, id_kind: 'threadId' });
    assert.deepStrictEqual(snapshot(preview), previewSnapshot);
    assert.throws(() => sessions.bindCurrentSession('preview', title, 'client-id', preview,
      { vendor: 'codex', id_kind: 'clientThreadId' }), /正式 threadId/);
    assert.deepStrictEqual(snapshot(preview), previewSnapshot);

    const candidate = workspace('candidate-legacy');
    const readFile = fs.readFileSync;
    const manifest = path.resolve(__dirname, '../.codex-plugin/plugin.json');
    fs.readFileSync = function (file, ...args) {
      return path.resolve(String(file)) === manifest
        ? JSON.stringify({ name: 'session-memory-workflow' })
        : readFile.call(this, file, ...args);
    };
    try {
      assert.throws(() => sessions.createTopicAndSession('blocked', title, candidate, { vendor: 'codex' }), /memory-init/);
      assert.deepStrictEqual(snapshot(candidate), {});
    } finally {
      fs.readFileSync = readFile;
    }

    const oldNode = workspace('old-node', true);
    const oldSnapshot = snapshot(oldNode);
    const version = Object.getOwnPropertyDescriptor(process.versions, 'node');
    Object.defineProperty(process.versions, 'node', { ...version, value: '18.20.0' });
    try {
      assert.throws(() => sessions.createTopicMemoryDoc('blocked', title, { wsRoot: oldNode, vendor: 'codex' }), /Node.js 20\+/);
      assert.deepStrictEqual(snapshot(oldNode), oldSnapshot);
      const oldLegacy = workspace('old-node-legacy');
      sessions.createTopicMemoryDoc('legacy', title, { wsRoot: oldLegacy, vendor: 'codex' });
      assert.ok(fs.existsSync(path.join(oldLegacy, 'docs/memory/legacy.md')));
    } finally {
      Object.defineProperty(process.versions, 'node', version);
    }
    console.log('Codex memory upgrade cases PASSED');
  } finally {
    provider.create = previousCreate;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runCodexMemoryUpgradeTests();
