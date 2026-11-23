'use strict';

const POLICY_VALUES = new Set(['only_once', 'auto', 'manually', 'do_not_get']);
const VALUE_LEVELS = new Set(['high', 'medium', 'low']);
const VALIDITY_VALUES = new Set(['active', 'superseded', 'historical', 'needs-review']);
const TEXT_EXTENSIONS = new Set(['.json', '.log', '.md', '.txt']);
const BOOLEAN_OPTIONS = new Set(['confirm-reset', 'confirmed', 'explicit', 'force', 'json', 'manual', 'replace', 'tree', 'yes', 'check-integrity']);
const TASK_SCHEMA = 2;
const LEGACY_TASK_SCHEMA = 1;
const ARCHIVE_SCHEMA = 2;
const ARCHIVE_GENERATOR = 'project-memory-runtime';
const ARCHIVE_MANIFEST_FILE = 'project-memory-archive.json';

const AGENTS_INDEX_START = '<!-- project-memory:index:start -->';
const AGENTS_INDEX_END = '<!-- project-memory:index:end -->';
const MAIN_INDEX_START = '<!-- project-memory:main-index:start -->';
const MAIN_INDEX_END = '<!-- project-memory:main-index:end -->';
const TOPICS_INDEX_START = '<!-- project-memory:topics:start -->';
const TOPICS_INDEX_END = '<!-- project-memory:topics:end -->';
const CHANGE_INDEX_START = '<!-- project-memory:changes:start -->';
const CHANGE_INDEX_END = '<!-- project-memory:changes:end -->';
const FEATURES_INDEX_START = '<!-- project-memory:features:start -->';
const FEATURES_INDEX_END = '<!-- project-memory:features:end -->';
const APIS_INDEX_START = '<!-- project-memory:apis:start -->';
const APIS_INDEX_END = '<!-- project-memory:apis:end -->';

module.exports = {
  POLICY_VALUES,
  VALUE_LEVELS,
  VALIDITY_VALUES,
  TEXT_EXTENSIONS,
  BOOLEAN_OPTIONS,
  TASK_SCHEMA,
  LEGACY_TASK_SCHEMA,
  ARCHIVE_SCHEMA,
  ARCHIVE_GENERATOR,
  ARCHIVE_MANIFEST_FILE,
  AGENTS_INDEX_START,
  AGENTS_INDEX_END,
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
};
