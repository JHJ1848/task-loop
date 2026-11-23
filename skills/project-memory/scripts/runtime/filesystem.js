'use strict';

const fs = require('fs');
const path = require('path');
const { fail } = require('./errors');
const { withLock } = require('./lock');

function readText(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

function writeTextAtomic(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextWithLock(filePath, content, options = {}) {
  const lockFile = `${filePath}.lock`;
  return withLock(lockFile, () => {
    writeTextAtomic(filePath, content);
  }, options);
}

function writeJsonWithLock(filePath, value, options = {}) {
  writeTextWithLock(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function existingFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(base, candidate) {
  const relativePath = path.relative(path.resolve(base), path.resolve(candidate));
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function toProjectPath(projectRoot, target) {
  return path.relative(projectRoot, target).split(path.sep).join('/');
}

function relativeFromFile(filePath, target) {
  return path.relative(path.dirname(filePath), target).split(path.sep).join('/');
}

function realPath(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function nearestExistingPath(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      fail(`路径没有可用的现存上级目录：${target}`);
    }
    current = parent;
  }
  return current;
}

function assertExistingAncestorInside(projectRoot, target) {
  const rootReal = realPath(projectRoot);
  const ancestor = nearestExistingPath(target);
  const ancestorReal = realPath(ancestor);
  if (!isInside(rootReal, ancestorReal)) {
    fail(`路径通过现有链接解析到了项目外：${target}`);
  }
  return { rootReal, ancestorReal };
}

function ensureSafeDirectory(projectRoot, directory) {
  if (!isInside(projectRoot, directory)) {
    fail(`目录必须位于项目内：${directory}`);
  }
  assertExistingAncestorInside(projectRoot, directory);
  fs.mkdirSync(directory, { recursive: true });
  const rootReal = realPath(projectRoot);
  const directoryReal = realPath(directory);
  if (!isInside(rootReal, directoryReal)) {
    fail(`目录解析到了项目外：${directory}`);
  }
  return directory;
}

function assertSafeExistingDirectory(projectRoot, directory) {
  if (!fs.existsSync(directory)) {
    fail(`所需目录不存在：${directory}`);
  }
  if (!isInside(projectRoot, directory)) {
    fail(`目录必须位于项目内：${directory}`);
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`拒绝使用非常规目录或链接目录：${directory}`);
  }
  assertExistingAncestorInside(projectRoot, directory);
  const rootReal = realPath(projectRoot);
  if (!isInside(rootReal, realPath(directory))) {
    fail(`目录解析到了项目外：${directory}`);
  }
  return directory;
}

function assertSafeProjectFile(projectRoot, filePath, required) {
  if (!isInside(projectRoot, filePath)) {
    fail(`文件必须位于项目内：${filePath}`);
  }
  assertExistingAncestorInside(projectRoot, filePath);
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`拒绝使用非常规文件或链接文件：${filePath}`);
    }
    const rootReal = realPath(projectRoot);
    if (!isInside(rootReal, realPath(filePath))) {
      fail(`文件解析到了项目外：${filePath}`);
    }
  } else if (required) {
    fail(`所需文件不存在：${filePath}`);
  }
  return filePath;
}

function ensureSafeDocsDirectory(projectRoot) {
  const docsPath = path.join(projectRoot, 'docs');
  ensureSafeDirectory(projectRoot, docsPath);
  const rootReal = realPath(projectRoot);
  if (!isInside(rootReal, realPath(docsPath))) {
    fail(`docs/ 解析到了项目外：${docsPath}`);
  }
  return docsPath;
}

function assertSafeDocsTarget(projectRoot, target, required) {
  const docsPath = ensureSafeDocsDirectory(projectRoot);
  if (!isInside(docsPath, target) || path.extname(target).toLowerCase() !== '.md') {
    fail('正式归档目标必须是 docs/ 下的 Markdown 文件；建议使用 docs/memory/<专题>.md 或 docs/memory/<专题>/<功能>.md。');
  }
  assertExistingAncestorInside(projectRoot, target);
  const docsReal = realPath(docsPath);
  const ancestorReal = realPath(nearestExistingPath(target));
  if (!isInside(docsReal, ancestorReal)) {
    fail(`正式归档目标解析到了 docs/ 外：${target}`);
  }
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(docsReal, realPath(target))) {
      fail(`正式归档目标不是 docs/ 内的常规文件：${target}`);
    }
  } else if (required) {
    fail(`正式归档目标不存在：${target}`);
  }
  return target;
}

function resolveProjectRoot(value) {
  if (value) {
    const root = path.resolve(value);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      fail(`项目根目录不存在：${root}`);
    }
    return root;
  }

  const boundaryMarkers = ['AGENTS.md', 'package.json', 'pom.xml', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'plugin.json'];
  let current = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.git')) || boundaryMarkers.some((marker) => existingFile(path.join(current, marker)))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  fail('无法推断项目根目录；请在项目边界执行或传入 --project-root <路径>。');
}

function runtimePaths(projectRoot) {
  const runtime = path.join(projectRoot, '.agents', 'project-memory');
  const temp = path.join(runtime, 'temp');
  return {
    runtime,
    policy: path.join(runtime, 'memory-policy.json'),
    defaultPolicy: path.join(runtime, 'memory-policy.default.json'),
    temp,
    archives: path.join(temp, 'archives'),
    staging: path.join(temp, 'archives', '.staging'),
  };
}

module.exports = {
  fs,
  path,
  readText,
  writeTextAtomic,
  writeJsonAtomic,
  writeTextWithLock,
  writeJsonWithLock,
  existingFile,
  samePath,
  isInside,
  toProjectPath,
  relativeFromFile,
  ensureSafeDirectory,
  assertSafeExistingDirectory,
  assertSafeProjectFile,
  ensureSafeDocsDirectory,
  assertSafeDocsTarget,
  resolveProjectRoot,
  runtimePaths,
};
