import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-agent.mjs');
const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
const readmePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const readmeZhPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.zh-CN.md');
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

test('skill instructs Codex to stay quiet while awaiting Claude', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert.match(skill, /Silent Await Policy/);
  assert.match(skill, /submit, terminal result, or actionable exception/);
  assert.match(skill, /Do not narrate periodic waiting updates/);
  assert.match(skill, /not a user-facing event/);
});

test('skill forbids cancelling a healthy Claude run before the first 25 minute wait completes', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert.match(skill, /Minimum Patience Rule/);
  assert.match(skill, /Do not cancel/);
  assert.match(skill, /first 25-minute await/);
  assert.match(skill, /`status` is `running`/);
  assert.match(skill, /heartbeat or Claude event counters are moving/);
});

test('usage does not imply review commands support bare wait', () => {
  const result = runAgent(makeTempWorkspace(), []);

  assert.equal(result.status, 2);
  assert.equal(result.stderr.includes('submit review-diff [--wait]'), false);
  assert.equal(result.stderr.includes('submit review-working-tree [--wait]'), false);
  assert.equal(result.stderr.includes('submit review-commit [commit-ish] [--wait]'), false);
  assert.equal(result.stderr.includes('submit review-file <path> [--wait]'), false);
  assert.equal(result.stderr.includes('submit review-plan <path> [--wait]'), false);
  assert.ok(result.stderr.includes('submit review-diff|review-working-tree|review-commit|review-file|review-plan [--wait-ok] [--no-persist]'));
});

test('README documents Claude idle await configuration', () => {
  const readme = fs.readFileSync(readmePath, 'utf8');
  const readmeZh = fs.readFileSync(readmeZhPath, 'utf8');

  assert.match(readme, /CLAUDE_AGENT_CLAUDE_IDLE_SECONDS/);
  assert.match(readme, /No Claude stream events/);
  assert.match(readmeZh, /CLAUDE_AGENT_CLAUDE_IDLE_SECONDS/);
  assert.match(readmeZh, /Claude stream event/);
});

test('doctor verifies Claude CLI help, cwd, runs root, and tool allowlist', () => {
  const workspace = makeTempWorkspace();
  const fakeClaude = writeFakeClaude(
    workspace,
    `
if (process.argv.includes('--help')) {
  process.stdout.write('--output-format stream-json --include-partial-messages --verbose --allowedTools --tools --session-id --resume --no-session-persistence --disable-slash-commands --disallowedTools\\n');
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

test('await prints Claude progress fields when a run goes idle', () => {
  const workspace = makeTempWorkspace();
  const runId = '20260624120000-explore-idle01';
  const runDir = makeRun(workspace, runId, {
    pid: 999999,
    workerPid: 999998,
    claudePid: 999997,
    lastClaudeEventAt: new Date(Date.now() - 10_000).toISOString(),
    lastClaudeEventType: 'text_delta',
    claudeEventCount: 12,
    toolUseCount: 2,
  });

  const result = runAgent(workspace, [
    'await',
    runId,
    '--interval',
    '0.01',
    '--max-minutes',
    '0.01',
    '--claude-idle-seconds',
    '0.001',
    '--cancel-on-idle',
  ]);

  assert.equal(result.status, 124);
  assert.match(result.stderr, /No Claude stream events/);
  assert.match(result.stdout, /status: cancelled/);
  assert.match(result.stdout, /lastClaudeEventType: text_delta/);
  assert.match(result.stdout, /claudeEventCount: 12/);
  assert.match(result.stdout, /toolUseCount: 2/);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.status, 'cancelled');
});

test('await idle detection does not cancel Claude unless explicitly requested', () => {
  const workspace = makeTempWorkspace();
  const runId = '20260624120000-explore-idle02';
  const runDir = makeRun(workspace, runId, {
    pid: 999999,
    workerPid: 999998,
    claudePid: 999997,
    lastClaudeEventAt: new Date(Date.now() - 10_000).toISOString(),
    lastClaudeEventType: 'message_start',
    claudeEventCount: 1,
  });

  const result = runAgent(workspace, [
    'await',
    runId,
    '--interval',
    '0.01',
    '--max-minutes',
    '0.01',
    '--claude-idle-seconds',
    '0.001',
  ]);

  assert.equal(result.status, 124);
  assert.match(result.stderr, /No Claude stream events/);
  assert.match(result.stdout, /status: running/);
  assert.match(result.stdout, /lastClaudeEventType: message_start/);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.status, 'running');
});

test('await can cancel a run when the wall-clock budget expires', () => {
  const workspace = makeTempWorkspace();
  const runId = '20260624120000-explore-time01';
  const runDir = makeRun(workspace, runId, {
    pid: 999999,
    workerPid: 999998,
    claudePid: 999997,
    lastClaudeEventAt: new Date().toISOString(),
    lastClaudeEventType: 'message_start',
    claudeEventCount: 1,
  });

  const result = runAgent(workspace, [
    'await',
    runId,
    '--interval',
    '0.01',
    '--max-minutes',
    '0.001',
    '--cancel-on-timeout',
  ]);

  assert.equal(result.status, 124);
  assert.match(result.stderr, /Timed out waiting for run/);
  assert.match(result.stdout, /status: cancelled/);
  assert.match(result.stdout, /cancelReason: Timed out waiting/);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.status, 'cancelled');
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"type":"await_cancelled"/);
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

test('review runs persist Claude sessions by default so IDE history can show them', () => {
  const workspace = makeTempWorkspace();
  const argsLog = path.join(workspace, 'claude-args.json');
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello\n', 'utf8');

  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'persist-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-diff', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const claudeArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  assert.doesNotMatch(claudeArgs.join(' '), /--no-session-persistence/);
});

test('review runs can opt out of Claude session history with --no-persist', () => {
  const workspace = makeTempWorkspace();
  const argsLog = path.join(workspace, 'claude-args.json');
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'hello\n', 'utf8');

  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'no-persist-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-diff', '--no-persist', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const claudeArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  assert.ok(claudeArgs.includes('--no-session-persistence'));
});

test('explore can opt out of Claude session history with environment variable', () => {
  const workspace = makeTempWorkspace();
  const argsLog = path.join(workspace, 'claude-args.json');
  const fakeClaude = writeFakeClaude(
    workspace,
    `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'env-no-persist-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'explore', 'inspect persistence', '--wait'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
    CLAUDE_AGENT_NO_SESSION_PERSISTENCE: '1',
  });
  assert.equal(submit.status, 0, submit.stderr);

  const claudeArgs = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  assert.ok(claudeArgs.includes('--no-session-persistence'));
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

test('review-commit request embeds the selected commit patch', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\n', 'utf8');
  spawnSync('git', ['add', 'file.txt'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\nreview me\n', 'utf8');
  spawnSync('git', ['add', 'file.txt'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'feature commit'], { cwd: workspace, encoding: 'utf8' });

  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'commit-review-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-commit', 'HEAD', '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const request = fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'request.md'), 'utf8');
  assert.match(request, /任务：评审已提交的 git commit/);
  assert.match(request, /Commit:/);
  assert.match(request, /feature commit/);
  assert.match(request, /```diff/);
  assert.match(request, /\+review me/);
});

test('review-commit can compare HEAD against an explicit base ref', () => {
  const workspace = makeTempWorkspace();
  spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\n', 'utf8');
  spawnSync('git', ['add', 'file.txt'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base'], { cwd: workspace, encoding: 'utf8' });
  const baseRef = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\none\n', 'utf8');
  spawnSync('git', ['add', 'file.txt'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'one'], { cwd: workspace, encoding: 'utf8' });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'base\none\ntwo\n', 'utf8');
  spawnSync('git', ['add', 'file.txt'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'two'], { cwd: workspace, encoding: 'utf8' });

  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'commit-base-review-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-commit', 'HEAD', '--base', baseRef, '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const request = fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'request.md'), 'utf8');
  assert.match(request, new RegExp(`Base: ${baseRef}`));
  assert.match(request, /\+one/);
  assert.match(request, /\+two/);
});

test('review-file rejects packets that reference a commit diff without embedding one', () => {
  const workspace = makeTempWorkspace();
  const target = path.join(workspace, 'packet.md');
  fs.writeFileSync(target, [
    '# Review Request',
    '',
    'Please review commit HEAD against the plan.',
    '',
    '## Diff to Review',
    '',
    'Please inspect the repository diff for HEAD^..HEAD directly.',
    '',
  ].join('\n'), 'utf8');
  const fakeClaude = writeFakeClaude(workspace, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('SHOULD_NOT_RUN\\n'));");

  const result = runAgent(workspace, ['submit', 'review-file', target, '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references a git diff or commit but does not embed a unified diff/);
  assert.match(result.stderr, /review-commit/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test('review requests demand concise blocker-first output', () => {
  const workspace = makeTempWorkspace();
  const target = path.join(workspace, 'target.md');
  fs.writeFileSync(target, '# Target\n\ncontent\n', 'utf8');
  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'concise-review-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-file', target, '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const request = fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'request.md'), 'utf8');
  assert.match(request, /短平快/);
  assert.match(request, /最多 3 条/);
  assert.match(request, /每条最多 2 行/);
  assert.match(request, /不要长篇展开/);
  assert.match(request, /只输出阻塞项/);
});

test('review requests frame Claude output as Codex-consumed review signals', () => {
  const workspace = makeTempWorkspace();
  const target = path.join(workspace, 'target.md');
  fs.writeFileSync(target, '# Target\n\ncontent\n', 'utf8');
  const fakeClaude = writeFakeClaude(
    workspace,
    `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK\\\\n', session_id: 'review-signal-session' }) + '\\n');
});
`,
  );

  const submit = runAgent(workspace, ['submit', 'review-file', target, '--wait', '--wait-ok'], {
    CLAUDE_AGENT_CLAUDE_BIN: fakeClaude,
  });
  assert.equal(submit.status, 0, submit.stderr);

  const runId = firstRunId(workspace);
  const request = fs.readFileSync(path.join(workspace, '.claude-runs', runId, 'request.md'), 'utf8');
  assert.match(request, /给 Codex 消费的中间审查信号/);
  assert.match(request, /不要写成给最终用户的结论/);
  assert.match(request, /clearly_actionable/);
  assert.match(request, /needs_user_decision/);
  assert.match(request, /uncertain/);
});

test('skill requires Codex to triage Claude review results before user-facing output', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');

  assert.match(skill, /Review Results Are Inputs/);
  assert.match(skill, /accepted/);
  assert.match(skill, /rejected/);
  assert.match(skill, /needs_user_decision/);
  assert.match(skill, /deferred/);
  assert.match(skill, /Do not paste raw Claude output/);
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

test('grill runs reject --no-persist because session history is required for resume', () => {
  const workspace = makeTempWorkspace();
  const plan = path.join(workspace, 'PLAN.md');
  fs.writeFileSync(plan, '# Plan\n', 'utf8');

  const result = runAgent(workspace, ['submit', 'grill-plan', plan, '--no-persist']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--no-persist is only supported for review\/explore runs/);
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
  const secondResumeIndex = argLines[1].indexOf('--resume');
  assert.ok(firstSessionIndex >= 0, 'round 1 should set --session-id');
  assert.ok(secondResumeIndex >= 0, 'round 2 should resume the prior Claude conversation');
  assert.equal(argLines[1][secondResumeIndex + 1], argLines[0][firstSessionIndex + 1]);
  assert.equal(argLines[1].indexOf('--session-id'), -1, 'round 2 should not claim an already-created session id');
});
