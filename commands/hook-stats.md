# Hook Stats Command

Show hook monitor statistics and recent events.

## Usage

`/hook-stats [days|recent N|slow]`

## Full Stats (default)

Display aggregated hook monitor statistics for the last N days (default: 3).

```bash
/hook-stats                # Last 3 days
/hook-stats 7              # Last 7 days
```

**Script:**
```bash
node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.claude', 'hook-monitor');
const args = (process.argv.slice(1) || []).join(' ').trim().split(/\s+/).filter(Boolean);
const subCmd = args[0] || '';
const subArg = args[1] || '';

// --- helpers ---
function fmtMs(ms) {
  if (ms == null) return '';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function pad(s, n) { return String(s).padEnd(n); }
function padStart(s, n) { return String(s).padStart(n); }

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n + 1);
  return d.toISOString().slice(0, 10);
}

// --- load events ---
function loadEvents(days) {
  if (!fs.existsSync(LOG_DIR)) return [];
  const cutoff = dateNDaysAgo(days);
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('hook-events-') && f.endsWith('.jsonl'))
    .sort();
  const events = [];
  for (const f of files) {
    const dateStr = f.replace('hook-events-', '').replace('.jsonl', '');
    if (dateStr < cutoff) continue;
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  return events;
}

function getLogFileStats() {
  if (!fs.existsSync(LOG_DIR)) return { count: 0, totalSize: 0 };
  const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
  let totalSize = 0;
  for (const f of files) {
    try { totalSize += fs.statSync(path.join(LOG_DIR, f)).size; } catch {}
  }
  return { count: files.length, totalSize };
}

// --- render ---
function renderFull(days) {
  const events = loadEvents(days);
  const stats = getLogFileStats();

  console.log('');
  console.log('\u2550'.repeat(45));
  console.log('  Hook Monitor Stats (last ' + days + ' day' + (days > 1 ? 's' : '') + ')');
  console.log('\u2550'.repeat(45));
  console.log('');
  console.log('  Log dir: ~/.claude/hook-monitor/');
  console.log('  Files: ' + stats.count + ' (' + fmtSize(stats.totalSize) + ' total)');

  if (events.length === 0) {
    console.log('');
    console.log('  No events recorded yet.');
    console.log('  Make sure hook-monitor is configured in hooks.json');
    console.log('');
    return;
  }

  // Events by type
  const byType = {};
  for (const e of events) { byType[e.event] = (byType[e.event] || 0) + 1; }
  const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);

  console.log('');
  console.log('  Events by type:');
  for (const [t, c] of typeEntries) {
    console.log('    ' + pad(t, 16) + padStart(c, 6));
  }

  // Top tools (from PreToolUse + PostToolUse)
  const byTool = {};
  for (const e of events) {
    if (e.tool) { byTool[e.tool] = (byTool[e.tool] || 0) + 1; }
  }
  const toolEntries = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (toolEntries.length > 0) {
    console.log('');
    console.log('  Top tools:');
    for (const [t, c] of toolEntries) {
      console.log('    ' + pad(t, 16) + padStart(c, 6));
    }
  }

  // Slowest (top 5)
  const withDuration = events.filter(e => e.duration_ms > 0).sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5);
  if (withDuration.length > 0) {
    console.log('');
    console.log('  Slowest (top 5):');
    for (const e of withDuration) {
      const ms = padStart(fmtMs(e.duration_ms), 8);
      const tool = pad(e.tool || '', 8);
      const summary = (e.input_summary || '').slice(0, 50);
      console.log('    ' + ms + '  ' + tool + summary);
    }
  }

  // Recent (last 10)
  const recent = events.slice(-10).reverse();
  if (recent.length > 0) {
    console.log('');
    console.log('  Recent (last 10):');
    for (const e of recent) {
      const time = (e.timestamp || '').slice(11, 19);
      const event = pad(e.event || '', 14);
      const tool = e.tool ? pad(e.tool, 8) : pad('', 8);
      const dur = e.duration_ms > 0 ? ' (' + fmtMs(e.duration_ms) + ')' : '';
      const summary = (e.input_summary || '').slice(0, 40);
      console.log('    ' + time + '  ' + event + tool + summary + dur);
    }
  }

  console.log('');
}

function renderRecent(n) {
  const events = loadEvents(30);
  const recent = events.slice(-n).reverse();

  console.log('');
  console.log('\u2550'.repeat(45));
  console.log('  Hook Monitor \u2014 Recent ' + n + ' events');
  console.log('\u2550'.repeat(45));
  console.log('');

  if (recent.length === 0) {
    console.log('  No events recorded yet.');
    console.log('');
    return;
  }

  for (const e of recent) {
    const time = (e.timestamp || '').slice(0, 19).replace('T', ' ');
    const event = pad(e.event || '', 14);
    const tool = e.tool ? pad(e.tool, 8) : pad('', 8);
    const dur = e.duration_ms > 0 ? ' (' + fmtMs(e.duration_ms) + ')' : '';
    const summary = (e.input_summary || '').slice(0, 60);
    console.log('  ' + time + '  ' + event + tool + summary + dur);
  }
  console.log('');
}

function renderSlow(n) {
  const events = loadEvents(30);
  const withDuration = events.filter(e => e.duration_ms > 0).sort((a, b) => b.duration_ms - a.duration_ms).slice(0, n || 10);

  console.log('');
  console.log('\u2550'.repeat(45));
  console.log('  Hook Monitor \u2014 Slowest Operations');
  console.log('\u2550'.repeat(45));
  console.log('');

  if (withDuration.length === 0) {
    console.log('  No duration data recorded yet.');
    console.log('');
    return;
  }

  for (const e of withDuration) {
    const time = (e.timestamp || '').slice(0, 19).replace('T', ' ');
    const ms = padStart(fmtMs(e.duration_ms), 8);
    const tool = pad(e.tool || '', 8);
    const summary = (e.input_summary || '').slice(0, 50);
    console.log('  ' + ms + '  ' + tool + summary);
    console.log('           ' + time);
  }
  console.log('');
}

// --- main ---
if (subCmd === 'recent') {
  renderRecent(parseInt(subArg, 10) || 10);
} else if (subCmd === 'slow') {
  renderSlow(parseInt(subArg, 10) || 10);
} else {
  const days = parseInt(subCmd, 10) || 3;
  renderFull(days);
}
" $ARGUMENTS
```

## Sub-commands

| Usage | Description |
|-------|-------------|
| `/hook-stats` | Full stats (default: last 3 days) |
| `/hook-stats 7` | Specify number of days |
| `/hook-stats recent 20` | Show last N events |
| `/hook-stats slow` | Slowest operations (top 10) |

## Examples

```bash
# Default overview
/hook-stats

# Last 7 days of stats
/hook-stats 7

# Recent 20 events with timestamps
/hook-stats recent 20

# Top 10 slowest operations
/hook-stats slow
```

## Notes

- Log files are stored in `~/.claude/hook-monitor/hook-events-YYYY-MM-DD.jsonl`
- Requires hook-monitor to be configured in hooks.json
- Duration data is only available for PostToolUse events (requires matching PreToolUse)
- Tool counts include both PreToolUse and PostToolUse occurrences
