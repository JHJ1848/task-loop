/**
 * [Test Suite] tests/test_init_title_precedence.test.js
 * 
 * 验证 /init 流程中终态标题解析四级优先级规范 (Title Resolution Precedence):
 * Priority 1 (跨分区继承): 优先检查同工程 sessions.json 中其他 vendor 分区对同一 module_key 已确立的高置信度成熟 title (非死模板)
 * Priority 2 (记忆文档 H1): 若无既有跨分区成熟命名，使用 doc.title (清洗 [受控记忆] 并规范化为 [专题名] 核心功能1 & 核心功能2)
 * Priority 3 (启发式语义推断): 若无标题，结合该模块职责/Tags/预置表推断标准格式 (如 [Blender] 模型创建编辑 & 场景检查)
 * Priority 4 (兜底模板): 最后降级为 [${moduleKey}专题] 核心功能维护 & 记忆沉淀
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveOptimalTopicTitle,
  isGenericTemplate,
  normalizeH1Title,
  initTaskLoop
} = require('../scripts/init_task_loop');

function runTitlePrecedenceTests() {
  console.log('=== Running tests/test_init_title_precedence.test.js ===');

  // ---------------------------------------------------------------------------
  // 1. 辅助函数测试: isGenericTemplate & normalizeH1Title
  // ---------------------------------------------------------------------------
  console.log('- Testing isGenericTemplate...');
  assert.strictEqual(isGenericTemplate('[hook专题] 核心功能维护 & 记忆沉淀', 'hook'), true);
  assert.strictEqual(isGenericTemplate('[hook专题]', 'hook'), true);
  assert.strictEqual(isGenericTemplate('[hook]', 'hook'), true);
  assert.strictEqual(isGenericTemplate('hook', 'hook'), true);
  assert.strictEqual(isGenericTemplate('[业务专题] 通用开发', 'any'), true);
  assert.strictEqual(isGenericTemplate('', 'hook'), true);
  assert.strictEqual(isGenericTemplate(null, 'hook'), true);

  // 成熟高质量标题必须判定为 false
  assert.strictEqual(isGenericTemplate('[钩子专题] 生命周期 & 安全门禁', 'hook'), false);
  assert.strictEqual(isGenericTemplate('[Application] 场景搭建交互 & 应用系统开发', 'application'), false);
  assert.strictEqual(isGenericTemplate('[Blender] 模型创建编辑 & 场景检查', 'blender'), false);
  assert.strictEqual(isGenericTemplate('[Session] SDK & Scripting', 'session_control'), false);

  console.log('- Testing normalizeH1Title...');
  // 清洗 [受控记忆]
  assert.strictEqual(
    normalizeH1Title('[受控记忆] [钩子专题] 生命周期 & 安全门禁', 'hook'),
    '[钩子专题] 生命周期 & 安全门禁'
  );
  assert.strictEqual(
    normalizeH1Title('# [受控记忆文档] [Session] SDK & Scripting', 'session_control'),
    '[Session] SDK & Scripting'
  );
  // 补齐缺失的方括号
  assert.strictEqual(
    normalizeH1Title('场景搭建交互 & 应用系统开发', 'application'),
    '[Application] 场景搭建交互 & 应用系统开发'
  );
  assert.strictEqual(
    normalizeH1Title('application: 场景搭建交互 & 应用系统开发', 'application'),
    '[Application] 场景搭建交互 & 应用系统开发'
  );

  // ---------------------------------------------------------------------------
  // 2. 隔离临时环境准备
  // ---------------------------------------------------------------------------
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'task_loop_title_test_'));
  const taskLoopDir = path.join(tmpWs, '.agents', 'task-loop');
  const memoryDir = path.join(tmpWs, 'docs', 'memory');
  fs.mkdirSync(taskLoopDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // 3. Priority 1 (跨分区继承测试)
    // -------------------------------------------------------------------------
    console.log('- Testing Priority 1: Cross-vendor partition inheritance...');
    // 在同工程 sessions.json 中写入 codex 分区成熟标题
    const multiVendorSessions = {
      schema_version: 5,
      revision: 1,
      vendors: {
        codex: {
          vendor: 'codex',
          main_thread_id: 'thread_codex_main',
          modules: {
            application: {
              session_id: 'thread_app_001',
              vendor: 'codex',
              title: '[Application] 场景搭建交互 & 应用系统开发'
            }
          }
        },
        antigravity: {
          vendor: 'antigravity',
          main_thread_id: 'sess_agy_main',
          modules: {}
        }
      }
    };
    fs.writeFileSync(
      path.join(taskLoopDir, 'sessions.json'),
      JSON.stringify(multiVendorSessions, null, 2),
      'utf8'
    );

    // 当前在 antigravity 下初始化 application，记忆文档尚无标题或仅有死模板
    const docApp = { module_key: 'application' };
    const p1Title = resolveOptimalTopicTitle(docApp, {}, null, 'antigravity', tmpWs);
    assert.strictEqual(
      p1Title,
      '[Application] 场景搭建交互 & 应用系统开发',
      'Priority 1: 必须优先继承 codex 分区已确立的成熟标题'
    );

    // -------------------------------------------------------------------------
    // 4. Priority 2 (记忆文档 H1 提取与规范化清洗测试)
    // -------------------------------------------------------------------------
    console.log('- Testing Priority 2: Memory doc H1 extraction & normalization...');
    // 无跨分区标题，有本地 docs/memory/custom_mod.md
    fs.writeFileSync(
      path.join(memoryDir, 'custom_mod.md'),
      '# [受控记忆] [自定义专题] 复杂流转 & 异常防护\n\n受控记忆正文...',
      'utf8'
    );
    const docCustom = {
      module_key: 'custom_mod',
      relative_path: 'docs/memory/custom_mod.md',
      absolute_path: path.join(memoryDir, 'custom_mod.md')
    };
    const p2Title = resolveOptimalTopicTitle(docCustom, {}, null, 'antigravity', tmpWs);
    assert.strictEqual(
      p2Title,
      '[自定义专题] 复杂流转 & 异常防护',
      'Priority 2: 必须正确从 H1 提取并清洗 [受控记忆]'
    );

    // -------------------------------------------------------------------------
    // 5. Priority 3 (启发式语义推断测试)
    // -------------------------------------------------------------------------
    console.log('- Testing Priority 3: Semantic heuristic preset & tags inference...');
    // 预置表命中: blender (无跨分区，doc.title 为死模板)
    const docBlender = {
      module_key: 'blender',
      title: '[blender专题] 核心功能维护 & 记忆沉淀' // 死模板必须被忽略
    };
    const p3TitlePreset = resolveOptimalTopicTitle(docBlender, {}, null, 'antigravity', tmpWs);
    assert.strictEqual(
      p3TitlePreset,
      '[Blender] 模型创建编辑 & 场景检查',
      'Priority 3: 命中语义预置表时应推导为标准规范标题'
    );

    // Tags 驱动推断:未知模块但具备业务 tags
    const docTagged = {
      module_key: 'renderer',
      tags: ['renderer', '着色器编译', '几何光栅化']
    };
    const p3TitleTagged = resolveOptimalTopicTitle(docTagged, {}, null, 'antigravity', tmpWs);
    assert.strictEqual(
      p3TitleTagged,
      '[Renderer] 着色器编译 & 几何光栅化',
      'Priority 3: 应根据 tags 推导标准结构'
    );

    // -------------------------------------------------------------------------
    // 6. Priority 4 (兜底模板降级测试)
    // -------------------------------------------------------------------------
    console.log('- Testing Priority 4: Fallback generic template...');
    const docUnknown = {
      module_key: 'unknown_xyz'
    };
    const p4Title = resolveOptimalTopicTitle(docUnknown, {}, null, 'antigravity', tmpWs);
    assert.strictEqual(
      p4Title,
      '[unknown_xyz专题] 核心功能维护 & 记忆沉淀',
      'Priority 4: 无任何线索时降级为兜底模板'
    );

    // -------------------------------------------------------------------------
    // 7. initTaskLoop 端到端物理创建 title 验证
    // -------------------------------------------------------------------------
    console.log('- Testing End-to-End initTaskLoop mock spawn title...');
    const capturedSpawns = [];
    const mockSpawn = (title, prompt, wsRoot, opt) => {
      capturedSpawns.push({ title, prompt, opt });
      return {
        status: 'CREATED',
        vendor: opt.vendor || 'antigravity',
        id: `mock_sess_${opt.role || 'topic'}_${title.slice(0, 10)}`,
        id_kind: 'conversationId',
        resumable: true,
        physical_session: true,
        title
      };
    };

    // 准备一个独立的测试工程目录
    const e2eWs = fs.mkdtempSync(path.join(os.tmpdir(), 'task_loop_e2e_title_'));
    const e2eMemDir = path.join(e2eWs, 'docs', 'memory');
    fs.mkdirSync(e2eMemDir, { recursive: true });
    // 创建一个包含规范 H1 的文档
    fs.writeFileSync(
      path.join(e2eMemDir, 'blender.md'),
      '# [受控记忆] [Blender] 模型创建编辑 & 场景检查\n\n正文',
      'utf8'
    );

    initTaskLoop({
      wsRoot: e2eWs,
      vendor: 'antigravity',
      dryRun: false,
      forceMain: true,
      createMissing: true,
      spawnConversation: mockSpawn
    });

    const blenderSpawn = capturedSpawns.find(s => s.title.includes('Blender'));
    assert.ok(blenderSpawn, 'E2E: 必须触发 Blender 专题物理创建');
    assert.strictEqual(
      blenderSpawn.title,
      '[Blender] 模型创建编辑 & 场景检查',
      'E2E: 传给 spawnRootConversation 的 title 必须是最优规范标题而非死模板'
    );

    // 清理 e2e 临时目录
    fs.rmSync(e2eWs, { recursive: true, force: true });

    console.log('ALL Title Precedence Tests PASSED SUCCESSFULLY!');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runTitlePrecedenceTests();
}

module.exports = { runTitlePrecedenceTests };
