import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-agent.mjs');
const nodeBin = process.execPath;

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-test-'));
}

function writeFakeClaude(workspace, source) {
  const fakePath = path.join(workspace, 'claude');
  fs.writeFileSync(fakePath, `#!${nodeBin}\n${source}\n`, 'utf8');
  fs.chmodSync(fakePath, 0o755);
  return fakePath;
}

function runAgent(workspace, args, extraEnv = {}) {
  return spawnSync(nodeBin, [scriptPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function firstRunId(workspace) {
  const result = runAgent(workspace, ['list']);
  assert.equal(result.status, 0, result.stderr);
  const firstLine = result.stdout.trim().split('\n')[0];
  assert.ok(firstLine, 'expected at least one run');
  return firstLine.split('\t')[0];
}

function makeRun(workspace, runId, statusPatch = {}) {
  const runDir = path.join(workspace, '.claude-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify({
    runId,
    kind: 'explore',
    status: 'running',
    cwd: workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resultReady: false,
    ...statusPatch,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '', 'utf8');
  return runDir;
}

test('rejects path-traversal run ids', () => {
  const workspace = makeTempWorkspace();
  const result = runAgent(workspace, ['status', '..']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid run id/);
});

test('doctor verifies Claude CLI help, cwd, runs root, and tool allowlist', () => {
  const workspace = makeTempWorkspace();
  const fakeClaude = writeFakeClaude(
    workspace,
    `
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format stream-json --include-partial-messages --verbose --allowedTools --tools --session-id --no-session-persistence --disable-slash-commands --disallowedTools\\n');
  process.exit(0);
}
process.exit(7);
`,
  );

  const result = runAgent(workspace, ['doctor', '--json'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
    CLAUDE_AGENT_READ_TOOLS: 'Read,Grep,Glob,LS',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.cwd, fs.realpathSync(workspace));
  assert.equal(report.claudeBin, fakeClaude);
  assert.equal(report.readTools, 'Read,Grep,Glob,LS');
  assert.ok(report.checks.every((check) => check.ok), JSON.stringify(report.checks));
});

test('await waits inside one local process until a run reaches done', () => {
  const workspace = makeTempWorkspace();
  const runId = '20260624120000-explore-await1';
  const runDir = makeRun(workspace, runId);
  fs.writeFileSync(path.join(runDir, 'result.md'), 'final answer\n', 'utf8');

  const updater = spawn(nodeBin, ['-e', `
const fs = require('node:fs');
const path = ${JSON.stringify(path.join(runDir, 'status.json'))};
setTimeout(() => {
  const status = JSON.parse(fs.readFileSync(path, 'utf8'));
  status.status = 'done';
  status.resultReady = true;
  status.exitCode = 0;
  status.finishedAt = new Date().toISOString();
  status.updatedAt = new Date().toISOString();
  fs.writeFileSync(path, JSON.stringify(status, null, 2) + '\\n');
}, 100);
setTimeout(() => {}, 300);
`], {
    cwd: workspace,
    env: process.env,
  });

  const result = runAgent(workspace, ['await', runId, '--interval', '0.05', '--max-minutes', '0.05']);
  updater.kill();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: done/);
  assert.match(result.stdout, /resultReady: true/);
  assert.doesNotMatch(result.stdout, /final answer/);
});

test('rejects review-file targets outside the current working directory', () => {
  const workspace = makeTempWorkspace();
  const outsideDir = makeTempWorkspace();
  const outsideFile = path.join(outsideDir, 'outside.md');
  fs.writeFileSync(outsideFile, '# Outside\n', 'utf8');

  const fakeClaude = writeFakeClaude(workspace, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('SHOULD_NOT_RUN\\n'));");
  const result = runAgent(workspace, ['submit', 'review-file', outsideFile, '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside current working directory/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test('rejects runs directory symlink that resolves outside cwd', () => {
  const workspace = makeTempWorkspace();
  const outsideDir = makeTempWorkspace();
  const insideFile = path.join(workspace, 'inside.md');
  fs.writeFileSync(insideFile, '# Inside\n', 'utf8');
  fs.symlinkSync(outsideDir, path.join(workspace, '.claude-runs'), 'dir');

  const fakeClaude = writeFakeClaude(workspace, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('SHOULD_NOT_RUN\\n'));");
  const result = runAgent(workspace, ['submit', 'review-file', insideFile, '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Runs directory resolves outside current working directory/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test('stream-json jobs parse tool events and write clean final result', () => {
  const workspace = makeTempWorkspace();
  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'fake-session' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'FOUND ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ISSUE\\\\n' } } },
    { type: 'result', subtype: 'success', result: 'FOUND ISSUE\\\\n', session_id: 'fake-session' },
  ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'explore', 'inspect this skill', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const runDir = path.join(workspace, '.claude-runs', runId);
  const result = fs.readFileSync(path.join(runDir, 'result.md'), 'utf8');
  assert.equal(result, 'FOUND ISSUE\n');

  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"claude_tool_use"/);
  assert.match(events, /"toolName":"Read"/);

  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.status, 'done');
  assert.equal(status.claudeSessionId, 'fake-session');
  assert.equal(status.resultReady, true);
});

test('review-diff uses stream-json so progress stays observable', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello\n', 'utf8');

  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'review-session' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'REVIEWING ' } } },
    { type: 'result', subtype: 'success', result: 'REVIEWING DONE\\n', session_id: 'review-session' },
  ];
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-diff', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const runDir = path.join(workspace, '.claude-runs', runId);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.outputFormat, 'stream-json');
  assert.equal(status.claudeSessionId, 'review-session');
  assert.equal(status.resultReady, true);
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"type":"claude_session_init"/);
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"type":"claude_result"/);
});

test('review-working-tree request includes unstaged, staged, and safe untracked files', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'working-tree-session' }) + '\\n');
});
`,
  );
  fs.writeFileSync(path.join(workspace, 'unstaged.txt'), 'base\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'staged.txt'), 'base\n', 'utf8');
  spawnSync('git', ['add', 'unstaged.txt', 'staged.txt', 'claude'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base'], { cwd: workspace, encoding: 'utf8' });

  fs.writeFileSync(path.join(workspace, 'unstaged.txt'), 'base\nunstaged change\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'staged.txt'), 'base\nstaged change\n', 'utf8');
  spawnSync('git', ['add', 'staged.txt'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'note\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'large.txt'), '0123456789\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));

  const submit = runAgent(workspace, ['submit', 'review-working-tree', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
    CLAUDE_AGENT_UNTRACKED_MAX_BYTES: '8',
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const request = fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'request.md'), 'utf8');
  assert.match(request, /Git status:/);
  assert.match(request, /Unstaged diff:/);
  assert.match(request, /\+unstaged change/);
  assert.match(request, /Staged diff:/);
  assert.match(request, /\+staged change/);
  assert.match(request, /Untracked files:/);
  assert.match(request, /--- note\.txt ---\nnote\n/);
  assert.match(request, /--- large\.txt ---\n\[omitted: file exceeds 8 bytes\]/);
  assert.match(request, /--- binary\.bin ---\n\[omitted: binary file\]/);
});

test('review commands reject bare --wait to avoid blocking Codex tool calls', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello\n', 'utf8');

  const fakeClaude = writeFakeClaude(workspace, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('SHOULD_NOT_RUN\\n'));");
  const result = runAgent(workspace, ['submit', 'review-diff', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /review runs must use submit -> await -> result/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test('review commands allow explicit --wait-ok escape hatch', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello\n', 'utf8');

  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'wait-ok-session' }) + '\\n');
});
`,
  );

  const result = runAgent(workspace, ['submit', 'review-diff', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });

  assert.equal(result.status, 0, result.stderr);
  const runId = firstRunId(workspace);
  const status = JSON.parse(fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'status.json'), 'utf8'));
  assert.equal(status.status, 'done');
  assert.equal(status.resultReady, true);
});

test('cancel marks a run cancelled and tolerates already-dead pids', () => {
  const workspace = makeTempWorkspace();
  const runId = '20260624120000-explore-cancel';
  const runDir = makeRun(workspace, runId, {
    pid: 999999,
    workerPid: 999998,
    claudePid: 999997,
  });

  const result = runAgent(workspace, ['cancel', runId]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: cancelled/);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.status, 'cancelled');
  assert.equal(status.resultReady, false);
  assert.ok(status.cancelledAt);
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"type":"cancelled"/);
});

test('stdout log is capped without breaking stream-json result parsing', () => {
  const workspace = makeTempWorkspace();
  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  for (let i = 0; i < 30; i += 1) {
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(20) } } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL\\\\n', session_id: 'cap-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'explore', 'inspect logs', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
    CLAUDE_AGENT_STDOUT_LOG_MAX_BYTES: '240',
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const runDir = path.join(workspace, '.claude-runs', runId);
  const stdoutLog = fs.readFileSync(path.join(runDir, 'stdout.log'), 'utf8');
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.ok(Buffer.byteLength(stdoutLog) <= 240, `stdout.log grew to ${Buffer.byteLength(stdoutLog)} bytes`);
  assert.match(stdoutLog, /\[claude-agent: stdout log truncated/);
  assert.equal(status.stdoutLogTruncated, true);
  assert.ok(status.stdoutBytes > status.stdoutLogBytes);
  assert.equal(status.status, 'done');
  assert.equal(fs.readFileSync(path.join(runDir, 'result.md'), 'utf8'), 'FINAL\n');
});

test('explore defaults to local read tools without MCP allowlist', () => {
  const workspace = makeTempWorkspace();
  const argsLog = path.join(workspace, 'claude-args.json');
  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'fake-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'explore', 'inspect tools', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const claudeArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  const allowIndex = claudeArgs.indexOf('--allowedTools');
  assert.ok(allowIndex >= 0, 'expected --allowedTools');
  assert.equal(claudeArgs[allowIndex + 1], 'Read,Grep,Glob,LS');
  assert.doesNotMatch(claudeArgs[allowIndex + 1], /mcp__/);
});

test('explore disables Claude skills to avoid token-heavy automatic skill launches', () => {
  const workspace = makeTempWorkspace();
  const argsLog = path.join(workspace, 'claude-args.json');
  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'no-skills-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'explore', 'inspect without skills', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const claudeArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  assert.ok(claudeArgs.includes('--disable-slash-commands'), 'expected skills/slash commands to be disabled');
  const disallowedIndex = claudeArgs.indexOf('--disallowedTools');
  assert.ok(disallowedIndex >= 0, 'expected --disallowedTools');
  assert.match(claudeArgs[disallowedIndex + 1], /\bSkill\b/);
});

test('rounds after the first require explicit resume session', () => {
  const workspace = makeTempWorkspace();
  const plan = path.join(workspace, 'PLAN.md');
  fs.writeFileSync(plan, '# Plan\n', 'utf8');

  const result = runAgent(workspace, ['submit', 'debate-plan', plan, '--round', '2']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /round > 1 requires --resume-from or --claude-session-id/);
});

test('debate rounds can reuse the same Claude session via --resume-from', () => {
  const workspace = makeTempWorkspace();
  const plan = path.join(workspace, 'PLAN.md');
  const argsLog = path.join(workspace, 'claude-args.jsonl');
  fs.writeFileSync(plan, '# Plan\n', 'utf8');

  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\nVERDICT: APPROVED\\\\n', session_id: '11111111-1111-4111-8111-111111111111' }) + '\\n');
});
`,
  );

  const round1 = runAgent(workspace, ['submit', 'debate-plan', plan, '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(round1.status, 0, round1.stderr);
  const firstId = firstRunId(workspace);

  const round2 = runAgent(workspace, ['submit', 'debate-plan', plan, '--resume-from', firstId, '--round', '2', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(round2.status, 0, round2.stderr);

  const argLines = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(argLines.length, 2);
  const firstSessionIndex = argLines[0].indexOf('--session-id');
  const secondSessionIndex = argLines[1].indexOf('--session-id');
  assert.ok(firstSessionIndex >= 0, 'round 1 should set --session-id');
  assert.ok(secondSessionIndex >= 0, 'round 2 should set --session-id');
  assert.equal(argLines[1][secondSessionIndex + 1], argLines[0][firstSessionIndex + 1]);
});
