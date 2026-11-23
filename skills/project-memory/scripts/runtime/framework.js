'use strict';

const {
  POLICY_VALUES,
  AGENTS_INDEX_START,
  AGENTS_INDEX_END,
  MAIN_INDEX_START,
  MAIN_INDEX_END,
  TOPICS_INDEX_START,
  TOPICS_INDEX_END,
  CHANGE_INDEX_START,
  CHANGE_INDEX_END,
  APIS_INDEX_START,
  APIS_INDEX_END,
} = require('./constants');
const { fail } = require('./errors');
const {
  fs,
  path,
  readText,
  writeTextAtomic,
  writeJsonAtomic,
  existingFile,
  samePath,
  isInside,
  toProjectPath,
  relativeFromFile,
  ensureSafeDirectory,
  assertSafeProjectFile,
  ensureSafeDocsDirectory,
  runtimePaths,
} = require('./filesystem');

function resolveAgentsPath(projectRoot) {
  const dotAgents = path.join(projectRoot, '.agents', 'AGENTS.md');
  if (existingFile(dotAgents)) {
    return dotAgents;
  }
  const rootAgents = path.join(projectRoot, 'AGENTS.md');
  if (existingFile(rootAgents)) {
    return rootAgents;
  }
  return fs.existsSync(path.join(projectRoot, '.agents')) ? dotAgents : rootAgents;
}

function isCompatibilityShim(filePath) {
  if (!existingFile(filePath)) return false;
  try {
    const text = readText(filePath);
    return text.includes('兼容垫片') || text.includes('docs/MEMORY.md');
  } catch {
    return false;
  }
}

function ensurePolicy(projectRoot) {
  const paths = runtimePaths(projectRoot);
  ensureSafeDirectory(projectRoot, paths.runtime);
  const defaultPolicy = { memory_get_mode: 'auto' };
  if (!existingFile(paths.defaultPolicy)) {
    assertSafeProjectFile(projectRoot, paths.defaultPolicy, false);
    writeJsonAtomic(paths.defaultPolicy, defaultPolicy);
  }
  if (!existingFile(paths.policy)) {
    assertSafeProjectFile(projectRoot, paths.policy, false);
    writeJsonAtomic(paths.policy, defaultPolicy);
  }
  return paths;
}

function readPolicy(projectRoot) {
  const paths = ensurePolicy(projectRoot);
  const policy = JSON.parse(readText(paths.policy));
  if (!policy || !POLICY_VALUES.has(policy.memory_get_mode)) {
    fail(`${paths.policy} 中的 memory_get_mode 无效。`);
  }
  return { paths, policy };
}

/**
 * 读取策略而不创建运行态目录或默认文件。用于 get 等只读命令，避免“查询”
 * 意外把未接入项目变成已初始化项目。
 */
function readPolicyReadOnly(projectRoot) {
  const paths = runtimePaths(projectRoot);
  const fallback = { memory_get_mode: 'auto' };
  if (!existingFile(paths.policy)) {
    return { paths, policy: fallback, source: 'default' };
  }
  const policy = JSON.parse(readText(paths.policy));
  if (!policy || !POLICY_VALUES.has(policy.memory_get_mode)) {
    fail(`${paths.policy} 中的 memory_get_mode 无效。`);
  }
  return { paths, policy, source: 'runtime' };
}

function markerBlock(start, end, lines) {
  return `${start}\n${lines.join('\n')}\n${end}`;
}

function markerBody(content, start, end) {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }
  return content.slice(startIndex + start.length, endIndex).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function hasMarkerBlock(content, start, end) {
  return markerBody(content, start, end) !== null;
}

function replaceMarkerBlock(content, start, end, lines) {
  const next = markerBlock(start, end, lines);
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    return `${content.slice(0, startIndex)}${next}${content.slice(endIndex + end.length)}`;
  }
  const suffix = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return `${content}${suffix}${next}\n`;
}

function appendSectionWithMarker(content, heading, start, end, lines) {
  if (hasMarkerBlock(content, start, end)) {
    return content;
  }
  const suffix = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return `${content}${suffix}${heading}\n\n${markerBlock(start, end, lines)}\n`;
}

function parseMarkerFields(content, start, end) {
  const body = markerBody(content, start, end);
  if (body === null) {
    return null;
  }
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (match) {
      fields[match[1]] = match[2];
    }
  }
  return fields;
}

function createAgentsScaffold() {
  return '# 项目智能体(Agent)规则\n\n## 项目记忆\n\n';
}

function createMemoryScaffold(memoryPath, agentsPath) {
  return [
    '# 项目记忆与治理中枢 (docs/MEMORY.md)',
    '',
    '## 记忆双向绑定索引',
    '',
    markerBlock(MAIN_INDEX_START, MAIN_INDEX_END, [
      `agents_file: ${relativeFromFile(memoryPath, agentsPath)}`,
      'topics: memory/',
      'change_records: change/',
      'apis: api/',
    ]),
    '',
    '## 专题索引',
    '',
    markerBlock(TOPICS_INDEX_START, TOPICS_INDEX_END, []),
    '',
    '## 全局变更索引',
    '',
    markerBlock(CHANGE_INDEX_START, CHANGE_INDEX_END, []),
    '',
    '## 接口契约索引',
    '',
    markerBlock(APIS_INDEX_START, APIS_INDEX_END, []),
    '',
  ].join('\n');
}

function ensureMainMemoryStructure(content, memoryPath, agentsPath) {
  let next = replaceMarkerBlock(content, MAIN_INDEX_START, MAIN_INDEX_END, [
    `agents_file: ${relativeFromFile(memoryPath, agentsPath)}`,
    'topics: memory/',
    'change_records: change/',
    'apis: api/',
  ]);
  next = appendSectionWithMarker(next, '## 专题索引', TOPICS_INDEX_START, TOPICS_INDEX_END, []);
  next = appendSectionWithMarker(next, '## 全局变更索引', CHANGE_INDEX_START, CHANGE_INDEX_END, []);
  next = appendSectionWithMarker(next, '## 接口契约索引', APIS_INDEX_START, APIS_INDEX_END, []);
  return next;
}

function controlledAgentsMemory(projectRoot, agentsPath) {
  if (!existingFile(agentsPath)) {
    return { status: 'missing' };
  }
  assertSafeProjectFile(projectRoot, agentsPath, true);
  const fields = parseMarkerFields(readText(agentsPath), AGENTS_INDEX_START, AGENTS_INDEX_END);
  if (!fields || !fields.memory_file) {
    return { status: 'unregistered' };
  }
  const memoryPath = path.resolve(path.dirname(agentsPath), fields.memory_file);
  if (!isInside(projectRoot, memoryPath)) {
    return { status: 'invalid', reason: 'AGENTS.md 的 memory_file 条目解析到了项目外。' };
  }
  return { status: 'registered', memoryPath };
}

function memoryCandidates(projectRoot, agentsPath) {
  const candidates = [];
  const registered = controlledAgentsMemory(projectRoot, agentsPath);
  if (registered.status === 'registered' && existingFile(registered.memoryPath)) {
    candidates.push({ path: registered.memoryPath, source: 'agents_index' });
  }
  const docsMemory = path.join(projectRoot, 'docs', 'MEMORY.md');
  const rootMemory = path.join(projectRoot, 'MEMORY.md');
  if (existingFile(docsMemory)) {
    candidates.push({ path: docsMemory, source: 'docs_memory' });
  }
  if (existingFile(rootMemory) && !isCompatibilityShim(rootMemory)) {
    candidates.push({ path: rootMemory, source: 'root_memory' });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = process.platform === 'win32' ? path.resolve(candidate.path).toLowerCase() : path.resolve(candidate.path);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function inspectFramework(projectRoot) {
  const agentsPath = resolveAgentsPath(projectRoot);
  const registered = controlledAgentsMemory(projectRoot, agentsPath);
  if (registered.status === 'invalid') {
    return { status: 'invalid_framework', agents: agentsPath, reason: registered.reason };
  }
  if (registered.status === 'registered') {
    const docsMemory = path.join(projectRoot, 'docs', 'MEMORY.md');
    const rootMemory = path.join(projectRoot, 'MEMORY.md');
    if (existingFile(registered.memoryPath) && existingFile(docsMemory) && !samePath(registered.memoryPath, docsMemory)) {
      if (!isCompatibilityShim(registered.memoryPath)) {
        return {
          status: 'memory_candidate_conflict',
          agents: agentsPath,
          memory: registered.memoryPath,
          candidates: [
            { path: toProjectPath(projectRoot, registered.memoryPath), source: 'agents_index' },
            { path: toProjectPath(projectRoot, docsMemory), source: 'docs_memory' },
          ],
          reason: 'AGENTS.md 显式索引的 MEMORY.md 与 docs/MEMORY.md 不同且均存在；请显式解决冲突。',
        };
      }
    }
    if (!existingFile(registered.memoryPath)) {
      return { status: 'invalid_framework', agents: agentsPath, memory: registered.memoryPath, reason: 'AGENTS.md 索引指向的 MEMORY.md 不存在。' };
    }
    assertSafeProjectFile(projectRoot, registered.memoryPath, true);
    const memoryContent = readText(registered.memoryPath);
    const memoryFields = parseMarkerFields(memoryContent, MAIN_INDEX_START, MAIN_INDEX_END);
    if (!memoryFields) {
      return { status: 'requires_memory_mode', agents: agentsPath, memory: registered.memoryPath, candidates: [{ path: toProjectPath(projectRoot, registered.memoryPath), source: 'agents_index' }], modes: ['migrate', 'keep', 'reset'] };
    }
    if (memoryFields.agents_file) {
      const reciprocal = path.resolve(path.dirname(registered.memoryPath), memoryFields.agents_file);
      if (samePath(reciprocal, agentsPath)) {
        return { status: 'ready', agents: agentsPath, memory: registered.memoryPath };
      }
      return { status: 'invalid_framework', agents: agentsPath, memory: registered.memoryPath, reason: 'AGENTS.md 与 MEMORY.md 的双向索引指向不同位置；请停止并显式解决冲突。' };
    }
    return { status: 'incomplete_links', agents: agentsPath, memory: registered.memoryPath, reason: '已登记的 MEMORY.md 缺少指向 AGENTS.md 的双向索引条目。' };
  }

  const candidates = memoryCandidates(projectRoot, agentsPath);
  if (candidates.length > 0) {
    const preferred = candidates.find((candidate) => candidate.source === 'docs_memory') || candidates[0];
    try {
      assertSafeProjectFile(projectRoot, preferred.path, true);
      const memoryFields = parseMarkerFields(readText(preferred.path), MAIN_INDEX_START, MAIN_INDEX_END);
      if (memoryFields && memoryFields.agents_file) {
        const reciprocal = path.resolve(path.dirname(preferred.path), memoryFields.agents_file);
        if (samePath(reciprocal, agentsPath)) {
          return { status: 'incomplete_links', agents: agentsPath, memory: preferred.path, reason: '受管 MEMORY.md 已存在，但 AGENTS.md 缺少其双向索引条目。' };
        }
      }
    } catch (error) {
      return { status: 'invalid_framework', agents: agentsPath, memory: preferred.path, reason: error.message };
    }
    return { status: 'requires_memory_mode', agents: agentsPath, memory: preferred.path, candidates: candidates.map((candidate) => ({ ...candidate, path: toProjectPath(projectRoot, candidate.path) })), modes: ['migrate', 'keep', 'reset'] };
  }
  return { status: 'needs_initialization', agents: agentsPath, memory: path.join(projectRoot, 'docs', 'MEMORY.md') };
}

function backup(projectRoot, filePath) {
  assertSafeProjectFile(projectRoot, filePath, true);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak.${stamp}`;
  assertSafeProjectFile(projectRoot, backupPath, false);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function registerBidirectional(projectRoot, agentsPath, memoryPath) {
  const agentsDirectory = path.dirname(agentsPath);
  ensureSafeDirectory(projectRoot, agentsDirectory);
  assertSafeProjectFile(projectRoot, memoryPath, true);

  const agentsContent = existingFile(agentsPath) ? readText(agentsPath) : createAgentsScaffold();
  const memoryContent = ensureMainMemoryStructure(readText(memoryPath), memoryPath, agentsPath);
  const nextAgents = replaceMarkerBlock(agentsContent, AGENTS_INDEX_START, AGENTS_INDEX_END, [
    `memory_file: ${relativeFromFile(agentsPath, memoryPath)}`,
    'memory_runtime: project-memory/',
  ]);

  assertSafeProjectFile(projectRoot, memoryPath, true);
  writeTextAtomic(memoryPath, memoryContent);
  assertSafeProjectFile(projectRoot, agentsPath, false);
  writeTextAtomic(agentsPath, nextAgents);
}

function initialize(projectRoot, options) {
  const framework = inspectFramework(projectRoot);
  const runtime = () => toProjectPath(projectRoot, runtimePaths(projectRoot).runtime);
  if (framework.status === 'invalid_framework' || framework.status === 'memory_candidate_conflict') {
    return framework;
  }
  if (framework.status === 'requires_memory_mode') {
    if (!options.mode) {
      return { ...framework, memory: toProjectPath(projectRoot, framework.memory), runtime: runtime() };
    }
    if (!['migrate', 'keep', 'reset'].includes(options.mode)) {
      fail(`不支持的初始化模式：${options.mode}。`);
    }
    if (options.mode === 'reset' && !options['confirm-reset']) {
      return { status: 'requires_reset_confirmation', memory: toProjectPath(projectRoot, framework.memory) };
    }
  }
  const paths = ensurePolicy(projectRoot);
  if (framework.status === 'ready') {
    return { status: 'already_initialized', memory: toProjectPath(projectRoot, framework.memory), runtime: toProjectPath(projectRoot, paths.runtime) };
  }
  if (framework.status === 'incomplete_links') {
    registerBidirectional(projectRoot, framework.agents, framework.memory);
    return { status: 'repaired_links', memory: toProjectPath(projectRoot, framework.memory), runtime: toProjectPath(projectRoot, paths.runtime) };
  }
  if (framework.status === 'needs_initialization') {
    const docsPath = ensureSafeDocsDirectory(projectRoot);
    ensureSafeDirectory(projectRoot, path.join(docsPath, 'memory'));
    ensureSafeDirectory(projectRoot, path.join(docsPath, 'change'));
    ensureSafeDirectory(projectRoot, path.join(docsPath, 'api'));
    const memoryPath = framework.memory;
    assertSafeProjectFile(projectRoot, memoryPath, false);
    writeTextAtomic(memoryPath, createMemoryScaffold(memoryPath, framework.agents));
    registerBidirectional(projectRoot, framework.agents, memoryPath);
    return { status: 'initialized', memory: toProjectPath(projectRoot, memoryPath), runtime: toProjectPath(projectRoot, paths.runtime) };
  }
  if (options.mode === 'keep') {
    return { status: 'kept_legacy_memory', memory: toProjectPath(projectRoot, framework.memory), runtime: toProjectPath(projectRoot, paths.runtime), note: '旧 MEMORY.md 保持不变。本次允许读取；正式索引归档前请先执行 migrate。' };
  }
  const docsPath = ensureSafeDocsDirectory(projectRoot);
  ensureSafeDirectory(projectRoot, path.join(docsPath, 'memory'));
  ensureSafeDirectory(projectRoot, path.join(docsPath, 'change'));
  ensureSafeDirectory(projectRoot, path.join(docsPath, 'api'));
  if (options.mode === 'migrate') {
    const backupPath = backup(projectRoot, framework.memory);
    registerBidirectional(projectRoot, framework.agents, framework.memory);
    return { status: 'initialized', memory: toProjectPath(projectRoot, framework.memory), backup: toProjectPath(projectRoot, backupPath), runtime: toProjectPath(projectRoot, paths.runtime) };
  }
  const backupPath = backup(projectRoot, framework.memory);
  assertSafeProjectFile(projectRoot, framework.memory, true);
  fs.unlinkSync(framework.memory);
  const targetMemory = path.join(projectRoot, 'docs', 'MEMORY.md');
  assertSafeProjectFile(projectRoot, targetMemory, false);
  writeTextAtomic(targetMemory, createMemoryScaffold(targetMemory, framework.agents));
  registerBidirectional(projectRoot, framework.agents, targetMemory);
  return { status: 'initialized', memory: toProjectPath(projectRoot, targetMemory), backup: toProjectPath(projectRoot, backupPath), runtime: toProjectPath(projectRoot, paths.runtime) };
}

function ensureFramework(projectRoot, options) {
  const framework = inspectFramework(projectRoot);
  return framework.status === 'ready' ? framework : initialize(projectRoot, options);
}

function frameworkIsReadable(framework) {
  return ['ready', 'initialized', 'already_initialized', 'repaired_links', 'kept_legacy_memory'].includes(framework.status);
}

function frameworkIsWritable(framework) {
  return ['ready', 'initialized', 'already_initialized', 'repaired_links'].includes(framework.status);
}

module.exports = {
  resolveAgentsPath,
  isCompatibilityShim,
  ensurePolicy,
  readPolicy,
  readPolicyReadOnly,
  markerBlock,
  markerBody,
  replaceMarkerBlock,
  parseMarkerFields,
  createMemoryScaffold,
  ensureMainMemoryStructure,
  inspectFramework,
  initialize,
  ensureFramework,
  frameworkIsReadable,
  frameworkIsWritable,
};
