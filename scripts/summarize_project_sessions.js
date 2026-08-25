#!/usr/bin/env node
/**
 * Summarize Project Sessions & Topic Recommendation Utility (Node.js)
 * Aggregates sessions across Antigravity, Codex, and Claude Code,
 * providing structured Markdown reports, activity analysis, and topic tagging recommendations.
 */

const fs = require('fs');
const path = require('path');
const { findSessions } = require('./find_project_sessions');

function inferSuggestedModule(session) {
  const touched = session.recent_touched_files || [];
  const title = (session.title || '').toLowerCase();
  const prompts = (session.recent_prompts || []).join(' ').toLowerCase();
  const pathStr = touched.join(' ').toLowerCase();

  if (['session', 'provider', 'get_agy', 'get_codex', 'get_claude'].some(k => pathStr.includes(k) || title.includes(k) || prompts.includes(k))) {
    return 'session_control';
  }
  if (['dispatch', 'packet', '123', 'complexity'].some(k => pathStr.includes(k) || title.includes(k) || prompts.includes(k))) {
    return 'dispatch_engine';
  }
  if (['lease', 'lock'].some(k => pathStr.includes(k) || title.includes(k) || prompts.includes(k))) {
    return 'lease_manager';
  }
  if (['reconcile', 'topic', 'registry'].some(k => pathStr.includes(k) || title.includes(k) || prompts.includes(k))) {
    return 'topic_registry';
  }
  if (['test', 'preflight', 'check'].some(k => pathStr.includes(k) || title.includes(k) || prompts.includes(k))) {
    return 'verification_gate';
  }

  for (const f of touched) {
    const parts = f.split('/');
    if (parts.length > 1) return parts[0];
  }

  return 'general';
}

function formatMarkdownTable(sessions, limit = 20, suggestTopics = true) {
  if (!sessions || sessions.length === 0) {
    return '未发现属于当前工程的有效会话记录 (No active or historical sessions discovered).';
  }

  const lines = [
    '| 厂商 (Vendor) | 会话标识 (Session ID) | 最近活跃 (Last Active UTC) | 状态 | 标题 / 意图摘要 | 触达文件数 | 建议专题 (Suggested Topic) |',
    '|---|---|---|---|---|---|---|'
  ];

  for (const s of sessions.slice(0, limit)) {
    const vendor = (s.vendor || 'unknown').toUpperCase();
    const sid = s.session_id || 'unknown';
    const sidDisplay = sid.length > 16 ? `\`${sid.substring(0, 8)}...\`` : `\`${sid}\``;

    const lastActive = s.last_active_at || '';
    let lastActiveClean = '-';
    if (lastActive && lastActive.includes('T')) {
      const parts = lastActive.split('T');
      lastActiveClean = `${parts[0]} ${parts[1].substring(0, 8)}`;
    }

    let status = '已登记 (Registered)';
    if (s.is_active === true) status = '活动 (Active)';
    else if (s.is_active === false) status = '离线 (Idle)';

    let title = (s.title || `Session ${sid}`).replace(/\\/g, ' ').replace(/\|/g, '/').replace(/\n/g, ' ').trim();
    while (title.includes('  ')) title = title.replace('  ', ' ');
    if (title.length > 40) title = title.substring(0, 37) + '...';

    const touchedFiles = s.recent_touched_files || [];
    const touchedCount = String(touchedFiles.length);
    const suggested = suggestTopics ? inferSuggestedModule(s) : '-';

    lines.push(`| ${vendor} | ${sidDisplay} | ${lastActiveClean} | ${status} | ${title} | ${touchedCount} | \`${suggested}\` |`);
  }

  return lines.join('\n');
}

function summarizeProjectSessions({
  projectRoot = '.',
  vendor = 'Auto',
  activeOnly = false,
  limit = 20,
  outputFormat = 'markdown',
  suggestTopics = true
} = {}) {
  let sessions = findSessions(projectRoot, vendor, true);
  if (activeOnly) {
    sessions = sessions.filter(s => s.is_active === true);
  }

  if (outputFormat === 'json') {
    return JSON.stringify(sessions.slice(0, limit), null, 2);
  } else if (outputFormat === 'tsv') {
    const outLines = ['vendor\tsession_id\tlast_active_at\tis_active\ttitle\tsuggested_module'];
    for (const s of sessions.slice(0, limit)) {
      outLines.push(`${s.vendor}\t${s.session_id}\t${s.last_active_at}\t${s.is_active}\t${s.title}\t${inferSuggestedModule(s)}`);
    }
    return outLines.join('\n');
  } else {
    return formatMarkdownTable(sessions, limit, suggestTopics);
  }
}

function main() {
  const args = process.argv.slice(2);
  let projectRoot = '.';
  let vendor = 'Auto';
  let format = 'markdown';
  let activeOnly = false;
  let limit = 20;
  let noSuggest = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) projectRoot = args[++i];
    else if (args[i] === '--vendor' && args[i + 1]) vendor = args[++i];
    else if (args[i] === '--format' && args[i + 1]) format = args[++i];
    else if (args[i] === '--active-only') activeOnly = true;
    else if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--no-suggest') noSuggest = true;
    else if (!args[i].startsWith('-')) projectRoot = args[i];
  }

  const output = summarizeProjectSessions({
    projectRoot,
    vendor,
    activeOnly,
    limit,
    outputFormat: format,
    suggestTopics: !noSuggest
  });

  console.log(output);
}

if (require.main === module) {
  main();
}

module.exports = { summarizeProjectSessions, inferSuggestedModule, formatMarkdownTable };
