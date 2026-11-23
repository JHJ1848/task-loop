#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_DIR = 'examples';
const DEFAULT_OUTPUT = 'gotcha-index.json';
const MAX_SUMMARY_LENGTH = 160;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { sourceDir: DEFAULT_SOURCE_DIR, output: DEFAULT_OUTPUT };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-dir' || arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail(`${arg} requires a relative path.`);
      }
      options[arg === '--source-dir' ? 'sourceDir' : 'output'] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/export-gotcha-index.js [--source-dir examples] [--output gotcha-index.json]');
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolveRelativePath(value, label) {
  if (path.isAbsolute(value)) {
    fail(`${label} must be relative to the Skill root.`);
  }
  const resolved = path.resolve(SKILL_ROOT, value);
  if (resolved !== SKILL_ROOT && !resolved.startsWith(`${SKILL_ROOT}${path.sep}`)) {
    fail(`${label} must stay inside the Skill root.`);
  }
  return resolved;
}

function toRelativePosix(absolutePath) {
  return path.relative(SKILL_ROOT, absolutePath).split(path.sep).join('/');
}

function listMarkdownFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(entryPath);
      }
    }
  };
  visit(directory);
  return files;
}

function isScenarioHeading(level, title) {
  return level === 3 || (level === 2 && /^G\d+\s*:/i.test(title));
}

function cleanText(value) {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortenSummary(value) {
  if (!value) {
    return null;
  }
  const characters = Array.from(value);
  return characters.length <= MAX_SUMMARY_LENGTH
    ? value
    : `${characters.slice(0, MAX_SUMMARY_LENGTH - 3).join('')}...`;
}

function parseMetadata(body, relativePath, title) {
  const match = body.match(/<!--\s*gotcha-index\s*:\s*(\{[\s\S]*?\})\s*-->/i);
  if (!match) {
    return {};
  }

  let metadata;
  try {
    metadata = JSON.parse(match[1]);
  } catch (error) {
    fail(`Invalid gotcha-index metadata in ${relativePath} (${title}): ${error.message}`);
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    fail(`gotcha-index metadata in ${relativePath} (${title}) must be an object.`);
  }
  if (metadata.quantity !== undefined && (!Number.isFinite(metadata.quantity) || metadata.quantity < 0)) {
    fail(`quantity in ${relativePath} (${title}) must be a non-negative number.`);
  }
  if (metadata.time !== undefined && metadata.time !== null && typeof metadata.time !== 'string') {
    fail(`time in ${relativePath} (${title}) must be a string or null.`);
  }
  if (metadata.summary !== undefined && metadata.summary !== null && typeof metadata.summary !== 'string') {
    fail(`summary in ${relativePath} (${title}) must be a string or null.`);
  }
  if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== 'string' || !tag.trim()))) {
    fail(`tags in ${relativePath} (${title}) must be an array of non-empty strings.`);
  }
  return metadata;
}

function findSummary(body) {
  const lines = body.split(/\r?\n/);
  const preferredLabels = new Set(['结论与复用规则', '场景', 'summary', 'description']);
  const candidates = [];

  for (const line of lines) {
    const content = line.trim().replace(/^-\s+/, '');
    const match = content.match(/^\*\*([^*:：]+)\s*[:：]\*\*\s*(.+)$/)
      || content.match(/^\*\*([^*]+)\*\*\s*[:：]\s*(.+)$/)
      || content.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (match) {
      const label = cleanText(match[1]).toLowerCase();
      const candidate = cleanText(match[2]);
      if (candidate) {
        if (preferredLabels.has(label)) {
          return candidate;
        }
        candidates.push(candidate);
      }
    }
  }
  return candidates[0] || null;
}

function findTime(body) {
  const match = body.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return match ? match[0] : null;
}

function parseScenarios(filePath) {
  const relativePath = toRelativePosix(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const blocks = [];
  let current = null;

  const finishCurrent = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      if (current && level <= current.level) {
        finishCurrent();
      }
      if (isScenarioHeading(level, title)) {
        current = { level, title, lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    } else if (current) {
      current.lines.push(line);
    }
  }
  finishCurrent();

  return blocks.map((block) => {
    const idMatch = block.title.match(/^(G\d+)\s*:\s*(.+)$/i);
    const id = idMatch ? idMatch[1].toUpperCase() : null;
    const name = cleanText(idMatch ? idMatch[2] : block.title);
    const body = block.lines.join('\n');
    const metadata = parseMetadata(body, relativePath, block.title);

    return {
      id,
      name,
      summary: shortenSummary(metadata.summary ?? findSummary(body)),
      quantity: metadata.quantity ?? null,
      time: metadata.time ?? findTime(body),
      tags: metadata.tags ?? [],
      path: relativePath,
    };
  });
}

function buildIndex(sourcePath, markdownFiles) {
  const documents = [];
  const scenarios = [];

  for (const filePath of markdownFiles) {
    const documentScenarios = parseScenarios(filePath);
    const tags = [...new Set(documentScenarios.flatMap((scenario) => scenario.tags))].sort();
    const times = documentScenarios.map((scenario) => scenario.time).filter(Boolean).sort();
    documents.push({
      path: toRelativePosix(filePath),
      scenario_count: documentScenarios.length,
      time: times[0] || null,
      tags,
    });
    scenarios.push(...documentScenarios);
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator: {
      script: 'scripts/export-gotcha-index.js',
      runtime: 'node >=18',
      command: 'node scripts/export-gotcha-index.js',
    },
    source_directory: toRelativePosix(sourcePath),
    document_count: documents.length,
    scenario_count: scenarios.length,
    documents,
    scenarios,
  };
}

function main() {
  const majorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (majorVersion < 18) {
    fail(`Node.js 18+ is required; current version is ${process.versions.node}.`);
  }

  const options = parseArgs(process.argv.slice(2));
  const sourcePath = resolveRelativePath(options.sourceDir, '--source-dir');
  const outputPath = resolveRelativePath(options.output, '--output');
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    fail(`Source directory does not exist: ${toRelativePosix(sourcePath)}`);
  }

  const index = buildIndex(sourcePath, listMarkdownFiles(sourcePath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`Indexed ${index.scenario_count} Gotchas from ${index.document_count} document(s): ${toRelativePosix(outputPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`export-gotcha-index: ${error.message}`);
  process.exitCode = 1;
}
