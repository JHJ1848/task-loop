'use strict';

const {
  VALUE_LEVELS,
  VALIDITY_VALUES,
  MAIN_INDEX_START,
  MAIN_INDEX_END,
  TOPICS_INDEX_START,
  TOPICS_INDEX_END,
  CHANGE_INDEX_START,
  CHANGE_INDEX_END,
  FEATURES_INDEX_START,
  FEATURES_INDEX_END,
  APIS_INDEX_START,
  APIS_INDEX_END,
} = require('./constants');
const { fail } = require('./errors');
const { withLock } = require('./lock');

const TRUST_LEVELS = new Set(['verified_runtime', 'trusted_project', 'external_untrusted']);
const {
  fs,
  path,
  readText,
  writeTextAtomic,
  existingFile,
  toProjectPath,
  relativeFromFile,
  ensureSafeDirectory,
  assertSafeDocsTarget,
  assertSafeExistingDirectory,
  assertSafeProjectFile,
} = require('./filesystem');
const {
  ensureFramework,
  frameworkIsWritable,
  ensureMainMemoryStructure,
  inspectFramework,
  resolveAgentsPath,
  markerBody,
  replaceMarkerBlock,
  parseMarkerFields,
} = require('./framework');
const { parseIndexEntries } = require('./retrieval');
const { safeTaskId, taskDirectory, taskPathForManagedFile, readTaskManifest, readTaskPath, refreshTaskManifest } = require('./tasks');
const { assertNoSecrets } = require('./secret-inspection');
const { parseHeadings } = require('./markdown-outline');

function ensureTopicStructure(content, topicName) {
  const base = content.length > 0 ? content : `# 专题受控记忆: ${topicName}\n`;
  let result = base;
  if (markerBody(result, FEATURES_INDEX_START, FEATURES_INDEX_END) === null) {
    const suffix = result.length === 0 ? '' : (result.endsWith('\n') ? '\n' : '\n\n');
    result = `${result}${suffix}## 功能与场景索引\n\n${FEATURES_INDEX_START}\n${FEATURES_INDEX_END}\n`;
  }
  if (markerBody(result, CHANGE_INDEX_START, CHANGE_INDEX_END) === null) {
    const suffix = result.length === 0 ? '' : (result.endsWith('\n') ? '\n' : '\n\n');
    result = `${result}${suffix}## 专题变更索引\n\n${CHANGE_INDEX_START}\n${CHANGE_INDEX_END}\n`;
  }
  return result;
}

function compactText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markdownLabel(value) {
  return String(value).replace(/[\[\]]/g, '\\$&');
}

function indexDescription(value) {
  const compact = compactText(value);
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function upsertIndexEntry(content, start, end, label, href, description) {
  const current = parseIndexEntries(content, start, end);
  const entry = `- [${markdownLabel(label)}](${href}) - ${indexDescription(description)}`;
  const kept = current.filter((item) => item.href !== href).map((item) => item.raw);
  kept.push(entry);
  return replaceMarkerBlock(content, start, end, kept);
}

function writeTopicDocument(projectRoot, topicPath, topicName) {
  assertSafeDocsTarget(projectRoot, topicPath, false);
  const current = existingFile(topicPath) ? readText(topicPath) : '';
  const next = ensureTopicStructure(current, topicName);
  if (next !== current) {
    ensureSafeDirectory(projectRoot, path.dirname(topicPath));
    assertSafeDocsTarget(projectRoot, topicPath, false);
    writeTextAtomic(topicPath, next);
  }
}

function updateIndexes(projectRoot, framework, target, classification, title, summary, apiRef) {
  const lockPath = path.join(projectRoot, '.agents', 'project-memory', 'memory.lock');
  return withLock(lockPath, () => {
    const memoryPath = path.resolve(projectRoot, framework.memory);
    const agentsPath = resolveAgentsPath(projectRoot);

    if (classification.kind === 'change') {
      let memoryContent = ensureMainMemoryStructure(readText(memoryPath), memoryPath, agentsPath);
      memoryContent = upsertIndexEntry(memoryContent, CHANGE_INDEX_START, CHANGE_INDEX_END, title, relativeFromFile(memoryPath, target), summary);
      if (apiRef) {
        memoryContent = upsertIndexEntry(memoryContent, APIS_INDEX_START, APIS_INDEX_END, apiRef.label || path.basename(apiRef.path, '.md'), relativeFromFile(memoryPath, apiRef.path), apiRef.description || summary);
      }
      assertSafeProjectFile(projectRoot, memoryPath, true);
      writeTextAtomic(memoryPath, memoryContent);

      let topicProjectPath = null;
      if (classification.topicName) {
        const topicPath = path.join(projectRoot, 'docs', 'memory', `${classification.topicName}.md`);
        if (existingFile(topicPath)) {
          let topicContent = readText(topicPath);
          if (markerBody(topicContent, CHANGE_INDEX_START, CHANGE_INDEX_END) !== null) {
            topicContent = upsertIndexEntry(topicContent, CHANGE_INDEX_START, CHANGE_INDEX_END, title, relativeFromFile(topicPath, target), summary);
            assertSafeDocsTarget(projectRoot, topicPath, true);
            writeTextAtomic(topicPath, topicContent);
            topicProjectPath = toProjectPath(projectRoot, topicPath);
          }
        }
      }
      return { main: toProjectPath(projectRoot, memoryPath), topic: topicProjectPath };
    }

    writeTopicDocument(projectRoot, classification.topicPath, classification.topicName);
    if (classification.kind === 'feature') {
      let topicContent = readText(classification.topicPath);
      topicContent = upsertIndexEntry(topicContent, FEATURES_INDEX_START, FEATURES_INDEX_END, title, relativeFromFile(classification.topicPath, target), summary);
      assertSafeDocsTarget(projectRoot, classification.topicPath, true);
      writeTextAtomic(classification.topicPath, topicContent);
    }

    let memoryContent = ensureMainMemoryStructure(readText(memoryPath), memoryPath, agentsPath);
    memoryContent = upsertIndexEntry(memoryContent, TOPICS_INDEX_START, TOPICS_INDEX_END, classification.topicName, relativeFromFile(memoryPath, classification.topicPath), summary);
    assertSafeProjectFile(projectRoot, memoryPath, true);
    writeTextAtomic(memoryPath, memoryContent);
    return { main: toProjectPath(projectRoot, memoryPath), topic: toProjectPath(projectRoot, classification.topicPath) };
  });
}

function normalizeModuleKey(value) {
  const moduleKey = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(moduleKey)) {
    fail('--module-key 必须是 1-64 位小写字母、数字、连字符或下划线，并以字母或数字开头。');
  }
  return moduleKey;
}

/**
 * 为会话模块建立或复用其专题记忆文件。该入口只管理记忆索引；会话绑定
 * 仍由 session-init / new-session 处理，避免两个模块抢写同一状态机。
 */
function provisionTopic(projectRoot, options) {
  const framework = inspectFramework(projectRoot);
  if (framework.status !== 'ready') {
    return {
      status: 'requires_memory_initialization',
      framework_status: framework.status,
      framework,
      hint: '建档不会隐式初始化、迁移或重置记忆。请先显式运行 memory-init；旧 MEMORY.md 需先选择 migrate、keep 或 reset。',
    };
  }

  const moduleKey = normalizeModuleKey(options['module-key'] || options.module_key || options.topic);
  const title = compactText(options.title || options['display-title'] || moduleKey);
  if (!title) {
    fail('建档需要 --title 或 --display-title。');
  }
  const summary = compactText(options.summary || `专题记忆：${title}`) || `专题记忆：${title}`;
  const topicPath = path.join(projectRoot, 'docs', 'memory', `${moduleKey}.md`);
  const lockPath = path.join(projectRoot, '.agents', 'project-memory', 'memory.lock');
  let existed = false;
  let indexUpdated = false;
  withLock(lockPath, () => {
    assertSafeDocsTarget(projectRoot, topicPath, false);
    existed = existingFile(topicPath);
    if (!existed) {
      writeTopicDocument(projectRoot, topicPath, title);
    }
    const memoryPath = path.resolve(projectRoot, framework.memory);
    const agentsPath = resolveAgentsPath(projectRoot);
    const memoryContent = ensureMainMemoryStructure(readText(memoryPath), memoryPath, agentsPath);
    const nextMemoryContent = upsertIndexEntry(
      memoryContent,
      TOPICS_INDEX_START,
      TOPICS_INDEX_END,
      title,
      relativeFromFile(memoryPath, topicPath),
      summary,
    );
    indexUpdated = nextMemoryContent !== memoryContent;
    if (indexUpdated) {
      assertSafeProjectFile(projectRoot, memoryPath, true);
      writeTextAtomic(memoryPath, nextMemoryContent);
    }
  });

  return {
    status: existed ? 'reused' : 'provisioned',
    module_key: moduleKey,
    title,
    memory_doc: toProjectPath(projectRoot, topicPath),
    index: toProjectPath(projectRoot, path.resolve(projectRoot, framework.memory)),
    body_preserved: existed,
    index_updated: indexUpdated,
    next: '将 module_key 和 memory_doc 交给 session-init 或 new-session；该命令不创建或绑定会话。',
  };
}

function sceneContainsSummary(scene, summary) {
  return scene.split(/\r?\n/).some((line) => {
    const match = line.match(/^- (?:摘要|Summary):\s*(.*)$/);
    return match && compactText(match[1]) === summary;
  });
}

function lineStartOffset(content, lineNumber) {
  let offset = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    const next = content.indexOf('\n', offset);
    if (next === -1) {
      return content.length;
    }
    offset = next + 1;
  }
  return offset;
}

function sceneRange(content, title) {
  const headings = parseHeadings(content);
  const index = headings.findIndex((heading) => heading.level === 3 && heading.title === title);
  if (index === -1) {
    return null;
  }
  const current = headings[index];
  const following = headings.slice(index + 1).find((heading) => heading.level <= 3);
  return {
    start: lineStartOffset(content, current.line),
    end: following ? lineStartOffset(content, following.line) : content.length,
  };
}

function appendSceneRecord(content, title, summary, record, replace) {
  const range = sceneRange(content, title);
  if (!range) {
    const prefix = content.length === 0 || content.endsWith('\n') ? content : `${content}\n`;
    return { content: `${prefix}${prefix.length > 0 ? '\n' : ''}${record}\n`, action: 'appended' };
  }
  const existingScene = content.slice(range.start, range.end);
  if (sceneContainsSummary(existingScene, summary)) {
    return { content, action: 'duplicate' };
  }
  if (!replace) {
    return { content, action: 'requires_replace_confirmation' };
  }
  const before = content.slice(0, range.start);
  const after = content.slice(range.end);
  const separatorAfter = after.length === 0 || after.startsWith('\n') ? '' : '\n';
  return { content: `${before}${record}\n${separatorAfter}${after}`, action: 'replaced' };
}

function sourceFilesForTask(projectRoot, taskId) {
  if (!taskId) {
    fail('正式归档必须提供 --task <主任务id>，以关联临时证据。');
  }
  const directory = taskDirectory(projectRoot, taskId);
  if (!fs.existsSync(directory)) {
    fail(`未找到主任务临时目录：${taskId}。请先通过 temp 或 draft 记录证据。`);
  }
  refreshTaskManifest(projectRoot, taskId);
  const manifest = readTaskManifest(projectRoot, taskId);
  if (!manifest) {
    fail(`主任务 ${taskId} 缺少有效 task.json，拒绝脱离临时证据正式归档。`);
  }
  assertSafeExistingDirectory(projectRoot, directory);
  return manifest.managed_files.filter((fileName) => fileName !== 'task.json').filter((fileName) => existingFile(taskPathForManagedFile(directory, fileName))).filter((fileName) => {
    try {
      assertSafeProjectFile(projectRoot, taskPathForManagedFile(directory, fileName), true);
      return true;
    } catch (error) {
      return false;
    }
  }).map((fileName) => toProjectPath(projectRoot, taskPathForManagedFile(directory, fileName))).sort();
}

function valueAssessment(options) {
  if (!options.value) {
    return { archive: false, status: 'requires_value_assessment' };
  }
  if (!VALUE_LEVELS.has(options.value)) {
    fail('--value 只能是 high、medium 或 low。');
  }
  if (options.value === 'low') {
    return { archive: false, status: 'not_archived_low_value', value: options.value, reason: compactText(options.assessment || '') };
  }
  return { archive: true, value: options.value, reason: compactText(options.assessment || '') };
}

function resolveFormalTarget(projectRoot, options) {
  if (options.target) {
    return assertSafeDocsTarget(projectRoot, path.resolve(projectRoot, options.target), false);
  }
  if (options.topic) {
    const topic = String(options.topic).trim();
    const feature = options.feature ? String(options.feature).trim() : null;
    if (!/^[^\\/:*?"<>|.][^\\/:*?"<>|]{0,119}$/.test(topic) || (feature && !/^[^\\/:*?"<>|.][^\\/:*?"<>|]{0,119}$/.test(feature))) {
      fail('专题和功能名称不能包含路径分隔符、保留文件名字符或前导点。');
    }
    const target = feature ? path.join(projectRoot, 'docs', 'memory', topic, `${feature}.md`) : path.join(projectRoot, 'docs', 'memory', `${topic}.md`);
    return assertSafeDocsTarget(projectRoot, target, false);
  }
  fail('正式归档需要 `docs/` 下的 --target；建议使用 docs/change/<专题>/YYYY-MM-DD_中文简述.md 或 docs/memory/<专题>.md。');
}

function classifyFormalTarget(projectRoot, target) {
  const docsPath = path.join(projectRoot, 'docs');
  const segments = toProjectPath(docsPath, target).split('/');
  if (segments[0] === 'memory' && segments.length === 2 && segments[1].toLowerCase().endsWith('.md')) {
    return { kind: 'topic', topicPath: target, topicName: path.basename(target, '.md') };
  }
  if (segments[0] === 'memory' && segments.length === 3 && segments[2].toLowerCase().endsWith('.md')) {
    return { kind: 'feature', topicPath: path.join(docsPath, 'memory', `${segments[1]}.md`), topicName: segments[1], featureName: path.basename(segments[2], '.md') };
  }
  if (segments[0] === 'change' && segments.length === 3 && segments[2].toLowerCase().endsWith('.md')) {
    const topicName = segments[1];
    const topicPath = path.join(docsPath, 'memory', `${topicName}.md`);
    if (!existingFile(topicPath)) {
      fail(`专题受控记忆文件不存在：docs/memory/${topicName}.md，禁止无主创建变更记录；请先创建或注册对应专题。`);
    }
    return { kind: 'change', topicName, topicPath };
  }
  if (segments[0] === 'change' && segments.length === 2 && segments[1].toLowerCase().endsWith('.md')) {
    if (!existingFile(target)) {
      fail('新变更记录必须归入具体专题目录：docs/change/<专题>/<记录>.md，禁止创建无主平铺记录。');
    }
    return { kind: 'change', topicName: null, topicPath: null };
  }
  fail('正式归档目标只能是 docs/change/<专题>/<记录>.md、docs/memory/<专题>.md 或 docs/memory/<专题>/<功能>.md。');
}

function replacementChangeRecord(projectRoot, options) {
  if (!options['change-record']) {
    fail('覆盖场景必须提供既有 docs/change/ 记录：--change-record docs/change/<记录>.md。');
  }
  const target = assertSafeDocsTarget(projectRoot, path.resolve(projectRoot, options['change-record']), true);
  if (classifyFormalTarget(projectRoot, target).kind !== 'change') {
    fail('--change-record 必须指向 docs/change/ 下的既有 Markdown 记录。');
  }
  return target;
}

function normalizeHeading(value, label) {
  const normalized = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!normalized) {
    fail(`必须提供 ${label}。`);
  }
  return normalized;
}

function controlledField(value, fallback) {
  const compact = compactText(value);
  return compact || fallback;
}

function controlledDate(value, label) {
  if (!value) {
    return '未注明';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} 必须使用 YYYY-MM-DD。`);
  }
  return value;
}

function controlledReferences(projectRoot, recordPath, value, label, multiple) {
  if (!value) {
    return '无';
  }
  const values = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || (!multiple && values.length !== 1)) {
    fail(`${label} 必须包含${multiple ? '一个或多个引用' : '一个引用'}。`);
  }
  return values.map((item) => {
    const separator = item.indexOf('|');
    const text = separator === -1 ? '' : item.slice(0, separator).trim();
    const targetText = (separator === -1 ? item : item.slice(separator + 1)).trim();
    const target = assertSafeDocsTarget(projectRoot, path.resolve(projectRoot, targetText), false);
    const display = text || path.basename(target, '.md');
    if (!display || /[\r\n\[\]]/.test(display)) {
      fail(`${label} 包含无效的引用标签。`);
    }
    return `[${markdownLabel(display)}](${relativeFromFile(recordPath, target)})`;
  }).join(', ');
}

function shortenPathText(value, limit) {
  const text = compactText(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function pathMemoryInfo(pathRecord) {
  if (!pathRecord || pathRecord.nodes.length === 0) {
    return { summary: '无', keywords: '无', facts: '' };
  }
  const parents = new Set(pathRecord.nodes.map((node) => node.parent).filter(Boolean));
  const selected = [];
  const seen = new Set();
  const select = (node) => {
    if (!seen.has(node.id) && selected.length < 6) {
      seen.add(node.id);
      selected.push(node);
    }
  };
  for (const node of pathRecord.nodes) {
    if (!parents.has(node.id) && (node.status === '已证实' || node.status === '已实施')) {
      select(node);
    }
  }
  for (const node of pathRecord.nodes) {
    if (node.status === '已排除' && node.conclusion) {
      select(node);
    }
  }
  if (selected.length === 0) {
    return { summary: '无', keywords: '无', facts: '' };
  }
  const describe = (node) => `${node.id} ${node.summary} [${node.status}]${node.conclusion ? `：${shortenPathText(node.conclusion, 80)}` : ''}`;
  const summary = shortenPathText(selected.map(describe).join('；'), 360);
  const keywords = shortenPathText(selected.map((node) => `${node.summary}${node.conclusion ? ` ${node.conclusion}` : ''}`).join('；'), 240);
  return { summary, keywords, facts: `- 排查路径: ${summary}` };
}

function formalTextFields(options) {
  return [
    { label: '标题', value: options.title },
    { label: '摘要', value: options.summary || options.text },
    { label: '价值评估说明', value: options.assessment },
    { label: '问题/需求', value: options.problem || options.goal },
    { label: '原因分析与已证实事实', value: options.facts },
    { label: '处理与决策', value: options.decision },
    { label: '测试结果', value: options.result },
    { label: '备注/边界/未知', value: options.notes || options.note || options.boundary || options.gotcha },
  ];
}

/**
 * 生成符合规范的标准四段式场景记录
 */
function sceneRecord(projectRoot, target, options, title, summary, assessment, sourceFiles, pathInfo, changeRecord) {
  const validity = options.validity || 'active';
  if (!VALIDITY_VALUES.has(validity)) {
    fail('--validity 只能是 active、superseded、historical 或 needs-review。');
  }
  const trustLevel = options['trust-level'] || options.trust || 'verified_runtime';
  if (!TRUST_LEVELS.has(trustLevel)) {
    fail('--trust-level 只能是 verified_runtime、trusted_project 或 external_untrusted。');
  }
  const problemOrGoal = controlledField(options.problem || options.goal, summary);
  const facts = controlledField(options.facts, '已确认核心因果链路并完成验证。');
  const factsWithPath = pathInfo.facts ? `${facts}\n\n${pathInfo.facts}` : facts;
  const result = controlledField(options.result, '本地自测验证通过。');
  const notes = controlledField(options.notes || options.note || options.boundary || options.gotcha || options.decision, '无特殊风险，遵循最小改动原则。');
  const confirmationType = options.confirmation_type || (options.receipt ? 'verified_receipt' : (options.confirmed ? 'legacy_flag' : 'legacy_flag'));
  let authorization = '';
  if (confirmationType === 'verified_receipt') {
    authorization = `调用方提供确认收据 (--receipt)；已核验有效期与授权范围${options.receipt_id ? ` (收据ID: ${options.receipt_id})` : ''}。`;
  } else if (options.explicit) {
    authorization = '调用方提供 --explicit；运行时不验证用户意图 (legacy_flag)。';
  } else {
    authorization = '调用方提供 --confirmed；运行时不验证用户确认 (legacy_flag)。';
  }
  const apiRef = controlledReferences(projectRoot, target, options.api || options['api-doc'], '--api', true);

  return [
    `### ${title}`,
    '',
    `- 摘要: ${summary}`,
    `- 确认类型: ${confirmationType}`,
    `- 信任级别: ${trustLevel}`,
    `- 价值评估: ${assessment.value}${assessment.reason ? ` - ${assessment.reason}` : ''}`,
    `- 有效性: ${validity}`,
    `- 最近核验: ${controlledDate(options['last-verified'], '--last-verified')}`,
    `- 复核日期: ${controlledDate(options['review-after'], '--review-after')}`,
    `- 替代关系: ${controlledReferences(projectRoot, target, options['superseded-by'], '--superseded-by', false)}`,
    `- 关联记录: ${controlledReferences(projectRoot, target, options.related, '--related', true)}`,
    `- 关联API: ${apiRef}`,
    `- 替代变更: ${changeRecord ? `[${markdownLabel(path.basename(changeRecord, '.md'))}](${relativeFromFile(target, changeRecord)})` : '无'}`,
    `- 依赖记录: ${controlledReferences(projectRoot, target, options['depends-on'], '--depends-on', true)}`,
    `- 证据草稿: ${sourceFiles.length > 0 ? sourceFiles.join(', ') : '无'}`,
    `- 路径摘要: ${pathInfo.summary}`,
    `- 检索词: ${pathInfo.keywords}`,
    `- 归档授权: ${authorization}。`,
    '',
    '#### 一、问题/需求',
    '',
    problemOrGoal,
    '',
    '#### 二、原因分析',
    '',
    factsWithPath,
    '',
    '#### 三、测试结果',
    '',
    result,
    '',
    '#### 四、备注',
    '',
    notes,
  ].join('\n');
}

function checkIntegrity(projectRoot) {
  const errors = [];
  const warnings = [];
  const memoryPath = path.join(projectRoot, 'docs', 'MEMORY.md');
  const agentsPath = resolveAgentsPath(projectRoot);

  if (!existingFile(memoryPath)) {
    errors.push(`受控主记忆缺失：${toProjectPath(projectRoot, memoryPath)}`);
    return { status: 'error', errors, warnings, checked_files: 0 };
  }

  let checkedFilesCount = 1;
  const memoryContent = readText(memoryPath);
  const mainFields = parseMarkerFields(memoryContent, MAIN_INDEX_START, MAIN_INDEX_END);
  if (!mainFields || !mainFields.agents_file) {
    errors.push(`docs/MEMORY.md 缺少对 AGENTS.md 的 agents_file 双向索引标记。`);
  } else {
    const reciprocalAgents = path.resolve(path.dirname(memoryPath), mainFields.agents_file);
    if (!existingFile(reciprocalAgents)) {
      errors.push(`docs/MEMORY.md 引用的 AGENTS.md 不存在：${mainFields.agents_file}`);
    }
  }

  // 检查专题索引链接
  const topics = parseIndexEntries(memoryContent, TOPICS_INDEX_START, TOPICS_INDEX_END);
  for (const topic of topics) {
    const topicFile = path.resolve(path.dirname(memoryPath), topic.href);
    if (!existingFile(topicFile)) {
      errors.push(`主记忆引用的专题文件不存在：${topic.label} -> ${topic.href}`);
    } else {
      checkedFilesCount += 1;
      const topicContent = readText(topicFile);
      // 检查专题内的 change 索引
      const topicChanges = parseIndexEntries(topicContent, CHANGE_INDEX_START, CHANGE_INDEX_END);
      for (const change of topicChanges) {
        const changeFile = path.resolve(path.dirname(topicFile), change.href);
        if (!existingFile(changeFile)) {
          errors.push(`专题 ${topic.label} 引用的变更记录不存在：${change.label} -> ${change.href}`);
        }
      }
    }
  }

  // 检查全局变更索引链接
  const globalChanges = parseIndexEntries(memoryContent, CHANGE_INDEX_START, CHANGE_INDEX_END);
  for (const change of globalChanges) {
    const changeFile = path.resolve(path.dirname(memoryPath), change.href);
    if (!existingFile(changeFile)) {
      errors.push(`主记忆引用的变更记录不存在：${change.label} -> ${change.href}`);
    }
  }

  // 检查 API 索引链接
  const apis = parseIndexEntries(memoryContent, APIS_INDEX_START, APIS_INDEX_END);
  for (const api of apis) {
    const apiFile = path.resolve(path.dirname(memoryPath), api.href);
    if (!existingFile(apiFile)) {
      errors.push(`主记忆引用的 API 契约文件不存在：${api.label} -> ${api.href}`);
    } else {
      checkedFilesCount += 1;
    }
  }

  return {
    status: errors.length === 0 ? 'valid' : 'broken_links',
    errors,
    warnings,
    checked_files: checkedFilesCount,
    topics_count: topics.length,
    changes_count: globalChanges.length,
    apis_count: apis.length,
  };
}

/**
 * 解析并校验确认收据 (Receipt - P0-6 真实授权证明)
 * @param {string} projectRoot 项目根目录
 * @param {string|object} receiptInput 路径、JSON 字符串或对象
 * @param {string} targetPath 归档目标绝对路径
 * @returns {object} 校验通过的 receipt 对象
 */
function verifyReceipt(projectRoot, receiptInput, targetPath) {
  let receipt = null;
  if (typeof receiptInput === 'object' && receiptInput !== null) {
    receipt = receiptInput;
  } else if (typeof receiptInput === 'string') {
    const trimmed = receiptInput.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        receipt = JSON.parse(trimmed);
      } catch (err) {
        fail(`确认收据 (receipt) JSON 解析失败: ${err.message}`);
      }
    } else {
      const resolved = path.resolve(projectRoot, trimmed);
      if (!fs.existsSync(resolved)) {
        fail(`确认收据文件不存在: ${trimmed}`);
      }
      try {
        receipt = JSON.parse(readText(resolved));
      } catch (err) {
        fail(`读取确认收据文件失败: ${err.message}`);
      }
    }
  } else {
    fail('无效的确认收据格式，必须是 JSON 字符串、收据对象或文件路径。');
  }

  if (!receipt || typeof receipt !== 'object') {
    fail('确认收据内容无效，必须为有效 JSON 对象。');
  }

  // 1. 验证过期时间 expires_at
  if (receipt.expires_at) {
    const expiresTime = new Date(receipt.expires_at).getTime();
    if (Number.isNaN(expiresTime)) {
      fail(`确认收据 expires_at 时间格式无效: ${receipt.expires_at}`);
    }
    if (Date.now() > expiresTime) {
      fail(`确认收据已过期 (过期时间: ${receipt.expires_at})`);
    }
  }

  // 2. 验证目标路径 target 处于 receipt.scope 允许范围内
  if (receipt.scope) {
    const projectTargetPath = toProjectPath(projectRoot, targetPath);
    let allowed = false;
    const scopes = Array.isArray(receipt.scope) ? receipt.scope : [receipt.scope];
    for (const scopePattern of scopes) {
      const normScope = String(scopePattern || '').replace(/\\/g, '/');
      const normTarget = projectTargetPath.replace(/\\/g, '/');
      if (normScope === '*' || normScope === 'all' || normScope === normTarget) {
        allowed = true;
        break;
      }
      if (normScope.endsWith('/**')) {
        const prefix = normScope.slice(0, -3);
        if (normTarget.startsWith(prefix)) {
          allowed = true;
          break;
        }
      }
      if (normScope.endsWith('/*')) {
        const prefix = normScope.slice(0, -2);
        if (normTarget.startsWith(prefix) && !normTarget.slice(prefix.length).includes('/')) {
          allowed = true;
          break;
        }
      }
      if (normTarget.startsWith(`${normScope}/`) || normTarget === normScope) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      fail(`归档目标路径 "${projectTargetPath}" 不在确认收据授权范围 (scope: ${JSON.stringify(receipt.scope)}) 内`);
    }
  }

  return receipt;
}

function appendFormalRecord(projectRoot, options) {
  const framework = ensureFramework(projectRoot, options);
  if (!frameworkIsWritable(framework)) {
    return framework;
  }
  const target = resolveFormalTarget(projectRoot, options);

  let confirmationType = null;
  let verifiedReceipt = null;
  if (options.receipt) {
    verifiedReceipt = verifyReceipt(projectRoot, options.receipt, target);
    confirmationType = 'verified_receipt';
  } else if (options.confirmed === true || options.explicit === true) {
    confirmationType = 'legacy_flag';
  } else {
    return {
      status: 'requires_archive_confirmation',
      task: options.task || null,
      hint: '归档操作必须提供有效确认收据 (--receipt <path_or_json>) 或显式确认标志 (--confirmed)。',
    };
  }

  const recordOptions = {
    ...options,
    confirmation_type: confirmationType,
    receipt_id: verifiedReceipt ? (verifiedReceipt.receipt_id || verifiedReceipt.id || null) : null,
  };

  const assessment = valueAssessment(recordOptions);
  if (!assessment.archive) {
    const taskId = recordOptions.task ? safeTaskId(recordOptions.task) : null;
    return { ...assessment, task: taskId };
  }
  const title = normalizeHeading(recordOptions.title, '--title');
  const summary = compactText(recordOptions.summary || recordOptions.text);
  if (!summary) {
    fail('必须提供 --summary（或 --text）。');
  }
  const taskId = recordOptions.task ? safeTaskId(recordOptions.task) : null;
  const sourceFiles = sourceFilesForTask(projectRoot, taskId);
  if (sourceFiles.length === 0) {
    fail(`主任务 ${taskId} 没有受管临时证据，拒绝正式归档。`);
  }
  assertNoSecrets(projectRoot, formalTextFields(recordOptions), sourceFiles);
  const pathInfo = pathMemoryInfo(readTaskPath(projectRoot, taskId));
  const classification = classifyFormalTarget(projectRoot, target);
  let record = sceneRecord(projectRoot, target, recordOptions, title, summary, assessment, sourceFiles, pathInfo, null);
  ensureSafeDirectory(projectRoot, path.dirname(target));
  const current = existingFile(target) ? readText(target) : `# ${path.basename(target, '.md')}\n`;
  const next = appendSceneRecord(current, title, summary, record, recordOptions.replace === true);
  if (next.action === 'duplicate') {
    const indexes = updateIndexes(projectRoot, framework, target, classification, title, summary, null);
    return { status: 'duplicate', confirmation_type: confirmationType, receipt_id: recordOptions.receipt_id, target: toProjectPath(projectRoot, target), task: taskId, assessment: { value: assessment.value, reason: assessment.reason }, path_summary: pathInfo.summary, indexes };
  }
  if (next.action === 'requires_replace_confirmation') {
    return { status: 'requires_replace_confirmation', confirmation_type: confirmationType, receipt_id: recordOptions.receipt_id, target: toProjectPath(projectRoot, target), task: taskId, assessment: { value: assessment.value, reason: assessment.reason }, hint: '同标题场景摘要已变化；核对历史变更后使用 --replace 覆盖，或改用新标题并关联替代记录。' };
  }
  if (next.action === 'replaced') {
    const changeRecord = replacementChangeRecord(projectRoot, recordOptions);
    record = sceneRecord(projectRoot, target, recordOptions, title, summary, assessment, sourceFiles, pathInfo, changeRecord);
    next.content = appendSceneRecord(current, title, summary, record, true).content;
  }
  assertSafeDocsTarget(projectRoot, target, false);
  writeTextAtomic(target, next.content);
  const indexes = updateIndexes(projectRoot, framework, target, classification, title, summary, null);
  return { status: 'archived', action: next.action, confirmation_type: confirmationType, receipt_id: recordOptions.receipt_id, target: toProjectPath(projectRoot, target), task: taskId, assessment: { value: assessment.value, reason: assessment.reason }, path_summary: pathInfo.summary, indexes };
}

module.exports = {
  appendFormalRecord,
  checkIntegrity,
  classifyFormalTarget,
  provisionTopic,
  sceneRecord,
  verifyReceipt,
};
