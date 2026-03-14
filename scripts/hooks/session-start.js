#!/usr/bin/env node
/**
 * SessionStart Hook - Load previous context on new session
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs when a new Claude session starts. Loads the most recent session
 * summary into Claude's context via stdout, and reports available
 * sessions and learned skills.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSessionsDir, getLearnedSkillsDir, findFiles, ensureDir, readFile, runCommand, isGitRepo, log, output } = require('../lib/utils');
const { getPackageManager, getSelectionPrompt } = require('../lib/package-manager');
const { listAliases } = require('../lib/session-aliases');
const { detectProjectType } = require('../lib/project-detect');

/**
 * Load v2 instincts (project-scoped + global) and inject into context.
 * Only loads instincts with confidence >= 0.7 to keep context lean.
 * Uses the same project hash algorithm as detect-project.sh.
 */
function loadInstincts() {
  const homunculusDir = path.join(os.homedir(), '.claude', 'homunculus');
  const MIN_CONFIDENCE = 0.7;
  const MAX_INSTINCTS = 15;

  // Detect project hash (same algorithm as detect-project.sh)
  let projectId = null;
  if (isGitRepo()) {
    const remote = runCommand('git remote get-url origin');
    const repoRoot = runCommand('git rev-parse --show-toplevel');
    const hashInput = remote.success ? remote.output : repoRoot.success ? repoRoot.output : null;
    if (hashInput) {
      projectId = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 12);
    }
  }

  // Collect instinct directories: project-scoped first, then global
  const instinctDirs = [];
  if (projectId) {
    instinctDirs.push(path.join(homunculusDir, 'projects', projectId, 'instincts', 'personal'));
  }
  instinctDirs.push(path.join(homunculusDir, 'instincts', 'personal'));

  const instincts = [];
  for (const dir of instinctDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.yaml'));
      for (const file of files) {
        const content = readFile(path.join(dir, file));
        if (!content) continue;

        // Parse YAML frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const confidence = parseFloat((fm.match(/confidence:\s*([\d.]+)/) || [])[1]) || 0;
        if (confidence < MIN_CONFIDENCE) continue;

        const trigger = (fm.match(/trigger:\s*["']?(.+?)["']?\s*$/m) || [])[1] || '';
        const domain = (fm.match(/domain:\s*["']?(.+?)["']?\s*$/m) || [])[1] || '';

        // Extract action from ## Action section
        const actionMatch = content.match(/## Action\n([\s\S]*?)(?=\n## |$)/);
        const action = actionMatch ? actionMatch[1].trim().split('\n')[0] : '';

        instincts.push({ confidence, trigger, domain, action });
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  if (instincts.length === 0) return;

  // Sort by confidence desc, take top N
  instincts.sort((a, b) => b.confidence - a.confidence);
  const top = instincts.slice(0, MAX_INSTINCTS);

  const lines = top.map(i => `- [${i.confidence}] ${i.trigger} → ${i.action}`);
  output(`Learned instincts for this project (${top.length}/${instincts.length}):\n${lines.join('\n')}`);
  log(`[SessionStart] Loaded ${top.length} instincts (${instincts.length} total, min confidence ${MIN_CONFIDENCE})`);
}

async function main() {
  const sessionsDir = getSessionsDir();
  const learnedDir = getLearnedSkillsDir();

  // Ensure directories exist
  ensureDir(sessionsDir);
  ensureDir(learnedDir);

  // Check for recent session files (last 7 days)
  const recentSessions = findFiles(sessionsDir, '*-session.tmp', { maxAge: 7 });

  if (recentSessions.length > 0) {
    const latest = recentSessions[0];
    log(`[SessionStart] Found ${recentSessions.length} recent session(s)`);
    log(`[SessionStart] Latest: ${latest.path}`);

    // Read and inject only the structured summary (between ECC markers)
    const content = readFile(latest.path);
    if (content && !content.includes('[Session context goes here]')) {
      const summaryMatch = content.match(/<!-- ECC:SUMMARY:START -->\n([\s\S]*?)\n<!-- ECC:SUMMARY:END -->/);
      if (summaryMatch) {
        // Extract only Tasks and Files Modified sections, skip raw user messages
        const summary = summaryMatch[1];
        const sections = [];
        const filesMatch = summary.match(/### Files Modified\n([\s\S]*?)(?=\n### |$)/);
        const toolsMatch = summary.match(/### Tools Used\n([\s\S]*?)(?=\n### |$)/);
        const statsMatch = summary.match(/### Stats\n([\s\S]*?)(?=\n### |$)/);
        if (filesMatch) sections.push(`### Files Modified\n${filesMatch[1].trim()}`);
        if (toolsMatch) sections.push(`### Tools Used\n${toolsMatch[1].trim()}`);
        if (statsMatch) sections.push(`### Stats\n${statsMatch[1].trim()}`);
        if (sections.length > 0) {
          output(`Previous session:\n${sections.join('\n')}`);
        }
      }
    }
  }

  // Check for learned skills
  const learnedSkills = findFiles(learnedDir, '*.md');

  if (learnedSkills.length > 0) {
    log(`[SessionStart] ${learnedSkills.length} learned skill(s) available in ${learnedDir}`);
  }

  // Check for available session aliases
  const aliases = listAliases({ limit: 5 });

  if (aliases.length > 0) {
    const aliasNames = aliases.map(a => a.name).join(', ');
    log(`[SessionStart] ${aliases.length} session alias(es) available: ${aliasNames}`);
    log(`[SessionStart] Use /sessions load <alias> to continue a previous session`);
  }

  // Detect and report package manager
  const pm = getPackageManager();
  log(`[SessionStart] Package manager: ${pm.name} (${pm.source})`);

  // If no explicit package manager config was found, show selection prompt
  if (pm.source === 'default') {
    log('[SessionStart] No package manager preference found.');
    log(getSelectionPrompt());
  }

  // Detect project type and frameworks (#293)
  const projectInfo = detectProjectType();
  if (projectInfo.languages.length > 0 || projectInfo.frameworks.length > 0) {
    const parts = [];
    if (projectInfo.languages.length > 0) {
      parts.push(`languages: ${projectInfo.languages.join(', ')}`);
    }
    if (projectInfo.frameworks.length > 0) {
      parts.push(`frameworks: ${projectInfo.frameworks.join(', ')}`);
    }
    log(`[SessionStart] Project detected — ${parts.join('; ')}`);
    output(`Project type: ${JSON.stringify(projectInfo)}`);
  } else {
    log('[SessionStart] No specific project type detected');
  }

  // Load v2 instincts (project-scoped + global) into context
  loadInstincts();

  process.exit(0);
}

main().catch(err => {
  console.error('[SessionStart] Error:', err.message);
  process.exit(0); // Don't block on errors
});
