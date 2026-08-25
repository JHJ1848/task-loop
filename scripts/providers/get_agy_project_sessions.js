#!/usr/bin/env node
/**
 * Antigravity (AGY) Project Session Provider (Node.js)
 * Scans ~/.gemini/antigravity/brain for sessions matching the specified project root.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function scanAgySessions(projectRootStr = '.', customBrainPath = null, inspectActivity = true) {
  const projectRoot = normalizePath(projectRootStr);
  const brainDir = customBrainPath ? path.resolve(customBrainPath) : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  if (!fs.existsSync(brainDir) || !fs.statSync(brainDir).isDirectory()) {
    return [];
  }

  const sessions = [];
  const entries = fs.readdirSync(brainDir);

  for (const entry of entries) {
    const entryPath = path.join(brainDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    const convId = entry;
    let logFile = path.join(entryPath, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(logFile)) {
      logFile = path.join(entryPath, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!fs.existsSync(logFile)) continue;
    }

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
    let title = `Session ${convId}`;
    const userPrompts = [];
    const touchedFiles = new Set();

    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        const lineLower = line.toLowerCase();
        const projectRootEscaped = projectRoot.replace(':', '%3a');

        if (!isMatch && (lineLower.includes(projectRoot) || lineLower.includes(projectRootEscaped))) {
          isMatch = true;
        }

        // Extract user prompts
        if (line.includes('"type":"USER_INPUT"') || line.includes('"type": "USER_INPUT"')) {
          const match = line.match(/"content"\s*:\s*"([^"]+)"/);
          if (match) {
            let rawContent = match[1];
            let clean = rawContent.replace(/<[^>]+>/g, '').replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
            if (clean && !userPrompts.includes(clean)) {
              userPrompts.push(clean.substring(0, 150));
            }
          }
        }

        // Extract touched files
        if (inspectActivity) {
          const fileMatches = line.matchAll(/"(?:AbsolutePath|TargetFile|SearchPath)"\s*:\s*"([^"]+)"/g);
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
      // ignore
    }

    if (isMatch) {
      if (userPrompts.length > 0) {
        title = userPrompts[0];
        if (title.length > 60) {
          title = title.substring(0, 57) + '...';
        }
      }

      const agentsMd = path.join(path.resolve(projectRootStr), 'AGENTS.md');
      const ruleFiles = fs.existsSync(agentsMd) ? [agentsMd.replace(/\\/g, '/')] : [];

      const sessionData = {
        vendor: 'antigravity',
        session_id: convId,
        title: title,
        project_root: projectRoot,
        is_active: true,
        created_at: created,
        last_active_at: lastModified,
        log_path: logFile.replace(/\\/g, '/'),
        rule_files: ruleFiles
      };

      if (inspectActivity) {
        sessionData.recent_prompts = userPrompts.length > 5 ? userPrompts.slice(-5) : userPrompts;
        sessionData.recent_touched_files = Array.from(touchedFiles).sort().slice(0, 15);
      }

      sessions.push(sessionData);
    }
  }

  sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return sessions;
}

function main() {
  const args = process.argv.slice(2);
  const projectRoot = args[0] && !args[0].startsWith('-') ? args[0] : '.';
  const inspect = args.includes('--inspect') || args.includes('-i');

  const sessions = scanAgySessions(projectRoot, null, inspect);
  console.log(JSON.stringify(sessions, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scanAgySessions, normalizePath };
