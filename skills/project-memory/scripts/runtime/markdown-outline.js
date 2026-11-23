'use strict';

const { path, fs, assertSafeProjectFile, toProjectPath } = require('./filesystem');
const { fail } = require('./errors');

const MAX_HEADING_LEVEL = 6;
const DEFAULT_MAX_LEVEL = 3;

function parseMaxLevel(value) {
  if (value === undefined) {
    return DEFAULT_MAX_LEVEL;
  }
  const level = Number.parseInt(String(value), 10);
  if (!Number.isInteger(level) || level < 1 || level > MAX_HEADING_LEVEL) {
    fail(`outline --depth 必须是 1-${MAX_HEADING_LEVEL} 的整数。`);
  }
  return level;
}

function stripClosingHashes(title) {
  return title.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function hasFrontmatter(lines) {
  return lines.length > 0 && lines[0].trim() === '---';
}

function parseHeadings(content) {
  const lines = content.split(/\r?\n/);
  const headings = [];
  let frontmatter = hasFrontmatter(lines);
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (frontmatter) {
      if (index > 0 && (trimmed === '---' || trimmed === '...')) {
        frontmatter = false;
      }
      continue;
    }

    if (fence) {
      const closing = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (
        closing
        && closing[1][0] === fence.marker
        && closing[1].length >= fence.length
        && /^[ \t]*$/.test(closing[2])
      ) {
        fence = null;
      }
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (!heading) {
      continue;
    }
    const title = stripClosingHashes(heading[2]);
    if (title) {
      headings.push({ level: heading[1].length, title, line: index + 1 });
    }
  }

  return headings;
}

function buildTree(headings, maxLevel) {
  const roots = [];
  const stack = [];
  for (const heading of headings) {
    const node = { ...heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  const trim = (nodes) => nodes
    .filter((node) => node.level <= maxLevel)
    .map((node) => ({
      level: node.level,
      title: node.title,
      line: node.line,
      children: trim(node.children),
    }));
  return trim(roots);
}

function countNodes(nodes) {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function outline(projectRoot, options) {
  if (!options.file) {
    fail('outline 需要 --file <项目内 Markdown 相对路径>。');
  }
  const target = path.resolve(projectRoot, options.file);
  if (path.extname(target).toLowerCase() !== '.md') {
    fail('outline 只读取 Markdown 文件（.md）。');
  }
  assertSafeProjectFile(projectRoot, target, true);
  const maxLevel = parseMaxLevel(options.depth);
  const headings = parseHeadings(fs.readFileSync(target, 'utf8'));
  const tree = buildTree(headings, maxLevel);
  const shownCount = countNodes(tree);
  return {
    status: 'outlined',
    file: toProjectPath(projectRoot, target),
    heading_count: headings.length,
    shown_count: shownCount,
    max_level: maxLevel,
    truncated: shownCount < headings.length,
    outline: tree,
  };
}

module.exports = { outline, parseHeadings, buildTree };
