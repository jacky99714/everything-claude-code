#!/usr/bin/env node
/**
 * Hook Monitor — log all hook events with timing
 *
 * Usage: node hook-monitor.js <EventType>
 * EventTypes: PreToolUse, PostToolUse, PreCompact, SessionStart, SessionEnd, Stop
 *
 * - PreToolUse: logs event + writes timing file for duration calculation
 * - PostToolUse: logs event + reads timing file to compute duration_ms
 * - Others: logs event only
 *
 * Log format: JSONL at ~/.claude/hook-monitor/hook-events-YYYY-MM-DD.jsonl
 */

const fs = require('fs');
const path = require('path');
const {
  readStdinJson,
  ensureDir,
  appendFile,
  getDateString,
  getSessionIdShort,
  getProjectName,
  getHomeDir,
  getTempDir,
} = require('../lib/utils');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const INPUT_SUMMARY_MAX = 200;

/**
 * Extract a human-readable summary from tool input based on tool type
 */
function extractInputSummary(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';

  switch (toolName) {
    case 'Bash':
      return truncate(toolInput.command || '', INPUT_SUMMARY_MAX);
    case 'Read':
      return toolInput.file_path || '';
    case 'Edit':
    case 'Write':
      return toolInput.file_path || '';
    case 'Grep':
      return [toolInput.pattern, toolInput.path].filter(Boolean).join(' @ ');
    case 'Glob':
      return [toolInput.pattern, toolInput.path].filter(Boolean).join(' @ ');
    case 'Agent':
      return truncate(toolInput.prompt || toolInput.description || '', INPUT_SUMMARY_MAX);
    default: {
      try {
        return truncate(JSON.stringify(toolInput), INPUT_SUMMARY_MAX);
      } catch {
        return '';
      }
    }
  }
}

function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Get the log directory path
 */
function getLogDir() {
  return path.join(getHomeDir(), '.claude', 'hook-monitor');
}

/**
 * Get the archive directory path
 */
function getArchiveDir() {
  return path.join(getLogDir(), 'archive');
}

/**
 * Get the log file path for today
 */
function getLogFilePath() {
  return path.join(getLogDir(), `hook-events-${getDateString()}.jsonl`);
}

/**
 * Build a safe timing file ID from tool_use_id
 */
function safeTimingId(toolUseId) {
  if (!toolUseId || typeof toolUseId !== 'string') return null;
  // Only keep alphanumeric, dash, underscore
  return toolUseId.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Get timing file path for a tool use
 */
function getTimingFilePath(toolUseId) {
  const safeId = safeTimingId(toolUseId);
  if (!safeId) return null;
  return path.join(getTempDir(), `claude-hook-timing-${safeId}`);
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE
 */
function rotateIfNeeded(logFile) {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size >= MAX_LOG_SIZE) {
      const archiveDir = getArchiveDir();
      ensureDir(archiveDir);
      const basename = path.basename(logFile, '.jsonl');
      const archiveName = `${basename}-${Date.now()}.jsonl`;
      fs.renameSync(logFile, path.join(archiveDir, archiveName));
    }
  } catch {
    // File doesn't exist yet or stat failed — nothing to rotate
  }
}

async function main() {
  const eventType = process.argv[2];
  if (!eventType) {
    process.exit(0);
  }

  const input = await readStdinJson({ timeoutMs: 3000 });

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const toolUseId = input.tool_use_id || '';

  const entry = {
    timestamp: new Date().toISOString(),
    event: eventType,
  };

  // Add tool info for tool-related events
  if (toolName) entry.tool = toolName;

  entry.session = getSessionIdShort();
  entry.project = getProjectName() || '';

  // Add input summary for tool events
  if (toolName && Object.keys(toolInput).length > 0) {
    const summary = extractInputSummary(toolName, toolInput);
    if (summary) entry.input_summary = summary;
  }

  if (toolUseId) entry.tool_use_id = toolUseId;

  // PreToolUse: write timing file
  if (eventType === 'PreToolUse' && toolUseId) {
    const timingFile = getTimingFilePath(toolUseId);
    if (timingFile) {
      try {
        fs.writeFileSync(timingFile, String(Date.now()));
      } catch {
        // Non-critical — timing just won't be available
      }
    }
  }

  // PostToolUse: read timing file and calculate duration
  if (eventType === 'PostToolUse' && toolUseId) {
    const timingFile = getTimingFilePath(toolUseId);
    if (timingFile) {
      try {
        const startTime = parseInt(fs.readFileSync(timingFile, 'utf8').trim(), 10);
        if (Number.isFinite(startTime) && startTime > 0) {
          entry.duration_ms = Date.now() - startTime;
        }
        fs.unlinkSync(timingFile);
      } catch {
        // Timing file may not exist (PreToolUse hook didn't run or was async)
      }
    }
  }

  // Write log entry
  const logFile = getLogFilePath();
  rotateIfNeeded(logFile);

  try {
    appendFile(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Logging failure should never block Claude
  }

  process.exit(0);
}

// Export for testing; only auto-run when executed directly
module.exports = { extractInputSummary, getLogDir, getTimingFilePath, safeTimingId };

if (require.main === module) {
  main().catch(() => {
    process.exit(0);
  });
}
