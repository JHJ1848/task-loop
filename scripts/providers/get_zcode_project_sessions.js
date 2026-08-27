#!/usr/bin/env node
/**
 * ZCode Project Session Provider (Node.js)
 * Reverse-introspects ZCode sessions for a project root.
 *
 * ZCode persistence topology (see references/sdk/zcode.md):
 *   - ~/.zcode/cli/db/db.sqlite               (authoritative registry: session / input_history)
 *   - ~/.zcode/cli/rollout/model-io-sess_*.jsonl (per-session model I/O transcripts)
 *
 * The Node.js provider intentionally scans the rollout JSONL files so it works
 * on any Node 18+ runtime with zero dependencies (Node lacks a stdlib sqlite
 * binding before node:sqlite in v22.5). For richer metadata (titles, parent
 * lineage) prefer the Python twin get_zcode_project_sessions.py, which reads
 * db.sqlite directly via the standard library.
 *
 * Output schema is identical to the AGY/Codex/Claude providers:
 *   { vendor, session_id, title, project_root, is_active, created_at,
 *     last_active_at, log_path, rule_files[, recent_prompts, recent_touched_files] }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function resolveRolloutDir(options) {
  const opts = options || {};
  if (opts.rolloutDir) return path.resolve(opts.rolloutDir);
  if (process.env.ZCODE_ROLLOUT_DIR) return path.resolve(process.env.ZCODE_ROLLOUT_DIR);
  return path.join(os.homedir(), '.zcode', 'cli', 'rollout');
}

/**
 * Extract a likely user prompt from a rollout line containing "role":"user".
 * User message bodies appear as either plain strings or
 * [{ type: "text", text: "..." }] fragments; both reduce to a text payload.
 */
function extractUserPrompts(line) {
  const prompts = [];
  const roleUserRegex = /"role"\s*:\s*"user"[^]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = roleUserRegex.exec(line)) !== null) {
    let clean = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .trim();

    // ZCode host-internal turns wrap their payload as {"title": "..."} —
    // unwrap it, but drop the synthetic title-generation instructions themselves.
    const titleWrap = clean.match(/^\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (/Generate a concise title/i.test(clean)) continue;
    if (titleWrap) {
      clean = titleWrap[1].trim();
      if (!clean) continue;
    }

    if (clean && !prompts.includes(clean)) {
      prompts.push(clean.substring(0, 150));
    }
    if (prompts.length >= 5) break;
  }
  return prompts;
}

function scanZcodeSessions(projectRootStr = '.', options = null, inspectActivity = true) {
  const projectRoot = normalizePath(projectRootStr);
  const projectRootEscaped = projectRoot.replace(':', '%3a');
  const rolloutDir = resolveRolloutDir(options);

  if (!fs.existsSync(rolloutDir) || !fs.statSync(rolloutDir).isDirectory()) {
    return [];
  }

  const sessions = [];
  const entries = fs.readdirSync(rolloutDir);

  for (const entry of entries) {
    // Naming convention: model-io-sess_<uuid>.jsonl
    const entryMatch = entry.match(/sess[_-]?([0-9a-fA-F-]{36})\.jsonl$/i);
    if (!entryMatch) continue;
    const sessionId = `sess_${entryMatch[1]}`;
    const logFile = path.join(rolloutDir, entry);

    let created = '';
    let lastModified = '';
    try {
      const stat = fs.statSync(logFile);
      created = stat.birthtime ? stat.birthtime.toISOString() : stat.ctime.toISOString();
      lastModified = stat.mtime.toISOString();
    } catch (e) {
      // ignore
    }

    let isMatch = false;
    let title = `Session ${sessionId}`;
    const userPrompts = [];
    const touchedFiles = new Set();

    try {
      const content = fs.readFileSync(logFile, 'utf8');

      if (!content.toLowerCase().includes(projectRoot) && !content.includes(projectRootEscaped)) {
        continue;
      }
      isMatch = true;

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;

        if (inspectActivity) {
          const fileMatches = line.matchAll(/"(?:AbsolutePath|TargetFile|SearchPath)"\s*:\s*"([^"]+)"/g);
          for (const fm of fileMatches) {
            const cleanFm = fm[1].replace(/\\\\/g, '/').replace(/\\/g, '/');
            if (cleanFm.toLowerCase().startsWith(projectRoot)) {
              const rel = cleanFm.substring(projectRoot.length).replace(/^\/+/, '');
              if (rel) touchedFiles.add(rel.split('/').slice(0, 4).join('/'));
            } else if (!cleanFm.startsWith('http://') && !cleanFm.startsWith('https://')) {
              touchedFiles.add(path.basename(cleanFm));
            }
          }
        }

        if (
          userPrompts.length < 5 &&
          (line.includes('"role":"user"') || line.includes('"role": "user"'))
        ) {
          for (const p of extractUserPrompts(line)) {
            if (!userPrompts.includes(p)) {
              userPrompts.push(p);
              if (userPrompts.length >= 5) break;
            }
          }
        }
      }
    } catch (e) {
      continue; // unreadable rollout file -> skip quietly
    }

    if (!isMatch) continue;

    if (userPrompts.length > 0) {
      title = userPrompts[0];
      if (title.length > 60) {
        title = title.substring(0, 57) + '...';
      }
    }

    const agentsMd = path.join(path.resolve(projectRootStr), 'AGENTS.md');
    const ruleFiles = fs.existsSync(agentsMd) ? [agentsMd.replace(/\\/g, '/')] : [];

    const sessionData = {
      vendor: 'zcode',
      session_id: sessionId,
      title: title,
      project_root: projectRoot,
      is_active: true,
      created_at: created,
      last_active_at: lastModified,
      log_path: logFile.replace(/\\/g, '/'),
      rule_files: ruleFiles
    };

    if (inspectActivity) {
      sessionData.recent_prompts = userPrompts.slice(-5);
      sessionData.recent_touched_files = Array.from(touchedFiles).sort().slice(0, 15);
    }

    sessions.push(sessionData);
  }

  sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return sessions;
}

function main() {
  const args = process.argv.slice(2);
  const projectRoot = args.find(a => !a.startsWith('-')) || '.';
  const inspect = args.includes('--inspect') || args.includes('-i');

  const rolloutIdx = args.indexOf('--rollout-dir');
  const options = {};
  if (rolloutIdx !== -1 && args[rolloutIdx + 1]) {
    options.rolloutDir = args[rolloutIdx + 1];
  }

  const sessions = scanZcodeSessions(projectRoot, options, inspect);
  console.log(JSON.stringify(sessions, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scanZcodeSessions, normalizePath };
