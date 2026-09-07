#!/usr/bin/env node
/**
 * Claude Code Project Session Provider (Node.js)
 * Scans ~/.claude/projects/<munged-cwd>/<session-id>.jsonl transcripts for sessions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ACTIVE_WINDOW_SECONDS = 30 * 60;

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function mungeProjectDir(pathStr) {
  return path.resolve(pathStr).replace(/[^A-Za-z0-9-]/g, '-');
}

function parseTranscript(logFile, projectRoot, inspectActivity) {
  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch (e) {
    return null;
  }

  const lastActive = stat.mtime.toISOString();
  const created = stat.birthtime ? stat.birthtime.toISOString() : stat.ctime.toISOString();
  const isActive = (Date.now() - stat.mtimeMs) / 1000 < ACTIVE_WINDOW_SECONDS;

  let title = null;
  const userPrompts = [];
  const touchedFiles = new Set();
  let cwdConfirmed = false;
  let cwdSeen = false;
  let firstTimestamp = null;
  let lineBudget = !inspectActivity ? 200 : Infinity;

  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      if (lineBudget <= 0) break;
      if (lineBudget !== Infinity) lineBudget--;

      if (!firstTimestamp) {
        const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
        if (tsMatch) firstTimestamp = tsMatch[1];
      }

      const cwdMatch = line.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (cwdMatch) {
        cwdSeen = true;
        if (normalizePath(cwdMatch[1]) === projectRoot) {
          cwdConfirmed = true;
        }
      }

      if ((line.includes('"type":"user"') || line.includes('"type": "user"') || line.includes('"type":"queue-operation"') || line.includes('"role":"user"')) && !line.includes('"tool_result"')) {
        const contentMatch = line.match(/"content"\s*:\s*"([^"]+)"/);
        if (contentMatch) {
          const clean = contentMatch[1].replace(/<[^>]+>/g, '').replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
          if (clean && !userPrompts.includes(clean)) {
            userPrompts.push(clean.substring(0, 150));
          }
        }
        const textMatches = line.matchAll(/"text"\s*:\s*"([^"]+)"/g);
        for (const tm of textMatches) {
          const clean = tm[1].replace(/<[^>]+>/g, '').replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
          if (clean && !userPrompts.includes(clean)) {
            userPrompts.push(clean.substring(0, 150));
          }
        }
      }

      if (inspectActivity) {
        const fileMatches = line.matchAll(/"(?:file_path|path|target_file|notebook_path)"\s*:\s*"([^"]+)"/g);
        for (const fm of fileMatches) {
          const cleanFm = fm[1].replace(/\\\\/g, '/').replace(/\\/g, '/');
          if (cleanFm.toLowerCase().startsWith(projectRoot)) {
            const rel = cleanFm.substring(projectRoot.length).replace(/^\/+/, '');
            if (rel) touchedFiles.add(rel);
          } else if (!cleanFm.startsWith('http://') && !cleanFm.startsWith('https://')) {
            touchedFiles.add(path.basename(cleanFm));
          }
        }
      }
    }
  } catch (e) {
    console.error(`[claude-provider] schema mismatch in ${path.basename(logFile)}: unreadable transcript: ${e.message}`);
    return null;
  }

  if (cwdSeen && !cwdConfirmed) return null;

  if (userPrompts.length > 0) {
    title = userPrompts[0];
    if (title.length > 60) title = title.substring(0, 57) + '...';
  }
  if (!title) {
    title = `Session ${path.basename(logFile, '.jsonl')}`;
  }

  const sessionData = {
    vendor: 'claude',
    session_id: path.basename(logFile, '.jsonl'),
    title: title,
    project_root: projectRoot,
    is_active: isActive,
    created_at: firstTimestamp || created,
    last_active_at: lastActive,
    log_path: path.resolve(logFile).replace(/\\/g, '/'),
    rule_files: []
  };

  if (inspectActivity) {
    sessionData.recent_prompts = userPrompts.length > 5 ? userPrompts.slice(-5) : userPrompts;
    sessionData.recent_touched_files = Array.from(touchedFiles).sort().slice(0, 15);
  }

  return sessionData;
}

function scanClaudeSessions(projectRootStr = '.', customClaudeHome = null, inspectActivity = true) {
  const projectRoot = normalizePath(projectRootStr);
  const projectsDir = customClaudeHome ? path.join(path.resolve(customClaudeHome), 'projects') : path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
    return [];
  }

  const munged = mungeProjectDir(projectRootStr);
  const candidates = Array.from(new Set([
    munged,
    munged.charAt(0).toLowerCase() + munged.slice(1),
    munged.charAt(0).toUpperCase() + munged.slice(1)
  ]));

  const sessions = [];
  const seenIds = new Set();

  const claudeMd = path.join(path.resolve(projectRootStr), 'CLAUDE.md');
  const ruleFiles = fs.existsSync(claudeMd) ? [claudeMd.replace(/\\/g, '/')] : [];

  for (const candidate of candidates.sort()) {
    const targetDir = path.join(projectsDir, candidate);
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) continue;

    const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const sessionId = path.basename(f, '.jsonl');
      if (seenIds.has(sessionId)) continue;

      const parsed = parseTranscript(path.join(targetDir, f), projectRoot, inspectActivity);
      if (parsed) {
        seenIds.add(sessionId);
        parsed.rule_files = ruleFiles;
        sessions.push(parsed);
      }
    }
  }

  sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return sessions;
}

function main() {
  const args = process.argv.slice(2);
  const projectRoot = args[0] && !args[0].startsWith('-') ? args[0] : '.';
  const inspect = args.includes('--inspect') || args.includes('-i');

  const sessions = scanClaudeSessions(projectRoot, null, inspect);
  console.log(JSON.stringify(sessions, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scanClaudeSessions, mungeProjectDir, normalizePath };
