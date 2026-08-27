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

    console.log('✔ All new-session skill Node.js tests PASSED!');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
}

runNewSessionSkillTests();
