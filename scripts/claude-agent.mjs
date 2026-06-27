#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_RUNS_DIR = '.claude-runs';
const STATUS_FILE = 'status.json';
const REQUEST_FILE = 'request.md';
const RESULT_FILE = 'result.md';
const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const EVENTS_FILE = 'events.jsonl';
const THIS_FILE = fileURLToPath(import.meta.url);
const RUN_ID_PATTERN = /^[0-9]{14}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{6}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_READ_ONLY_TOOLS = 'Read,Grep,Glob,LS';
const DEFAULT_DISALLOWED_TOOLS = 'Skill';
const MAX_CAPTURE_CHARS = 1_000_000;
const DEFAULT_UNTRACKED_MAX_BYTES = 64 * 1024;
const DEFAULT_STDOUT_LOG_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_CLAUDE_IDLE_SECONDS = 0;
let activeCwd = fs.realpathSync(process.cwd());

function usage(exitCode = 2) {
  const text = `Usage:
  claude-agent.mjs --cwd <project-dir> submit review-diff [--wait-ok] [--no-persist]
  claude-agent.mjs --cwd <project-dir> submit review-working-tree [--wait-ok] [--no-persist]
  claude-agent.mjs --cwd <project-dir> submit review-file <path> [--wait-ok] [--no-persist]
  claude-agent.mjs --cwd <project-dir> submit review-plan <path> [--wait-ok] [--no-persist]
  claude-agent.mjs --cwd <project-dir> submit grill-diff [--log <path>] [--round N] [--claude-session-id UUID|--resume-from RUN_ID] [--wait]
  claude-agent.mjs --cwd <project-dir> submit grill-plan <path> [--log <path>] [--round N] [--claude-session-id UUID|--resume-from RUN_ID] [--wait]
  claude-agent.mjs --cwd <project-dir> submit debate-diff [--log <path>] [--round N] [--claude-session-id UUID|--resume-from RUN_ID] [--wait]
  claude-agent.mjs --cwd <project-dir> submit debate-plan <path> [--log <path>] [--round N] [--claude-session-id UUID|--resume-from RUN_ID] [--wait]
  claude-agent.mjs --cwd <project-dir> submit review-diff|review-working-tree|review-file|review-plan [--wait-ok] [--no-persist]
  claude-agent.mjs --cwd <project-dir> submit explore <question...> [--wait] [--no-persist]
  claude-agent.mjs --cwd <project-dir> status <run-id>
  claude-agent.mjs --cwd <project-dir> result <run-id>
  claude-agent.mjs --cwd <project-dir> verdict <run-id>
  claude-agent.mjs --cwd <project-dir> tail <run-id> [--lines N]
  claude-agent.mjs --cwd <project-dir> list
  claude-agent.mjs --cwd <project-dir> await <run-id> [--interval seconds] [--max-minutes minutes] [--stale-seconds seconds] [--claude-idle-seconds seconds] [--cancel-on-idle] [--cancel-on-timeout]
  claude-agent.mjs --cwd <project-dir> cancel <run-id>
  claude-agent.mjs --cwd <project-dir> doctor [--json]

Environment:
  CLAUDE_AGENT_RUNS_DIR       Override runs directory (default: ./.claude-runs)
  CLAUDE_AGENT_CLAUDE_BIN     Override Claude binary (default: claude)
  CLAUDE_AGENT_NODE_BIN       Override Node binary for detached worker
  CLAUDE_AGENT_READ_TOOLS     Override read-only tool allowlist (default: Read,Grep,Glob,LS)
  CLAUDE_AGENT_DISALLOWED_TOOLS  Extra Claude tools to deny (default: Skill)
  CLAUDE_AGENT_NO_SESSION_PERSISTENCE  Set to 1/true/yes/on to opt out of Claude local session history for review/explore
  CLAUDE_AGENT_UNTRACKED_MAX_BYTES  Max bytes per untracked text file in review-working-tree
  CLAUDE_AGENT_STDOUT_LOG_MAX_BYTES Max raw stdout.log bytes before truncation
  CLAUDE_AGENT_CLAUDE_IDLE_SECONDS Max seconds without Claude stream events before await returns non-zero (default: disabled)
`;
  process.stderr.write(text);
  process.exit(exitCode);
}

function nowIso() {
  return new Date().toISOString();
}

function repoCwd() {
  return activeCwd;
}

function setRepoCwd(value) {
  const resolved = path.resolve(process.cwd(), value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`cwd does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${resolved}`);
  }
  activeCwd = fs.realpathSync(resolved);
}

function isInsidePath(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsidePath(base, target, message) {
  if (!isInsidePath(base, target)) {
    throw new Error(`${message}: ${target}`);
  }
  return target;
}

function assertChildPath(base, target, message) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${message}: ${target}`);
  }
  return target;
}

function resolveExistingFileInsideCwd(input, label = 'File path') {
  const absolute = path.resolve(repoCwd(), input);
  if (!fs.existsSync(absolute)) {
    throw new Error(`${label} not found: ${absolute}`);
  }
  const real = fs.realpathSync(absolute);
  assertInsidePath(repoCwd(), real, `${label} is outside current working directory`);
  if (!fs.statSync(real).isFile()) {
    throw new Error(`${label} is not a file: ${real}`);
  }
  return real;
}

function runsRoot() {
  const configured = process.env.CLAUDE_AGENT_RUNS_DIR || DEFAULT_RUNS_DIR;
  const root = path.resolve(repoCwd(), configured);
  assertInsidePath(repoCwd(), root, 'Runs directory is outside current working directory');
  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    assertInsidePath(repoCwd(), realRoot, 'Runs directory resolves outside current working directory');
    return realRoot;
  }
  return root;
}

function ensureRunsRoot() {
  const root = runsRoot();
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  assertInsidePath(repoCwd(), realRoot, 'Runs directory resolves outside current working directory');
  return realRoot;
}

function safeRunId(kind) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${kind.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${random}`;
}

function runDirFor(runId) {
  if (!RUN_ID_PATTERN.test(runId || '')) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  const root = runsRoot();
  const runDir = path.resolve(root, runId);
  return assertChildPath(root, runDir, 'Run directory is outside runs root');
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendEvent(runDir, event) {
  fs.appendFileSync(
    path.join(runDir, EVENTS_FILE),
    `${JSON.stringify({ ts: nowIso(), ...event })}\n`,
    'utf8',
  );
}

function updateStatus(runDir, patch) {
  const statusPath = path.join(runDir, STATUS_FILE);
  const current = fs.existsSync(statusPath) ? readJson(statusPath) : {};
  const next = { ...current, ...patch, updatedAt: nowIso() };
  writeJson(statusPath, next);
  return next;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoCwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function optionNumber(args, name, fallback) {
  const raw = optionValue(args, name);
  if (raw === null || raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function optionNumberFromEnv(args, optionName, envName, fallback) {
  const rawOption = optionValue(args, optionName);
  if (rawOption !== null && rawOption !== undefined) {
    return optionNumber(args, optionName, fallback);
  }
  const rawEnv = process.env[envName];
  if (rawEnv === undefined || rawEnv === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(rawEnv);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative number`);
  }
  return parsed;
}

function hasOption(args, name) {
  return args.includes(name);
}

function envPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function numberLines(content) {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
    .join('\n');
}

function conciseReviewOutputRules(extraRules = []) {
  return [
    '输出要求（短平快，blocker-first）：',
    '1. 第一行只写：VERDICT: BLOCKED / OK / UNSURE。',
    '2. 只输出阻塞项或高置信真实问题；最多 3 条。',
    '3. 每条最多 2 行：`- [等级] 文件:行 — 问题；建议动作`。',
    '4. 必须带最小证据（文件路径/行号/片段关键词），不要长篇展开。',
    '5. 你的输出是给 Codex 消费的中间审查信号，不要写成给最终用户的结论。',
    '6. 每条发现标注 triage_hint：clearly_actionable / needs_user_decision / uncertain。',
    '7. 不要复述需求、不要总结优点、不要列低价值建议。',
    '8. 如果未发现阻塞项，只写两行：`VERDICT: OK` 和 `未发现明显阻塞项`。',
    ...extraRules,
  ];
}

function buildRequest(kind, payload) {
  if (kind === 'review-diff') {
    const diff = payload.diff || '(当前没有 git diff 输出)';
    return [
      '你是独立代码评审 reviewer。请只做评审，不要修改任何文件，不要使用工具。',
      '',
      '任务：评审当前 git diff。',
      '',
      ...conciseReviewOutputRules(),
      '',
      'git diff：',
      '',
      diff,
    ].join('\n');
  }

  if (kind === 'review-working-tree') {
    return [
      '你是独立代码评审 reviewer。请只做评审，不要修改任何文件，不要使用工具。',
      '',
      '任务：评审当前完整工作区改动，包括 Git status、unstaged diff、staged diff、以及可安全读取的 untracked 文本文件。',
      '',
      ...conciseReviewOutputRules([
        '7. 特别留意 staged/unstaged/untracked 之间的不一致、漏提交文件、生成物或临时文件。',
      ]),
      '',
      'Git status:',
      '',
      payload.status || '(git status 没有输出)',
      '',
      'Unstaged diff:',
      '',
      payload.unstagedDiff || '(没有 unstaged diff)',
      '',
      'Staged diff:',
      '',
      payload.stagedDiff || '(没有 staged diff)',
      '',
      'Untracked files:',
      '',
      payload.untrackedText || '(没有可展示的 untracked 文件)',
    ].join('\n');
  }

  if (kind === 'review-file') {
    return [
      '你是独立文件评审 reviewer。请只基于下面带行号的文件内容做评审，不要修改任何文件，不要使用工具。',
      '',
      `目标文件：${payload.path}`,
      '',
      ...conciseReviewOutputRules(),
      '',
      '文件内容：',
      '',
      numberLines(payload.content),
    ].join('\n');
  }

  if (kind === 'review-plan') {
    return [
      '你是独立架构/方案评审 reviewer。请只基于下面带行号的方案做评审，不要修改任何文件，不要使用工具。',
      '',
      `目标方案：${payload.path}`,
      '',
      ...conciseReviewOutputRules([
        '7. 重点检查架构边界、迁移风险、回滚/验证缺口、与现有系统约束的冲突。',
      ]),
      '',
      '方案内容：',
      '',
      numberLines(payload.content),
    ].join('\n');
  }

  if (kind === 'explore') {
    return [
      '你是独立代码探索 agent。请只做只读探索，不要修改任何文件，不要 commit/push/deploy。',
      '',
      `问题：${payload.question}`,
      '',
      '要求：',
      '1. 优先阅读项目规则，例如 AGENTS.md、CLAUDE.md、README、相关 docs。',
      '2. 用只读方式定位相关文件、函数、路由、数据流。',
      '3. 输出事实、证据路径、关键文件/符号、仍不确定的问题。',
      '4. 不要做代码修改；不要执行破坏性命令；不要泄露密钥。',
    ].join('\n');
  }

  if (kind === 'grill-plan' || kind === 'debate-plan') {
    const priorLog = payload.priorLog ? [
      '既往争论日志（如果有）：',
      '',
      payload.priorLog,
      '',
      '本轮要求：复查之前未解决的问题是否已经解决；不要重复纠缠已经明确解决的问题；可以提出新的重大风险。',
      '',
    ].join('\n') : '';

    return [
      'You are a skeptical architecture interviewer. 你是一个连续质询的架构面试官。',
      '',
      `Round: ${payload.round || 1}`,
      `目标方案：${payload.path}`,
      '',
      priorLog,
      'Ask the single most important unresolved question for this round.',
      'Be skeptical and specific. Your job is to force the design to become precise, not to be agreeable.',
      'If a prior round already resolved a point, do not repeat it unless it regressed.',
      'For each question, give: Question, Why this matters, Recommended answer, Verification to demand.',
      '',
      'End your reply with EXACTLY one final line:',
      'VERDICT: APPROVED',
      'or',
      'VERDICT: REVISE',
      '',
      '方案内容（带行号）：',
      '',
      numberLines(payload.content),
    ].join('\n');
  }

  if (kind === 'grill-diff' || kind === 'debate-diff') {
    const priorLog = payload.priorLog ? [
      '既往争论日志（如果有）：',
      '',
      payload.priorLog,
      '',
      '本轮要求：复查之前未解决的问题是否已经解决；不要重复纠缠已经明确解决的问题；可以提出新的重大风险。',
      '',
    ].join('\n') : '';

    return [
      'You are a skeptical code interviewer. 你是一个连续质询的代码面试官。',
      '',
      `Round: ${payload.round || 1}`,
      '',
      priorLog,
      'Ask the single most important unresolved question for this round.',
      'Be skeptical and specific. Your job is to force the code to become precise, not to be agreeable.',
      'If a prior round already resolved a point, do not repeat it unless it regressed.',
      'For each question, give: Question, Why this matters, Recommended answer, Verification to demand.',
      '',
      'End your reply with EXACTLY one final line:',
      'VERDICT: APPROVED',
      'or',
      'VERDICT: REVISE',
      '',
      'git diff：',
      '',
      payload.diff || '(当前没有 git diff 输出)',
    ].join('\n');
  }

  throw new Error(`Unsupported kind: ${kind}`);
}

function isGrillKind(kind) {
  return kind === 'grill-plan' || kind === 'grill-diff' || kind === 'debate-plan' || kind === 'debate-diff';
}

function isReviewKind(kind) {
  return kind === 'review-diff' || kind === 'review-working-tree' || kind === 'review-file' || kind === 'review-plan';
}

function streamJsonArgs(extraArgs = []) {
  return [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...skillDisableArgs(),
    ...extraArgs,
  ];
}

function readOnlyTools() {
  return process.env.CLAUDE_AGENT_READ_TOOLS || DEFAULT_READ_ONLY_TOOLS;
}

function disallowedTools() {
  return process.env.CLAUDE_AGENT_DISALLOWED_TOOLS || DEFAULT_DISALLOWED_TOOLS;
}

function skillDisableArgs() {
  const denied = disallowedTools().trim();
  const args = ['--disable-slash-commands'];
  if (denied) {
    args.push('--disallowedTools', denied);
  }
  return args;
}

function sessionPersistenceArgs(noPersist = false) {
  return noPersist ? ['--no-session-persistence'] : [];
}

function claudeInvocationFor(kind, payload = {}) {
  if (isGrillKind(kind)) {
    const round = payload.round || 1;
    const claudeSessionId = payload.claudeSessionId || crypto.randomUUID();
    const isResume = Boolean(payload.resumeFrom || round > 1 || payload.claudeSessionId);
    const sessionArgs = isResume
      ? ['--resume', claudeSessionId]
      : ['--session-id', claudeSessionId];
    return {
      args: streamJsonArgs([
        ...sessionArgs,
        '--allowedTools',
        readOnlyTools(),
      ]),
      claudeSessionId,
      continuity: 'same-session',
      sessionPersistence: 'enabled',
      sessionMode: isResume ? 'resume' : 'start',
      resumeFrom: payload.resumeFrom,
      round,
    };
  }

  if (isReviewKind(kind)) {
    return {
      args: streamJsonArgs([
        ...sessionPersistenceArgs(payload.noPersist),
        '--tools',
        '',
      ]),
      continuity: 'single-call',
      sessionPersistence: payload.noPersist ? 'disabled' : 'enabled',
    };
  }

  if (kind === 'explore') {
    return {
      args: streamJsonArgs([
        ...sessionPersistenceArgs(payload.noPersist),
        '--allowedTools',
        readOnlyTools(),
      ]),
      continuity: 'single-call',
      sessionPersistence: payload.noPersist ? 'disabled' : 'enabled',
    };
  }
  return {
    args: ['-p', ...sessionPersistenceArgs(payload.noPersist), ...skillDisableArgs(), '--output-format', 'text', '--tools', ''],
    continuity: 'single-call',
    sessionPersistence: payload.noPersist ? 'disabled' : 'enabled',
  };
}

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function readOptionalLog(args) {
  const logPath = optionValue(args, '--log');
  if (!logPath) {
    return '';
  }
  const absolute = resolveExistingFileInsideCwd(logPath, 'Log file');
  return fs.readFileSync(absolute, 'utf8');
}

function loadRunStatus(runId) {
  const runDir = runDirFor(runId);
  const statusPath = path.join(runDir, STATUS_FILE);
  if (!fs.existsSync(statusPath)) {
    throw new Error(`Run not found: ${runId}`);
  }
  return readJson(statusPath);
}

function sessionIdFromResumeRun(runId) {
  const status = loadRunStatus(runId);
  if (!isGrillKind(status.kind)) {
    throw new Error(`Can only resume from grill/debate runs: ${runId}`);
  }
  if (!status.claudeSessionId) {
    throw new Error(`Run has no claudeSessionId to resume: ${runId}`);
  }
  return status.claudeSessionId;
}

function validateReviewPreflight(wait, waitOk) {
  runsRoot();
  if (wait && !waitOk) {
    throw new Error('review runs must use submit -> await -> result; add --wait-ok only if you deliberately want synchronous review');
  }
}

function requireGitCommand(args, label) {
  const result = runCommand('git', args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

function isNulSeparatedBinary(buffer) {
  return buffer.includes(0);
}

function readFileSample(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(1, maxBytes));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function formatUntrackedFile(relativePath, maxBytes) {
  const absolute = path.resolve(repoCwd(), relativePath);
  assertInsidePath(repoCwd(), absolute, 'Untracked file is outside current working directory');
  const stat = fs.lstatSync(absolute);
  const header = `--- ${relativePath} ---`;

  if (stat.isSymbolicLink()) {
    return `${header}\n[omitted: symlink not followed]`;
  }
  if (!stat.isFile()) {
    return `${header}\n[omitted: not a regular file]`;
  }

  const real = fs.realpathSync(absolute);
  assertInsidePath(repoCwd(), real, 'Untracked file resolves outside current working directory');
  const sample = readFileSample(real, Math.min(Math.max(maxBytes, 1), 4096));
  if (isNulSeparatedBinary(sample)) {
    return `${header}\n[omitted: binary file]`;
  }
  if (stat.size > maxBytes) {
    return `${header}\n[omitted: file exceeds ${maxBytes} bytes]`;
  }
  return `${header}\n${fs.readFileSync(real, 'utf8')}`;
}

function buildUntrackedText() {
  const maxBytes = envPositiveInteger('CLAUDE_AGENT_UNTRACKED_MAX_BYTES', DEFAULT_UNTRACKED_MAX_BYTES);
  const output = requireGitCommand(['ls-files', '--others', '--exclude-standard', '-z'], 'git ls-files --others');
  const root = runsRoot();
  const parts = [];
  for (const relativePath of output.split('\0').filter(Boolean)) {
    const absolute = path.resolve(repoCwd(), relativePath);
    assertInsidePath(repoCwd(), absolute, 'Untracked file is outside current working directory');
    if (isInsidePath(root, absolute)) {
      continue;
    }
    parts.push(formatUntrackedFile(relativePath, maxBytes));
  }
  return parts.join('\n\n');
}

function buildWorkingTreePayload() {
  return {
    status: requireGitCommand(['status', '--porcelain=v1', '-uall'], 'git status'),
    unstagedDiff: requireGitCommand(['diff', '--no-ext-diff', '--unified=3', '--no-color'], 'git diff'),
    stagedDiff: requireGitCommand(['diff', '--cached', '--no-ext-diff', '--unified=3', '--no-color'], 'git diff --cached'),
    untrackedText: buildUntrackedText(),
  };
}

function stripOptions(args, optionsWithValue = []) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--wait' || arg === '--wait-ok' || arg === '--no-persist') {
      continue;
    }
    if (optionsWithValue.includes(arg)) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function parseSubmitArgs(args) {
  const wait = args.includes('--wait');
  const waitOk = args.includes('--wait-ok');
  const noPersist = args.includes('--no-persist') || envFlag('CLAUDE_AGENT_NO_SESSION_PERSISTENCE');
  const round = Number.parseInt(optionValue(args, '--round', '1'), 10) || 1;
  const priorLog = readOptionalLog(args);
  const claudeSessionId = optionValue(args, '--claude-session-id');
  const resumeFrom = optionValue(args, '--resume-from');
  if (claudeSessionId && resumeFrom) {
    throw new Error('--claude-session-id and --resume-from cannot be used together');
  }
  if (claudeSessionId && !UUID_PATTERN.test(claudeSessionId)) {
    throw new Error(`Invalid Claude session id: ${claudeSessionId}`);
  }
  const filtered = stripOptions(args, ['--log', '--round', '--claude-session-id', '--resume-from']);
  const [kind, ...rest] = filtered;

  if (!kind) {
    usage();
  }

  if (resumeFrom && !isGrillKind(kind)) {
    throw new Error('--resume-from is only supported for grill/debate runs');
  }
  const effectiveClaudeSessionId = resumeFrom ? sessionIdFromResumeRun(resumeFrom) : claudeSessionId;
  if (isGrillKind(kind) && round > 1 && !effectiveClaudeSessionId) {
    throw new Error('round > 1 requires --resume-from or --claude-session-id');
  }
  if (isGrillKind(kind) && noPersist) {
    throw new Error('--no-persist is only supported for review/explore runs');
  }

  if (kind === 'review-diff') {
    const diff = runCommand('git', ['diff', '--no-ext-diff', '--unified=3', '--no-color']);
    if (diff.status !== 0) {
      process.stderr.write(diff.stderr || '');
      process.exit(diff.status ?? 1);
    }
    validateReviewPreflight(wait, waitOk);
    return { kind, wait, payload: { diff: diff.stdout || '', noPersist } };
  }

  if (kind === 'review-working-tree') {
    validateReviewPreflight(wait, waitOk);
    return { kind, wait, payload: { ...buildWorkingTreePayload(), noPersist } };
  }

  if (kind === 'grill-diff' || kind === 'debate-diff') {
    const diff = runCommand('git', ['diff', '--no-ext-diff', '--unified=3', '--no-color']);
    if (diff.status !== 0) {
      process.stderr.write(diff.stderr || '');
      process.exit(diff.status ?? 1);
    }
    return { kind, wait, payload: { diff: diff.stdout || '', priorLog, round, claudeSessionId: effectiveClaudeSessionId, resumeFrom } };
  }

  if (kind === 'review-file' || kind === 'review-plan' || kind === 'grill-plan' || kind === 'debate-plan') {
    const target = rest[0];
    if (!target) {
      usage();
    }
    const absolute = resolveExistingFileInsideCwd(target, 'File path');
    if ((kind === 'review-file' || kind === 'review-plan') && wait && !waitOk) {
      validateReviewPreflight(wait, waitOk);
    }
    return {
      kind,
      wait,
      payload: {
        path: absolute,
        content: fs.readFileSync(absolute, 'utf8'),
        priorLog,
        round,
        claudeSessionId: effectiveClaudeSessionId,
        resumeFrom,
        noPersist,
      },
    };
  }

  if (kind === 'explore') {
    const question = rest.join(' ').trim();
    if (!question) {
      usage();
    }
    return { kind, wait, payload: { question, noPersist } };
  }

  usage();
}

function createRun(kind, request) {
  const root = ensureRunsRoot();
  let runId = null;
  let runDir = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    runId = safeRunId(kind);
    runDir = path.resolve(root, runId);
    assertChildPath(root, runDir, 'Run directory is outside runs root');
    try {
      fs.mkdirSync(runDir, { recursive: false });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 9) {
        throw error;
      }
    }
  }
  fs.writeFileSync(path.join(runDir, REQUEST_FILE), request, 'utf8');
  fs.writeFileSync(path.join(runDir, STDOUT_FILE), '', 'utf8');
  fs.writeFileSync(path.join(runDir, STDERR_FILE), '', 'utf8');
  fs.writeFileSync(path.join(runDir, EVENTS_FILE), '', 'utf8');
  writeJson(path.join(runDir, STATUS_FILE), {
    runId,
    kind,
    status: 'queued',
    cwd: repoCwd(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    request: path.join(runDir, REQUEST_FILE),
    result: path.join(runDir, RESULT_FILE),
  });
  appendEvent(runDir, { type: 'queued', kind });
  return { runId, runDir };
}

function hasStreamJsonOutput(args) {
  const outputFormatIndex = args.indexOf('--output-format');
  return outputFormatIndex >= 0 && args[outputFormatIndex + 1] === 'stream-json';
}

function splitConcatenatedJsonRecords(text) {
  const records = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        records.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return records;
}

function contentArrayFromEvent(event) {
  if (Array.isArray(event?.message?.content)) return event.message.content;
  if (Array.isArray(event?.content)) return event.content;
  return [];
}

function toolUsesFromEvent(event) {
  const tools = [];
  const maybeAdd = (block) => {
    if (block?.type === 'tool_use' && block.name) {
      tools.push({ toolName: block.name, toolId: block.id });
    }
  };

  if (event?.type === 'stream_event' && event.event?.type === 'content_block_start') {
    maybeAdd(event.event.content_block);
  }
  if (event?.type === 'tool_use') {
    maybeAdd(event);
  }
  for (const block of contentArrayFromEvent(event)) {
    maybeAdd(block);
  }
  return tools;
}

function textPartsFromEvent(event) {
  const parts = [];
  if (event?.type === 'stream_event' && event.event?.type === 'content_block_delta') {
    const delta = event.event.delta;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      parts.push(delta.text);
    }
  }
  for (const block of contentArrayFromEvent(event)) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts;
}

function normalizeResultText(text) {
  if (typeof text === 'string' && !text.includes('\n') && text.includes('\\n')) {
    return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
  return text;
}

function createStreamJsonObserver(runDir) {
  let buffer = '';
  let eventCount = 0;
  let toolUseCount = 0;
  let finalResult = null;
  let resultSubtype = null;
  let lastStatusWriteMs = 0;
  const textParts = [];
  const seenToolIds = new Set();

  const heartbeat = (patch = {}, force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastStatusWriteMs < 1000) {
      return;
    }
    lastStatusWriteMs = nowMs;
    updateStatus(runDir, {
      lastClaudeEventAt: nowIso(),
      claudeEventCount: eventCount,
      toolUseCount,
      ...patch,
    });
  };

  const recordSessionId = (sessionId) => {
    if (!sessionId) return;
    const status = readJson(path.join(runDir, STATUS_FILE));
    if (!status.claudeSessionId) {
      updateStatus(runDir, { claudeSessionId: sessionId });
    } else if (status.claudeSessionId !== sessionId) {
      updateStatus(runDir, { observedClaudeSessionId: sessionId });
    }
  };

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      appendEvent(runDir, {
        type: 'claude_stream_parse_error',
        message: error.message,
        sample: line.slice(0, 500),
      });
      heartbeat({ lastClaudeEventType: 'parse_error' }, true);
      return;
    }

    eventCount += 1;
    const eventType = event.type || 'unknown';

    if (eventType === 'system' && event.subtype === 'init') {
      recordSessionId(event.session_id);
      appendEvent(runDir, {
        type: 'claude_session_init',
        sessionId: event.session_id,
        model: event.model,
      });
      heartbeat({ lastClaudeEventType: 'system:init' }, true);
    }

    for (const tool of toolUsesFromEvent(event)) {
      if (tool.toolId) {
        if (seenToolIds.has(tool.toolId)) {
          continue;
        }
        seenToolIds.add(tool.toolId);
      }
      toolUseCount += 1;
      appendEvent(runDir, {
        type: 'claude_tool_use',
        toolName: tool.toolName,
        toolId: tool.toolId,
      });
      heartbeat({
        lastClaudeEventType: 'tool_use',
        lastToolName: tool.toolName,
      }, true);
    }

    const textPartsForEvent = textPartsFromEvent(event);
    if (textPartsForEvent.length > 0) {
      textParts.push(...textPartsForEvent);
      heartbeat({ lastClaudeEventType: 'text_delta' });
    }

    if (eventType === 'result') {
      resultSubtype = event.subtype || null;
      if (typeof event.result === 'string') {
        finalResult = normalizeResultText(event.result);
      }
      recordSessionId(event.session_id);
      appendEvent(runDir, {
        type: 'claude_result',
        subtype: event.subtype,
        sessionId: event.session_id,
      });
      heartbeat({
        lastClaudeEventType: 'result',
        resultSubtype,
      }, true);
    } else {
      heartbeat({ lastClaudeEventType: eventType });
    }
  };

  return {
    feed(chunkText) {
      buffer += chunkText;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      const records = splitConcatenatedJsonRecords(rest);
      const lines = records.length > 0 ? records : rest.split(/\r?\n/);
      for (const line of lines) {
        processLine(line);
      }
    },
    finalText(fallbackText) {
      if (finalResult !== null) return finalResult;
      if (textParts.length > 0) return normalizeResultText(textParts.join(''));
      return fallbackText;
    },
    summary() {
      return {
        claudeEventCount: eventCount,
        toolUseCount,
        resultSubtype,
      };
    },
  };
}

function appendBounded(existing, addition, maxChars = MAX_CAPTURE_CHARS) {
  if (existing.length >= maxChars) {
    return existing;
  }
  const remaining = maxChars - existing.length;
  return existing + addition.slice(0, remaining);
}

function createCappedLogWriter(file, maxBytes) {
  let rawBytes = 0;
  let logBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let truncated = false;
  const marker = Buffer.from(`\n[claude-agent: stdout log truncated at ${maxBytes} bytes]\n`, 'utf8');

  return {
    append(text) {
      const buffer = Buffer.from(text, 'utf8');
      rawBytes += buffer.length;
      if (logBytes >= maxBytes) {
        truncated = true;
        return;
      }

      const remaining = maxBytes - logBytes;
      if (buffer.length <= remaining) {
        fs.appendFileSync(file, buffer);
        logBytes += buffer.length;
        return;
      }

      truncated = true;
      const markerRoom = remaining > marker.length ? marker.length : remaining;
      const contentRoom = remaining - markerRoom;
      if (contentRoom > 0) {
        fs.appendFileSync(file, buffer.subarray(0, contentRoom));
        logBytes += contentRoom;
      }
      if (markerRoom > 0) {
        fs.appendFileSync(file, marker.subarray(0, markerRoom));
        logBytes += markerRoom;
      }
    },
    summary() {
      return {
        stdoutBytes: rawBytes,
        stdoutLogBytes: logBytes,
        stdoutLogMaxBytes: maxBytes,
        stdoutLogTruncated: truncated,
      };
    },
  };
}

function appendTail(existing, addition, maxChars = 4000) {
  return (existing + addition).slice(-maxChars);
}

function startWorker(runId, wait) {
  if (wait) {
    return runWorker(runId);
  }

  const nodeBin = process.env.CLAUDE_AGENT_NODE_BIN || process.execPath;
  const child = spawn(nodeBin, [THIS_FILE, '__worker', runId], {
    cwd: repoCwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  const runDir = runDirFor(runId);
  updateStatus(runDir, {
    status: 'starting',
    workerPid: child.pid,
    workerSpawnedAt: nowIso(),
  });
  appendEvent(runDir, { type: 'worker_spawned', pid: child.pid, nodeBin });
  child.unref();
  return 0;
}

async function submit(args) {
  const { kind, wait, payload } = parseSubmitArgs(args);
  const request = buildRequest(kind, payload);
  const { runId, runDir } = createRun(kind, request);
  const invocation = claudeInvocationFor(kind, payload);

  const status = updateStatus(runDir, {
    status: 'queued',
    claudeArgs: invocation.args,
    claudeSessionId: invocation.claudeSessionId,
    continuity: invocation.continuity,
    sessionMode: invocation.sessionMode,
    sessionPersistence: invocation.sessionPersistence,
    resumeFrom: invocation.resumeFrom,
    round: invocation.round,
    outputFormat: invocation.args.includes('stream-json') ? 'stream-json' : 'text',
    resultReady: false,
  });

  process.stdout.write(`runId: ${runId}\n`);
  process.stdout.write(`runDir: ${runDir}\n`);
  process.stdout.write(`status: ${status.status}\n`);

  const code = await startWorker(runId, wait);
  if (wait) {
    process.exitCode = code;
  }
}

function runWorker(runId) {
  const runDir = runDirFor(runId);
  const status = readJson(path.join(runDir, STATUS_FILE));
  const request = fs.readFileSync(path.join(runDir, REQUEST_FILE), 'utf8');
  const claudeBin = process.env.CLAUDE_AGENT_CLAUDE_BIN || 'claude';
  const args = status.claudeArgs || claudeInvocationFor(status.kind).args;
  const stdoutPath = path.join(runDir, STDOUT_FILE);
  const stderrPath = path.join(runDir, STDERR_FILE);
  const streamJson = hasStreamJsonOutput(args);
  const streamObserver = streamJson ? createStreamJsonObserver(runDir) : null;
  const stdoutLog = createCappedLogWriter(
    stdoutPath,
    envPositiveInteger('CLAUDE_AGENT_STDOUT_LOG_MAX_BYTES', DEFAULT_STDOUT_LOG_MAX_BYTES),
  );

  updateStatus(runDir, {
    status: 'running',
    pid: process.pid,
    startedAt: nowIso(),
    claudeBin,
    claudeArgs: args,
    outputFormat: streamJson ? 'stream-json' : 'text',
  });
  appendEvent(runDir, { type: 'started', pid: process.pid, claudeBin, args });

  const child = spawn(claudeBin, args, {
    cwd: status.cwd || repoCwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  updateStatus(runDir, { claudePid: child.pid });
  appendEvent(runDir, { type: 'claude_spawned', pid: child.pid });

  const stderr = fs.createWriteStream(stderrPath, { flags: 'a' });
  let stdoutText = '';
  let stderrText = '';
  const heartbeatTimer = setInterval(() => {
    updateStatus(runDir, {
      heartbeatAt: nowIso(),
      status: 'running',
    });
  }, 10_000);
  heartbeatTimer.unref();

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdoutText = appendBounded(stdoutText, text);
    stdoutLog.append(text);
    if (streamObserver) {
      streamObserver.feed(text);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrText = appendTail(stderrText, text);
    stderr.write(text);
  });

  child.on('error', (error) => {
    clearInterval(heartbeatTimer);
    stderr.write(`${error.stack || error.message}\n`);
    updateStatus(runDir, {
      status: 'error',
      error: error.message,
      finishedAt: nowIso(),
      ...stdoutLog.summary(),
    });
    appendEvent(runDir, { type: 'error', message: error.message });
  });

  child.stdin.end(request);

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearInterval(heartbeatTimer);
      stderr.end();
      const currentStatus = fs.existsSync(path.join(runDir, STATUS_FILE))
        ? readJson(path.join(runDir, STATUS_FILE))
        : {};
      const finalStatus = currentStatus.status === 'cancelled'
        ? 'cancelled'
        : (code === 0 ? 'done' : 'error');
      if (streamObserver) {
        streamObserver.flush();
      }
      const resultText = streamObserver ? streamObserver.finalText(stdoutText) : stdoutText;
      fs.writeFileSync(path.join(runDir, RESULT_FILE), resultText, 'utf8');
      const verdict = extractFinalVerdict(resultText);
      const streamSummary = streamObserver ? streamObserver.summary() : {};
      updateStatus(runDir, {
        status: finalStatus,
        exitCode: code,
        signal,
        finishedAt: nowIso(),
        stderrTail: stderrText,
        verdict,
        resultReady: finalStatus === 'done',
        ...stdoutLog.summary(),
        ...streamSummary,
      });
      appendEvent(runDir, { type: 'finished', status: finalStatus, exitCode: code, signal });
      resolve(code ?? 1);
    });
  });
}

function extractFinalVerdict(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return 'UNKNOWN';
  }
  const last = lines[lines.length - 1];
  if (last === 'VERDICT: APPROVED') return 'APPROVED';
  if (last === 'VERDICT: REVISE') return 'REVISE';
  return 'UNKNOWN';
}

function printStatus(runId) {
  const status = readJson(path.join(runDirFor(runId), STATUS_FILE));
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

function printResult(runId) {
  const runDir = runDirFor(runId);
  const resultPath = path.join(runDir, RESULT_FILE);
  if (!fs.existsSync(resultPath)) {
    const status = readJson(path.join(runDir, STATUS_FILE));
    process.stderr.write(`Result not ready. status=${status.status}\n`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(resultPath, 'utf8'));
}

function printVerdict(runId) {
  const runDir = runDirFor(runId);
  const status = readJson(path.join(runDir, STATUS_FILE));
  if (!fs.existsSync(path.join(runDir, RESULT_FILE))) {
    process.stderr.write(`Result not ready. status=${status.status}\n`);
    process.exit(1);
  }
  process.stdout.write(`${status.verdict || 'UNKNOWN'}\n`);
  if ((status.verdict || 'UNKNOWN') === 'UNKNOWN') {
    process.exitCode = 1;
  }
}

function tail(runId, args) {
  const lineIndex = args.indexOf('--lines');
  const lineCount = lineIndex >= 0 ? Number.parseInt(args[lineIndex + 1], 10) : 80;
  const runDir = runDirFor(runId);
  const files = [STDERR_FILE, STDOUT_FILE].map((name) => path.join(runDir, name));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(-lineCount);
    process.stdout.write(`--- ${path.basename(file)} ---\n${lines.join('\n')}\n`);
  }
}

function listRuns() {
  const root = runsRoot();
  if (!fs.existsSync(root)) {
    return;
  }
  const rows = fs.readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, STATUS_FILE)))
    .map((name) => readJson(path.join(root, name, STATUS_FILE)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  for (const row of rows) {
    process.stdout.write(`${row.runId}\t${row.status}\t${row.kind}\t${row.updatedAt}\n`);
  }
}

function terminalStatus(status) {
  return ['done', 'error', 'cancelled'].includes(status);
}

function signalPid(pid, signal = 'SIGTERM') {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { pid, signal, ok: false, skipped: true, reason: 'invalid_pid' };
  }
  if (numeric === process.pid) {
    return { pid: numeric, signal, ok: false, skipped: true, reason: 'current_process' };
  }
  try {
    process.kill(numeric, signal);
    return { pid: numeric, signal, ok: true };
  } catch (error) {
    if (error.code === 'ESRCH') {
      return { pid: numeric, signal, ok: false, reason: 'not_found' };
    }
    return { pid: numeric, signal, ok: false, reason: error.code || error.message };
  }
}

function cancelRun(runId) {
  if (!runId) usage();
  const runDir = runDirFor(runId);
  const statusPath = path.join(runDir, STATUS_FILE);
  if (!fs.existsSync(statusPath)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const status = readJson(statusPath);
  if (status.cwd && fs.realpathSync(status.cwd) !== repoCwd()) {
    throw new Error(`Run cwd does not match --cwd: ${status.cwd}`);
  }
  if (terminalStatus(status.status)) {
    process.stdout.write(`runId: ${runId}\nstatus: ${status.status}\n`);
    process.exitCode = status.status === 'cancelled' ? 0 : 1;
    return;
  }

  const pids = [...new Set([status.claudePid, status.pid, status.workerPid].filter(Boolean).map(Number))];
  const signals = pids.map((pid) => signalPid(pid));
  updateStatus(runDir, {
    status: 'cancelled',
    cancelledAt: nowIso(),
    finishedAt: nowIso(),
    resultReady: false,
    cancelSignals: signals,
  });
  appendEvent(runDir, { type: 'cancelled', signals });
  process.stdout.write(`runId: ${runId}\nstatus: cancelled\n`);
}

function processExists(pid) {
  if (!pid || !Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    return null;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function printAwaitSummary(status) {
  const fields = [
    ['runId', status.runId],
    ['status', status.status],
    ['kind', status.kind],
    ['resultReady', status.resultReady],
    ['exitCode', status.exitCode],
    ['verdict', status.verdict],
    ['result', status.result],
    ['lastClaudeEventAt', status.lastClaudeEventAt],
    ['lastClaudeEventType', status.lastClaudeEventType],
    ['claudeEventCount', status.claudeEventCount],
    ['toolUseCount', status.toolUseCount],
    ['heartbeatAt', status.heartbeatAt],
    ['cancelReason', status.cancelReason],
    ['updatedAt', status.updatedAt],
    ['finishedAt', status.finishedAt],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined && value !== null) {
      process.stdout.write(`${key}: ${value}\n`);
    }
  }
}

function readStatusForAwait(runId) {
  const runDir = runDirFor(runId);
  const statusPath = path.join(runDir, STATUS_FILE);
  if (!fs.existsSync(statusPath)) {
    throw new Error(`Run not found: ${runId}`);
  }
  return readJson(statusPath);
}

function signalProcess(pid, signal = 'SIGTERM') {
  const numericPid = Number(pid || 0);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, signal);
    return true;
  } catch {
    return false;
  }
}

function cancelRunFromAwait(runId, status, reason) {
  const runDir = runDirFor(runId);
  const killed = [
    ['claudePid', status.claudePid],
    ['pid', status.pid],
    ['workerPid', status.workerPid],
  ]
    .map(([name, pid]) => ({ name, pid, signalled: signalProcess(pid) }))
    .filter((entry) => entry.pid);
  updateStatus(runDir, {
    status: 'cancelled',
    cancelledAt: nowIso(),
    cancelReason: reason,
    resultReady: false,
  });
  appendEvent(runDir, {
    type: 'await_cancelled',
    reason,
    killed,
  });
  return killed;
}

async function awaitRun(runId, args) {
  if (!runId) usage();
  const intervalSeconds = optionNumber(args, '--interval', 30);
  const maxMinutes = optionNumber(args, '--max-minutes', 30);
  const staleSeconds = optionNumber(args, '--stale-seconds', 300);
  const claudeIdleSeconds = optionNumberFromEnv(
    args,
    '--claude-idle-seconds',
    'CLAUDE_AGENT_CLAUDE_IDLE_SECONDS',
    DEFAULT_CLAUDE_IDLE_SECONDS,
  );
  const cancelOnIdle = hasOption(args, '--cancel-on-idle');
  const cancelOnTimeout = hasOption(args, '--cancel-on-timeout');
  const deadline = Date.now() + maxMinutes * 60_000;
  let lastStatus = null;

  while (Date.now() <= deadline) {
    lastStatus = readStatusForAwait(runId);
    if (terminalStatus(lastStatus.status)) {
      printAwaitSummary(lastStatus);
      process.exitCode = lastStatus.status === 'done' ? 0 : 1;
      return;
    }

    const pid = lastStatus.pid || lastStatus.workerPid;
    const alive = processExists(pid);
    const lastBeat = timestampMs(lastStatus.heartbeatAt) || timestampMs(lastStatus.updatedAt);
    const stale = lastBeat ? Date.now() - lastBeat > staleSeconds * 1000 : false;
    if (alive === false && stale) {
      process.stderr.write(`Run appears stale: status=${lastStatus.status} pid=${pid} heartbeatAt=${lastStatus.heartbeatAt || 'n/a'} updatedAt=${lastStatus.updatedAt || 'n/a'}\n`);
      printAwaitSummary(lastStatus);
      process.exitCode = 3;
      return;
    }

    const lastClaudeEvent = timestampMs(lastStatus.lastClaudeEventAt);
    const claudeIdle = claudeIdleSeconds > 0 && lastClaudeEvent
      ? Date.now() - lastClaudeEvent > claudeIdleSeconds * 1000
      : false;
    if (claudeIdle) {
      const idleForSeconds = Math.round((Date.now() - lastClaudeEvent) / 1000);
      const reason = `No Claude stream events for ${idleForSeconds}s (lastClaudeEventType=${lastStatus.lastClaudeEventType || 'n/a'})`;
      process.stderr.write(`${reason}\n`);
      if (cancelOnIdle) {
        cancelRunFromAwait(runId, lastStatus, reason);
        lastStatus = readStatusForAwait(runId);
      }
      printAwaitSummary(lastStatus);
      process.exitCode = 124;
      return;
    }

    await sleep(intervalSeconds * 1000);
  }

  const timeoutReason = `Timed out waiting for run: ${runId}`;
  process.stderr.write(`${timeoutReason}\n`);
  if (lastStatus && cancelOnTimeout && !terminalStatus(lastStatus.status)) {
    cancelRunFromAwait(runId, lastStatus, timeoutReason);
    lastStatus = readStatusForAwait(runId);
  }
  if (lastStatus) {
    printAwaitSummary(lastStatus);
  }
  process.exitCode = 124;
}

function makeCheck(name, fn) {
  try {
    const detail = fn();
    return { name, ok: true, detail };
  } catch (error) {
    return { name, ok: false, error: error.message };
  }
}

function doctorRunsRootDetail() {
  const configured = process.env.CLAUDE_AGENT_RUNS_DIR || DEFAULT_RUNS_DIR;
  const root = path.resolve(repoCwd(), configured);
  assertInsidePath(repoCwd(), root, 'Runs directory is outside current working directory');
  if (!fs.existsSync(root)) {
    return { root, exists: false };
  }
  const realRoot = fs.realpathSync(root);
  assertInsidePath(repoCwd(), realRoot, 'Runs directory resolves outside current working directory');
  return { root, realRoot, exists: true };
}

function doctorClaudeHelpDetail() {
  const claudeBin = process.env.CLAUDE_AGENT_CLAUDE_BIN || 'claude';
  const result = spawnSync(claudeBin, ['--help'], {
    cwd: repoCwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`claude --help exited ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const requiredNeedles = [
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--allowedTools',
    '--tools',
    '--session-id',
    '--resume',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--disallowedTools',
  ];
  const missing = requiredNeedles.filter((needle) => !help.includes(needle));
  if (missing.length > 0) {
    throw new Error(`claude --help missing required flags: ${missing.join(', ')}`);
  }
  return { claudeBin, requiredFlags: requiredNeedles };
}

function doctorReport() {
  const claudeBin = process.env.CLAUDE_AGENT_CLAUDE_BIN || 'claude';
  const readTools = readOnlyTools();
  const deniedTools = disallowedTools();
  const checks = [
    makeCheck('cwd', () => {
      const cwd = repoCwd();
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error('cwd is not a directory');
      }
      return cwd;
    }),
    makeCheck('node', () => ({ version: process.versions.node, execPath: process.execPath })),
    makeCheck('runsRoot', doctorRunsRootDetail),
    makeCheck('claudeHelp', doctorClaudeHelpDetail),
    makeCheck('readTools', () => {
      if (!readTools.trim()) {
        throw new Error('CLAUDE_AGENT_READ_TOOLS is empty');
      }
      return readTools;
    }),
    makeCheck('disallowedTools', () => deniedTools),
  ];
  return {
    ok: checks.every((check) => check.ok),
    cwd: repoCwd(),
    runsRoot: path.resolve(repoCwd(), process.env.CLAUDE_AGENT_RUNS_DIR || DEFAULT_RUNS_DIR),
    claudeBin,
    readTools,
    disallowedTools: deniedTools,
    checks,
  };
}

function printDoctor(args) {
  const asJson = args.includes('--json');
  const report = doctorReport();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`doctor: ${report.ok ? 'ok' : 'failed'}\n`);
    process.stdout.write(`cwd: ${report.cwd}\n`);
    process.stdout.write(`runsRoot: ${report.runsRoot}\n`);
    process.stdout.write(`claudeBin: ${report.claudeBin}\n`);
    process.stdout.write(`readTools: ${report.readTools}\n`);
    process.stdout.write(`disallowedTools: ${report.disallowedTools}\n`);
    for (const check of report.checks) {
      process.stdout.write(`${check.ok ? 'OK' : 'FAIL'} ${check.name}`);
      if (check.ok && check.detail !== undefined) {
        process.stdout.write(` ${JSON.stringify(check.detail)}`);
      }
      if (!check.ok) {
        process.stdout.write(` ${check.error}`);
      }
      process.stdout.write('\n');
    }
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  while (argv[0] === '--cwd') {
    if (!argv[1]) usage();
    setRepoCwd(argv[1]);
    argv.splice(0, 2);
  }

  const [command, ...args] = argv;
  if (command === 'submit') return await submit(args);
  if (command === '__worker') {
    const runId = args[0];
    if (!runId) usage();
    process.exitCode = await runWorker(runId);
    return;
  }
  if (command === 'status') return printStatus(args[0] || usage());
  if (command === 'result') return printResult(args[0] || usage());
  if (command === 'verdict') return printVerdict(args[0] || usage());
  if (command === 'tail') return tail(args[0] || usage(), args.slice(1));
  if (command === 'list') return listRuns();
  if (command === 'await') return await awaitRun(args[0] || usage(), args.slice(1));
  if (command === 'cancel') return cancelRun(args[0] || usage());
  if (command === 'doctor') return printDoctor(args);
  usage();
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = process.exitCode || 1;
}
