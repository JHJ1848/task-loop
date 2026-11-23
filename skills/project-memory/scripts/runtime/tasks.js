'use strict';

const { TASK_SCHEMA, LEGACY_TASK_SCHEMA } = require('./constants');
const { fail } = require('./errors');
const {
  fs,
  path,
  readText,
  writeTextAtomic,
  writeJsonAtomic,
  existingFile,
  toProjectPath,
  ensureSafeDirectory,
  assertSafeExistingDirectory,
  assertSafeProjectFile,
  runtimePaths,
} = require('./filesystem');

const MATERIAL_TYPES = new Set(['evidence', 'decisions', 'candidates']);
const PATH_FILE = 'path.json';
const PATH_SCHEMA = 1;
const PATH_STATUSES = new Set(['已证实', '已排除', '待确认', '已实施']);

function safeTaskId(taskId) {
  if (!isSafeTaskId(taskId)) {
    fail('任务标识只能包含字母、数字、点、下划线或连字符。');
  }
  return taskId;
}

function isSafeTaskId(taskId) {
  return typeof taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId);
}

function safeAgentName(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '');
  if (!normalized || normalized.length > 100) {
    fail('智能体(Agent)名称至少包含一个可安全用于文件名的字符。');
  }
  return normalized;
}

function taskDirectory(projectRoot, taskId) {
  return path.join(runtimePaths(projectRoot).temp, safeTaskId(taskId));
}

function taskManifestPath(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), 'task.json');
}

function taskPathFile(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), PATH_FILE);
}

function childMaterialPath(agent, type) {
  return `children/${agent}/${type}.md`;
}

function safeManagedTaskFilename(fileName) {
  if (fileName === 'task.json' || fileName === PATH_FILE) {
    return true;
  }
  if (typeof fileName !== 'string') {
    return false;
  }
  if (/^(?:evidence|decisions|candidates)\.md$/i.test(fileName)) {
    return true;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}-(?:evidence|decisions|candidates)\.md$/i.test(fileName)) {
    return true;
  }
  return /^children\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/(?:evidence|decisions|candidates)\.md$/i.test(fileName);
}

function safeMaterialType(type) {
  if (!MATERIAL_TYPES.has(type)) {
    fail('--type 只能是 evidence、decisions 或 candidates。');
  }
  return type;
}

function normalizeManifest(manifest, taskId) {
  if (!manifest || manifest.kind !== 'project-memory-task' || manifest.task_id !== taskId || !Array.isArray(manifest.managed_files) || !manifest.managed_files.includes('task.json') || manifest.managed_files.length !== new Set(manifest.managed_files).size || !manifest.managed_files.every(safeManagedTaskFilename)) {
    return null;
  }
  if (manifest.schema !== TASK_SCHEMA && manifest.schema !== LEGACY_TASK_SCHEMA) {
    return null;
  }
  if (typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at)) || typeof manifest.updated_at !== 'string' || Number.isNaN(Date.parse(manifest.updated_at))) {
    return null;
  }
  return {
    schema: TASK_SCHEMA,
    kind: 'project-memory-task',
    task_id: taskId,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    last_activity_at: typeof manifest.last_activity_at === 'string' && !Number.isNaN(Date.parse(manifest.last_activity_at)) ? manifest.last_activity_at : manifest.updated_at,
    managed_files: [...manifest.managed_files].sort(),
  };
}

function readTaskManifest(projectRoot, taskId) {
  const manifestPath = taskManifestPath(projectRoot, taskId);
  if (!existingFile(manifestPath)) {
    return null;
  }
  assertSafeProjectFile(projectRoot, manifestPath, true);
  try {
    return normalizeManifest(JSON.parse(readText(manifestPath)), taskId);
  } catch (error) {
    return null;
  }
}

function taskPathForManagedFile(directory, fileName) {
  return path.join(directory, ...fileName.split('/'));
}

function safePathNodeId(value) {
  const nodeId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId)) {
    fail('路径节点标识只能包含字母、数字、点、下划线或连字符。');
  }
  return nodeId;
}

function compactPathText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function safePathSummary(value) {
  const summary = compactPathText(value);
  const length = Array.from(summary).length;
  if (length < 5 || length > 20) {
    fail('路径节点摘要必须为 5-20 个字符。');
  }
  return summary;
}

function safePathStatus(value) {
  if (!PATH_STATUSES.has(value)) {
    fail('--status 只能是 已证实、已排除、待确认 或 已实施。');
  }
  return value;
}

function safePathConclusion(value) {
  const conclusion = compactPathText(value);
  if (Array.from(conclusion).length > 240) {
    fail('路径节点结论不能超过 240 个字符。');
  }
  return conclusion;
}

function normalizePathParent(value) {
  const parent = String(value || '').trim();
  if (!parent || parent === '-' || /^(?:root|none)$/i.test(parent)) {
    return null;
  }
  return safePathNodeId(parent);
}

function isValidPathNode(node) {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(node.id)) {
    return false;
  }
  const summaryLength = Array.from(compactPathText(node.summary)).length;
  if (summaryLength < 5 || summaryLength > 20 || !PATH_STATUSES.has(node.status) || (node.parent !== null && (typeof node.parent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(node.parent))) || !Array.isArray(node.evidence) || node.evidence.length !== new Set(node.evidence).size || !node.evidence.every((fileName) => safeManagedTaskFilename(fileName) && fileName !== 'task.json' && fileName !== PATH_FILE) || typeof node.conclusion !== 'string' || Array.from(compactPathText(node.conclusion)).length > 240) {
    return false;
  }
  return true;
}

function pathGraphIsValid(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length || nodes.some((node) => node.parent !== null && (!ids.has(node.parent) || node.parent === node.id))) {
    return false;
  }
  for (const node of nodes) {
    const visited = new Set([node.id]);
    let parent = node.parent;
    while (parent) {
      if (visited.has(parent)) {
        return false;
      }
      visited.add(parent);
      parent = nodes.find((item) => item.id === parent).parent;
    }
  }
  return true;
}

function normalizePathRecord(record, taskId) {
  if (!record || record.schema !== PATH_SCHEMA || record.kind !== 'project-memory-path' || record.task_id !== taskId || typeof record.created_at !== 'string' || Number.isNaN(Date.parse(record.created_at)) || typeof record.updated_at !== 'string' || Number.isNaN(Date.parse(record.updated_at)) || !Array.isArray(record.nodes) || !record.nodes.every(isValidPathNode) || !pathGraphIsValid(record.nodes)) {
    return null;
  }
  return {
    schema: PATH_SCHEMA,
    kind: 'project-memory-path',
    task_id: taskId,
    created_at: record.created_at,
    updated_at: record.updated_at,
    nodes: record.nodes.map((node) => ({
      id: node.id,
      summary: compactPathText(node.summary),
      parent: node.parent,
      status: node.status,
      evidence: [...node.evidence],
      conclusion: compactPathText(node.conclusion),
    })),
  };
}

function readTaskPath(projectRoot, taskId) {
  const filePath = taskPathFile(projectRoot, taskId);
  if (!existingFile(filePath)) {
    return null;
  }
  assertSafeProjectFile(projectRoot, filePath, true);
  try {
    const record = normalizePathRecord(JSON.parse(readText(filePath)), taskId);
    if (!record) {
      fail(`主任务 ${taskId} 的 path.json 无效，拒绝忽略排查路径。`);
    }
    return record;
  } catch (error) {
    if (error && error.message && error.message.includes('path.json')) {
      throw error;
    }
    fail(`主任务 ${taskId} 的 path.json 无效，拒绝忽略排查路径。`);
  }
}

function parsePathEvidence(value, task) {
  const text = String(value || '').trim();
  if (!text || text === '无' || /^none$/i.test(text)) {
    return [];
  }
  const known = new Set(task.manifest.managed_files);
  const evidence = [...new Set(text.split(',').map((item) => item.trim().replace(/\\/g, '/')).filter(Boolean))];
  for (const fileName of evidence) {
    if (!safeManagedTaskFilename(fileName) || fileName === 'task.json' || fileName === PATH_FILE || !known.has(fileName) || !existingFile(taskPathForManagedFile(task.directory, fileName))) {
      fail(`--evidence 只能引用当前主任务已有的受管证据：${fileName}`);
    }
  }
  return evidence;
}

function assertPathEvidenceStillManaged(task, nodes) {
  const known = new Set(task.manifest.managed_files);
  for (const node of nodes) {
    for (const fileName of node.evidence) {
      if (!known.has(fileName) || !existingFile(taskPathForManagedFile(task.directory, fileName))) {
        fail(`路径节点 ${node.id} 引用了不存在的受管证据：${fileName}`);
      }
    }
  }
}

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function updateTaskPath(projectRoot, options) {
  if (options.agent) {
    fail('path 只能由主任务维护，子智能体(Agent)请使用 draft。');
  }
  const taskId = safeTaskId(options.task);
  if (!options.node) {
    fail('path 必须提供 --node <节点标识>。');
  }
  const nodeId = safePathNodeId(options.node);
  const task = ensureTask(projectRoot, taskId);
  const current = readTaskPath(projectRoot, taskId) || {
    schema: PATH_SCHEMA,
    kind: 'project-memory-path',
    task_id: taskId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: [],
  };
  const index = current.nodes.findIndex((node) => node.id === nodeId);
  const previous = index === -1 ? null : current.nodes[index];
  if (!previous && (!hasOption(options, 'summary') || !hasOption(options, 'status'))) {
    fail('新路径节点必须提供 --summary 和 --status。');
  }
  if (previous && !hasOption(options, 'summary') && !hasOption(options, 'status') && !hasOption(options, 'parent') && !hasOption(options, 'evidence') && !hasOption(options, 'conclusion')) {
    fail('更新路径节点时至少提供一个可更新字段。');
  }
  const node = {
    id: nodeId,
    summary: hasOption(options, 'summary') ? safePathSummary(options.summary) : previous.summary,
    parent: hasOption(options, 'parent') ? normalizePathParent(options.parent) : previous ? previous.parent : null,
    status: hasOption(options, 'status') ? safePathStatus(options.status) : previous.status,
    evidence: hasOption(options, 'evidence') ? parsePathEvidence(options.evidence, task) : previous ? previous.evidence : [],
    conclusion: hasOption(options, 'conclusion') ? safePathConclusion(options.conclusion) : previous ? previous.conclusion : '',
  };
  const nodes = [...current.nodes];
  if (previous) {
    nodes[index] = node;
  } else {
    nodes.push(node);
  }
  if (!nodes.every(isValidPathNode) || !pathGraphIsValid(nodes)) {
    fail('路径节点的父节点不存在、指向自身或形成了循环。');
  }
  assertPathEvidenceStillManaged(task, nodes);
  const next = { ...current, updated_at: new Date().toISOString(), nodes };
  const filePath = taskPathFile(projectRoot, taskId);
  assertSafeProjectFile(projectRoot, filePath, false);
  writeJsonAtomic(filePath, next);
  refreshTaskManifest(projectRoot, taskId);
  return { status: 'path_updated', task: taskId, path: toProjectPath(projectRoot, filePath), node, node_count: nodes.length };
}

function inspectManagedTaskFiles(projectRoot, taskId) {
  const directory = taskDirectory(projectRoot, taskId);
  if (!fs.existsSync(directory)) {
    return { files: [], unknown: [], latest_activity_at: null };
  }
  assertSafeExistingDirectory(projectRoot, directory);
  const files = [];
  const unknown = [];
  let latest = null;
  const noteFile = (fileName, filePath) => {
    if (!existingFile(filePath)) {
      unknown.push(fileName);
      return;
    }
    assertSafeProjectFile(projectRoot, filePath, true);
    files.push(fileName);
    const modified = fs.statSync(filePath).mtime.toISOString();
    if (!latest || Date.parse(modified) > Date.parse(latest)) {
      latest = modified;
    }
  };

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === 'task.json' && entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile() && !entry.isSymbolicLink() && (safeManagedTaskFilename(entry.name) && entry.name !== 'task.json')) {
      noteFile(entry.name, entryPath);
      continue;
    }
    if (entry.name !== 'children' || !entry.isDirectory() || entry.isSymbolicLink()) {
      unknown.push(entry.name);
      continue;
    }
    for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
      const childPath = path.join(entryPath, child.name);
      if (!child.isDirectory() || child.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(child.name)) {
        unknown.push(`children/${child.name}`);
        continue;
      }
      for (const draft of fs.readdirSync(childPath, { withFileTypes: true })) {
        const draftPath = path.join(childPath, draft.name);
        if (!draft.isFile() || draft.isSymbolicLink() || !/^(?:evidence|decisions|candidates)\.md$/i.test(draft.name)) {
          unknown.push(`children/${child.name}/${draft.name}`);
          continue;
        }
        noteFile(childMaterialPath(child.name, draft.name.replace(/\.md$/i, '')), draftPath);
      }
    }
  }
  return { files: files.sort(), unknown: unknown.sort(), latest_activity_at: latest };
}

function writeTaskManifest(projectRoot, taskId, manifest) {
  const manifestPath = taskManifestPath(projectRoot, taskId);
  manifest.updated_at = new Date().toISOString();
  manifest.managed_files = [...new Set(manifest.managed_files)].sort();
  assertSafeProjectFile(projectRoot, manifestPath, false);
  writeJsonAtomic(manifestPath, manifest);
}

function ensureTask(projectRoot, taskId) {
  const paths = runtimePaths(projectRoot);
  ensureSafeDirectory(projectRoot, paths.runtime);
  ensureSafeDirectory(projectRoot, paths.temp);
  const directory = taskDirectory(projectRoot, taskId);
  ensureSafeDirectory(projectRoot, directory);
  const manifestPath = taskManifestPath(projectRoot, taskId);
  const discovered = inspectManagedTaskFiles(projectRoot, taskId);
  if (discovered.unknown.length > 0) {
    fail(`任务 ${taskId} 包含未受管文件：${discovered.unknown.join(', ')}`);
  }
  let manifest = readTaskManifest(projectRoot, taskId);
  if (!manifest) {
    if (existingFile(manifestPath)) {
      fail(`任务 ${taskId} 包含未知或无效的 task.json，拒绝覆盖。`);
    }
    const now = new Date().toISOString();
    manifest = {
      schema: TASK_SCHEMA,
      kind: 'project-memory-task',
      task_id: taskId,
      created_at: now,
      updated_at: now,
      last_activity_at: discovered.latest_activity_at || now,
      managed_files: ['task.json', ...discovered.files],
    };
    writeTaskManifest(projectRoot, taskId, manifest);
    return { directory, manifest };
  }
  manifest.managed_files = ['task.json', ...discovered.files];
  if (discovered.latest_activity_at && Date.parse(discovered.latest_activity_at) > Date.parse(manifest.last_activity_at || '')) {
    manifest.last_activity_at = discovered.latest_activity_at;
  }
  return { directory, manifest };
}

function refreshTaskManifest(projectRoot, taskId) {
  const task = ensureTask(projectRoot, taskId);
  writeTaskManifest(projectRoot, taskId, task.manifest);
  return task;
}

function appendMaterial(projectRoot, target, type, agent, text) {
  if (!text) {
    fail('必须提供 --text。');
  }
  assertSafeProjectFile(projectRoot, target, false);
  const prefix = existingFile(target) ? readText(target) : `# ${type}\n`;
  writeTextAtomic(target, `${prefix}${prefix.endsWith('\n') ? '\n' : '\n\n'}- ${new Date().toISOString()} [${agent}]: ${text}\n`);
}

function appendMainTaskMaterial(projectRoot, options) {
  const taskId = safeTaskId(options.task);
  const type = safeMaterialType(options.type);
  const task = ensureTask(projectRoot, taskId);
  const target = path.join(task.directory, `${type}.md`);
  appendMaterial(projectRoot, target, type, 'main', options.text);
  task.manifest.last_activity_at = new Date().toISOString();
  task.manifest.managed_files = ['task.json', ...inspectManagedTaskFiles(projectRoot, taskId).files];
  writeTaskManifest(projectRoot, taskId, task.manifest);
  return { status: 'recorded', task: taskId, file: toProjectPath(projectRoot, target), agent: 'main', type };
}

function appendChildTaskMaterial(projectRoot, options) {
  const taskId = safeTaskId(options.task);
  const type = safeMaterialType(options.type);
  if (!options.agent) {
    fail('子智能体(Agent)草稿必须提供 --agent <标识>。');
  }
  const agent = safeAgentName(options.agent);
  if (agent === 'main') {
    fail('子智能体(Agent)草稿的 --agent 不能使用 main。');
  }
  const paths = runtimePaths(projectRoot);
  ensureSafeDirectory(projectRoot, paths.runtime);
  ensureSafeDirectory(projectRoot, paths.temp);
  const directory = taskDirectory(projectRoot, taskId);
  const childDirectory = path.join(directory, 'children', agent);
  ensureSafeDirectory(projectRoot, childDirectory);
  const target = path.join(childDirectory, `${type}.md`);
  appendMaterial(projectRoot, target, type, agent, options.text);
  return { status: 'recorded', task: taskId, file: toProjectPath(projectRoot, target), agent, type, manifest: 'pending_main_discovery' };
}

module.exports = {
  safeTaskId,
  isSafeTaskId,
  safeAgentName,
  taskDirectory,
  taskManifestPath,
  taskPathFile,
  taskPathForManagedFile,
  safeManagedTaskFilename,
  readTaskManifest,
  readTaskPath,
  inspectManagedTaskFiles,
  ensureTask,
  refreshTaskManifest,
  appendMainTaskMaterial,
  appendChildTaskMaterial,
  updateTaskPath,
};
