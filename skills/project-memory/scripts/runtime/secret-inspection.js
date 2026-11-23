'use strict';

const { path, readText, assertSafeProjectFile } = require('./filesystem');
const { fail } = require('./errors');

const SECRET_PATTERNS = [
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: '云密钥', pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g },
  { kind: '授权头', pattern: /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/ig, valueIndex: 1 },
  { kind: 'Cookie', pattern: /\b(?:cookie|set-cookie)\s*:\s*([^\r\n]{8,})/ig, valueIndex: 1 },
  { kind: '凭据字段', pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"'`,;]+)/ig, valueIndex: 1 },
  { kind: '带密码地址', pattern: /\bhttps?:\/\/[^\s/:@]+:([^\s/@]+)@/ig, valueIndex: 1 },
];

function isRedacted(value) {
  const normalized = String(value || '').trim().replace(/^["']|["']$/g, '');
  return /^(?:<[^>\r\n]{1,80}>|\[[^\]\r\n]{1,80}\]|\*{3,}|redacted|masked|已脱敏|脱敏|省略)$/i.test(normalized)
    || /^(?:[A-Za-z0-9_-]+=)?(?:<[^>\r\n]{1,80}>|\[[^\]\r\n]{1,80}\]|\*{3,}|redacted|masked|已脱敏|脱敏|省略)$/i.test(normalized)
    || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(normalized);
}

function secretKinds(value) {
  const text = String(value || '');
  const kinds = new Set();
  for (const definition of SECRET_PATTERNS) {
    const pattern = new RegExp(definition.pattern.source, definition.pattern.flags);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = definition.valueIndex === undefined ? match[0] : match[definition.valueIndex];
      if (!isRedacted(candidate)) {
        kinds.add(definition.kind);
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
  }
  return [...kinds];
}

function assertNoSecrets(projectRoot, fields, sourceFiles) {
  const findings = [];
  for (const field of fields) {
    if (!field || !field.value) {
      continue;
    }
    for (const kind of secretKinds(field.value)) {
      findings.push({ source: field.label, kind });
    }
  }
  for (const sourceFile of sourceFiles) {
    const filePath = path.resolve(projectRoot, sourceFile);
    assertSafeProjectFile(projectRoot, filePath, true);
    for (const kind of secretKinds(readText(filePath))) {
      findings.push({ source: sourceFile, kind });
    }
  }
  if (findings.length === 0) {
    return;
  }
  const kinds = [...new Set(findings.map((item) => item.kind))];
  const sources = [...new Set(findings.map((item) => item.source))].slice(0, 6);
  fail(`正式归档检测到疑似凭据（${kinds.join('、')}；来源：${sources.join('、')}）。请人工脱敏后重试。`);
}

module.exports = { assertNoSecrets, secretKinds };
