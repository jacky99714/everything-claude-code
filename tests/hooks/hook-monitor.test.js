/**
 * Tests for scripts/hooks/hook-monitor.js
 *
 * Run with: node tests/hooks/hook-monitor.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const monitorScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'hook-monitor.js');

// Test helpers
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

/**
 * Run hook-monitor.js with a given event type and stdin input.
 */
function runMonitor(eventType, stdinInput = '{}', envOverrides = {}) {
  const args = eventType ? [monitorScript, eventType] : [monitorScript];
  const result = spawnSync('node', args, {
    encoding: 'utf8',
    input: stdinInput,
    timeout: 10000,
    env: { ...process.env, ...envOverrides },
  });
  return {
    code: result.status || 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Parse the last JSONL line from a log file.
 */
function readLastLogEntry(logFile) {
  const content = fs.readFileSync(logFile, 'utf8').trim();
  const lines = content.split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Read all JSONL entries from a log file.
 */
function readAllLogEntries(logFile) {
  const content = fs.readFileSync(logFile, 'utf8').trim();
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function runTests() {
  console.log('\n=== Testing hook-monitor.js ===\n');

  let passed = 0;
  let failed = 0;

  // Use a unique test log directory
  const testLogDir = path.join(os.tmpdir(), `hook-monitor-test-${Date.now()}`);
  const testSession = `test-monitor-${Date.now()}`;

  // Monkey-patch: override HOME so logs go to our test dir
  // The script uses getHomeDir() which returns os.homedir(), but we can
  // override via a custom env var check. Since hook-monitor.js uses
  // getHomeDir() from utils, and that returns os.homedir(), we need
  // to override HOME (Unix) or USERPROFILE (Windows).
  const homeOverride = path.join(os.tmpdir(), `hook-monitor-home-${Date.now()}`);
  fs.mkdirSync(homeOverride, { recursive: true });
  const envBase = {
    CLAUDE_SESSION_ID: testSession,
    HOME: homeOverride,
    USERPROFILE: homeOverride,
  };

  function getTestLogDir() {
    return path.join(homeOverride, '.claude', 'hook-monitor');
  }

  function getTestLogFile() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return path.join(getTestLogDir(), `hook-events-${y}-${m}-${d}.jsonl`);
  }

  function cleanup() {
    try {
      fs.rmSync(homeOverride, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // --- Exit codes ---
  console.log('Exit codes:');

  if (test('exits 0 for PreToolUse', () => {
    const result = runMonitor('PreToolUse', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 for PostToolUse', () => {
    const result = runMonitor('PostToolUse', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 for PreCompact', () => {
    const result = runMonitor('PreCompact', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 for SessionStart', () => {
    const result = runMonitor('SessionStart', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 for SessionEnd', () => {
    const result = runMonitor('SessionEnd', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 for Stop', () => {
    const result = runMonitor('Stop', '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  // --- Error resilience ---
  console.log('\nError resilience:');

  cleanup();

  if (test('exits 0 with no event type argument', () => {
    const result = runMonitor(null, '{}', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 with empty stdin', () => {
    const result = runMonitor('PreToolUse', '', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('exits 0 with invalid JSON stdin', () => {
    const result = runMonitor('PreToolUse', 'not-json{{{', envBase);
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  // --- Log file creation ---
  console.log('\nLog file creation:');

  cleanup();

  if (test('creates log directory and writes valid JSONL', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_use_id: 'tu_test1',
    });
    runMonitor('PreToolUse', input, envBase);
    const logFile = getTestLogFile();
    assert.ok(fs.existsSync(logFile), 'Log file should exist');
    const entry = readLastLogEntry(logFile);
    assert.strictEqual(entry.event, 'PreToolUse');
    assert.strictEqual(entry.tool, 'Bash');
    assert.ok(entry.timestamp, 'Should have timestamp');
    assert.ok(entry.session, 'Should have session');
  })) passed++; else failed++;

  if (test('appends multiple entries to the same log file', () => {
    runMonitor('SessionStart', '{}', envBase);
    runMonitor('PreToolUse', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' } }), envBase);
    const logFile = getTestLogFile();
    const entries = readAllLogEntries(logFile);
    // At least 3 entries (1 from previous test + 2 from this test)
    assert.ok(entries.length >= 3, `Should have at least 3 entries, got ${entries.length}`);
  })) passed++; else failed++;

  // --- Input summary extraction ---
  console.log('\nInput summary extraction:');

  cleanup();

  if (test('extracts command for Bash tool', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_use_id: 'tu_bash1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, 'npm run build');
  })) passed++; else failed++;

  if (test('extracts file_path for Edit tool', () => {
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/index.ts', old_string: 'a', new_string: 'b' },
      tool_use_id: 'tu_edit1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, '/src/index.ts');
  })) passed++; else failed++;

  if (test('extracts file_path for Read tool', () => {
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/src/app.js' },
      tool_use_id: 'tu_read1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, '/src/app.js');
  })) passed++; else failed++;

  if (test('extracts file_path for Write tool', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/src/new.js', content: 'hello' },
      tool_use_id: 'tu_write1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, '/src/new.js');
  })) passed++; else failed++;

  if (test('extracts pattern + path for Grep tool', () => {
    const input = JSON.stringify({
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO', path: '/src' },
      tool_use_id: 'tu_grep1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, 'TODO @ /src');
  })) passed++; else failed++;

  if (test('extracts pattern + path for Glob tool', () => {
    const input = JSON.stringify({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts', path: '/src' },
      tool_use_id: 'tu_glob1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.input_summary, '**/*.ts @ /src');
  })) passed++; else failed++;

  if (test('truncates long Bash commands at 200 chars', () => {
    const longCmd = 'x'.repeat(300);
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: longCmd },
      tool_use_id: 'tu_long1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.ok(entry.input_summary.length <= 203, 'Should be truncated (200 + "...")');
    assert.ok(entry.input_summary.endsWith('...'), 'Should end with "..."');
  })) passed++; else failed++;

  if (test('JSON-serializes unknown tool input', () => {
    const input = JSON.stringify({
      tool_name: 'CustomTool',
      tool_input: { foo: 'bar', baz: 42 },
      tool_use_id: 'tu_custom1',
    });
    runMonitor('PreToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.ok(entry.input_summary.includes('foo'), 'Should contain JSON key');
    assert.ok(entry.input_summary.includes('bar'), 'Should contain JSON value');
  })) passed++; else failed++;

  // --- Timing: PreToolUse creates timing file ---
  console.log('\nTiming files:');

  cleanup();

  if (test('PreToolUse creates timing file in /tmp', () => {
    const toolUseId = `tu_timing_${Date.now()}`;
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'sleep 0' },
      tool_use_id: toolUseId,
    });
    runMonitor('PreToolUse', input, envBase);
    const safeId = toolUseId.replace(/[^a-zA-Z0-9_-]/g, '');
    const timingFile = path.join(os.tmpdir(), `claude-hook-timing-${safeId}`);
    assert.ok(fs.existsSync(timingFile), 'Timing file should exist');
    const startTime = parseInt(fs.readFileSync(timingFile, 'utf8').trim(), 10);
    assert.ok(Number.isFinite(startTime) && startTime > 0, 'Should contain valid timestamp');
    // Cleanup
    try { fs.unlinkSync(timingFile); } catch { /* ignore */ }
  })) passed++; else failed++;

  if (test('PostToolUse reads timing file, adds duration_ms, and deletes it', () => {
    const toolUseId = `tu_duration_${Date.now()}`;
    const safeId = toolUseId.replace(/[^a-zA-Z0-9_-]/g, '');
    const timingFile = path.join(os.tmpdir(), `claude-hook-timing-${safeId}`);

    // Write a timing file that simulates PreToolUse 500ms ago
    fs.writeFileSync(timingFile, String(Date.now() - 500));

    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo done' },
      tool_use_id: toolUseId,
    });
    runMonitor('PostToolUse', input, envBase);

    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'PostToolUse');
    assert.ok(typeof entry.duration_ms === 'number', 'Should have duration_ms');
    assert.ok(entry.duration_ms >= 400, `Duration should be >= 400ms, got ${entry.duration_ms}`);
    assert.ok(entry.duration_ms < 5000, `Duration should be < 5000ms, got ${entry.duration_ms}`);
    assert.ok(!fs.existsSync(timingFile), 'Timing file should be deleted');
  })) passed++; else failed++;

  if (test('PostToolUse without timing file still logs (no duration_ms)', () => {
    cleanup();
    const toolUseId = `tu_notiming_${Date.now()}`;
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.txt' },
      tool_use_id: toolUseId,
    });
    runMonitor('PostToolUse', input, envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'PostToolUse');
    assert.strictEqual(entry.duration_ms, undefined, 'Should not have duration_ms without timing file');
  })) passed++; else failed++;

  // --- Non-tool events ---
  console.log('\nNon-tool events:');

  cleanup();

  if (test('SessionStart logs without tool fields', () => {
    runMonitor('SessionStart', '{}', envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'SessionStart');
    assert.ok(entry.timestamp, 'Should have timestamp');
    assert.strictEqual(entry.tool, undefined, 'Should not have tool field');
  })) passed++; else failed++;

  if (test('SessionEnd logs without tool fields', () => {
    runMonitor('SessionEnd', '{}', envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'SessionEnd');
  })) passed++; else failed++;

  if (test('Stop logs without tool fields', () => {
    runMonitor('Stop', '{}', envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'Stop');
  })) passed++; else failed++;

  if (test('PreCompact logs without tool fields', () => {
    runMonitor('PreCompact', '{}', envBase);
    const entry = readLastLogEntry(getTestLogFile());
    assert.strictEqual(entry.event, 'PreCompact');
  })) passed++; else failed++;

  // --- Module exports (unit tests) ---
  console.log('\nModule exports (unit tests):');

  const { extractInputSummary, safeTimingId } = require(monitorScript);

  if (test('extractInputSummary returns empty string for null input', () => {
    assert.strictEqual(extractInputSummary('Bash', null), '');
    assert.strictEqual(extractInputSummary('Bash', undefined), '');
    assert.strictEqual(extractInputSummary('Bash', 'string'), '');
  })) passed++; else failed++;

  if (test('safeTimingId strips unsafe characters', () => {
    assert.strictEqual(safeTimingId('tu_abc-123'), 'tu_abc-123');
    assert.strictEqual(safeTimingId('tu/../../etc'), 'tuetc');
    assert.strictEqual(safeTimingId(null), null);
    assert.strictEqual(safeTimingId(''), null);
  })) passed++; else failed++;

  // Final cleanup
  cleanup();

  // Summary
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
