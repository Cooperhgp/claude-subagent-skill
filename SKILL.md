---
name: claude-subagent
description: Use when the user asks Codex to use Claude, Claude CLI, Claude as a subagent, one-pass review, second-opinion review, continuous grilling/challenge, architecture review, code review, diff review, plan review, or read-only code exploration across any project.
---

# Claude Subagent

Use local Claude CLI as an external read-only reviewer/interviewer while Codex stays the controller. The skill is global: always pass the target project with `--cwd` so `.claude-runs/` lands in that project, not in the skill directory.

Natural language triggers:

- “用 Claude explore/探索这块代码”
- “用 Claude review/评审当前改动/diff/working tree”
- “用 Claude review/评审这个文件/文档/方案”
- “请 Claude 给这个方案/代码做 second opinion/二审”
- “用 Claude review 当前 diff/改动”
- “用 Claude review 刚才的 commit/已提交改动/HEAD”
- “让 Claude 连续质询/挑战这个方案”
- “继续上一轮 Claude grill/质询”
- “看一下 Claude 子代理进度/结果”
- “取消刚才那个 Claude review/子代理任务”

## Review vs Grill

| Need | Use | Meaning |
| --- | --- | --- |
| “有没有 bug / 风险？” | `review-*` | One-pass review: judge an existing file, plan, or diff. |
| “连续追问直到站得住？” | `grill-*` | Multi-round questioning: same Claude session challenges assumptions over rounds. |
| “这块代码在哪/怎么工作？” | `explore` | Read-only code exploration. |

Review is “判卷子”. Grill is “答辩”.

## Runner

```bash
SCRIPT="$HOME/.agents/skills/claude-subagent/scripts/claude-agent.mjs"
node "$SCRIPT" --cwd /path/to/project doctor
node "$SCRIPT" --cwd /path/to/project submit review-working-tree
node "$SCRIPT" --cwd /path/to/project submit review-diff
node "$SCRIPT" --cwd /path/to/project submit review-commit HEAD
node "$SCRIPT" --cwd /path/to/project submit review-commit HEAD --base origin/main
node "$SCRIPT" --cwd /path/to/project submit review-file path/to/file
node "$SCRIPT" --cwd /path/to/project submit review-plan path/to/plan.md
node "$SCRIPT" --cwd /path/to/project submit grill-plan path/to/plan.md --round 1
node "$SCRIPT" --cwd /path/to/project submit grill-diff --round 1
node "$SCRIPT" --cwd /path/to/project submit explore "where is X implemented?"
```

If `node` is missing, use the project/runtime Node available in the environment.

`--cwd` is the security boundary. File/log targets must resolve inside that cwd; run IDs are strict generated IDs only.
Explore/grill default to `Read,Grep,Glob,LS`; opt into project MCP tools only when you know Claude MCP is configured and read-only, e.g. `CLAUDE_AGENT_READ_TOOLS='Read,Grep,Glob,LS,mcp__codebase-memory-mcp__*'`.
Claude skills/slash commands are disabled by default and `Skill` is denied, because they can silently load large bundled docs and waste tokens during reviews.
Review/explore runs keep Claude local session history by default so IDE integrations can show them. Use `--no-persist` or `CLAUDE_AGENT_NO_SESSION_PERSISTENCE=1` only for sensitive one-off review/explore runs. Do not use `--no-persist` with `grill-*`; same-session grilling requires persisted Claude sessions.

Inspect jobs:

```bash
node "$SCRIPT" --cwd /path/to/project list
node "$SCRIPT" --cwd /path/to/project status <run-id>
node "$SCRIPT" --cwd /path/to/project await <run-id> --interval 30 --max-minutes 25 --claude-idle-seconds 420
node "$SCRIPT" --cwd /path/to/project result <run-id>
node "$SCRIPT" --cwd /path/to/project verdict <run-id>
node "$SCRIPT" --cwd /path/to/project tail <run-id> --lines 80
node "$SCRIPT" --cwd /path/to/project cancel <run-id>
```

Use `doctor` before the first run or after changing Claude/Codex configuration. It is read-only and verifies the local Node runtime, Claude CLI help flags, `cwd`, runs-root symlink safety, and read-tool allowlist.

## Fast Review Policy

Claude review should be bounded. Do not let Codex narrate repeated “still running” updates while waiting for the same run.

Review output should also be short. The runner tells Claude to return only `VERDICT: BLOCKED / OK / UNSURE` plus at most 3 high-confidence blockers, each at most 2 lines with minimal evidence. Do not ask Claude for comprehensive essays unless the user explicitly requests deep review.

## Silent Await Policy

While a Claude job is awaiting, Codex should stay quiet to avoid wasting tokens. Speak only at these user-facing checkpoints: submit, terminal result, or actionable exception. Do not narrate periodic waiting updates such as “still running”, “waiting again”, or “no output yet”. A routine `await` loop/status poll is not a user-facing event. If a long wait is expected, say once that the job is queued and bounded, then wait silently until the command returns.

## Minimum Patience Rule

Do not cancel, shrink, or resubmit a Claude job before the first 25-minute await finishes when `status` is `running` and heartbeat or Claude event counters are moving. Idle text output is not failure. Only cancel before 25 minutes when the process is gone, `status` is terminal/error, or the user explicitly asks to stop it.

Default fast path:

1. Scope first: use `review-working-tree` for uncommitted work; use `review-commit` for already committed or merged work; prefer a generated `review-file` packet containing the exact diff/files/question when the scope needs plan context or hand-picked snippets.
2. Submit in background.
3. Run one patient, bounded wait: `await <run-id> --interval 30 --max-minutes 25 --claude-idle-seconds 420`.
4. If done, call `result <run-id>` once.
5. If idle/timeout returns while status is still `running`, do not immediately kill Claude. If the first 25-minute await has not completed and heartbeat/events are moving, continue waiting silently. After the first 25-minute await, inspect `status`/`tail`; either wait one more bounded window, or explicitly `cancel` only when the user is blocked and the stream is clearly stale.

Use `await` for long jobs. It waits inside one local Node process by reading `status.json`; it does not ask Codex/Claude for progress and does not print the full result body. For review/explore jobs, include `--claude-idle-seconds 420` so Codex can surface a stale stream, but do not include `--cancel-on-idle` or `--cancel-on-timeout` by default. Add those cancel flags only when you intentionally want to stop Claude. After `await` returns `status: done`, call `result <run-id>` once.

Review, grill, and explore jobs all use Claude `stream-json`. For progress, inspect `status <run-id>` fields such as `lastClaudeEventAt`, `claudeEventCount`, `toolUseCount`, and `resultReady`; use `tail` only for raw stdout/stderr diagnostics.

Prefer `review-working-tree` for small, clean code reviews: it includes `git status`, unstaged diff, staged diff, and small safe untracked text files. Use `review-commit HEAD` after a change is already committed; pass `--base <ref>` for a branch/range review. Use `review-diff` only when you deliberately want unstaged `git diff` scope. For large or messy diffs, prepare a concise packet and use `review-file` so Claude sees only the relevant files, invariants, and questions. A `review-file` packet that asks Claude to inspect `git diff`, `git show`, `HEAD^..HEAD`, or a commit must embed the unified diff in a fenced `diff` block; otherwise the runner rejects it. Review commands deliberately reject bare `--wait` to avoid tying up a Codex tool call while Claude reviews large diffs. Use `submit -> bounded await -> result`. Only use `--wait --wait-ok` for tiny local smoke tests.

If a review/explore job times out or goes idle while still `running`, do not keep saying “still running” in chat, but also do not kill it automatically. Before the first 25-minute await completes, a healthy `running` process must keep running. After that window, inspect `status`: if `lastClaudeEventAt` is stale and `claudeEventCount` is not growing, decide between one more patient await, `tail` diagnostics, or explicit `cancel`. Common fixes for the next run are: use `review-commit` for committed work; use `review-file` on a generated review packet instead of broad `explore`; cap the packet to critical files; ask for top blockers only; avoid asking Claude to infer implementation status from an unbounded working tree.

## Review Results Are Inputs

Claude review output is for Codex to consume, not a final user-facing answer. Do not paste raw Claude output as the conclusion. Codex must read each finding, verify it against source/tests, then report a triage:

- `accepted`: verified as real and in scope; fix it, then run the smallest relevant check.
- `rejected`: contradicted by source, tests, project rules, or current scope; explain the technical reason.
- `needs_user_decision`: product behavior, UX preference, public API, auth/billing/permission, migration, destructive data, production deploy, secrets, or architecture tradeoff; ask the user before changing.
- `deferred`: plausible but non-blocking or outside the current request; do not expand scope silently.

## Post-Review Handling

After reading a Claude review result, Codex should triage findings before replying to the user:

- `clearly actionable`: high-confidence bugs or regressions that are directly supported by the diff/source/tests, such as failing checks, type errors, null/undefined crashes, broken imports, ownership/auth leaks, data isolation violations, resource leaks, missing error handling on an already-required path, or explicit project invariant violations. Codex may fix these directly without asking the user for a second confirmation, then run the smallest relevant verification.
- `needs user decision`: product behavior changes, UI/UX preference calls, broad architecture rewrites, public API contract changes, auth/billing/permission model changes, migrations, destructive data operations, production deploys, secrets, or anything whose correct answer depends on business intent. Ask the user before changing these.
- `uncertain/disagree`: findings that are speculative, stale, contradicted by source, outside scope, or materially expensive/risky relative to the current task. Do not blindly apply them; verify source facts and either explain why they are not being changed or ask a focused question.

Default behavior after a review is: fix `clearly actionable` issues, skip or ask about the rest, and report which Claude suggestions were accepted, rejected, or deferred. Claude output is evidence, not authority; Codex remains responsible for source verification, code changes, and final checks.

## Same-Session Grill

`grill-*` starts or resumes a persistent Claude session. This is what preserves context between rounds.

Round 1:

```bash
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md --round 1 --wait
node "$SCRIPT" --cwd /path/to/project status <run-id>
```

Read `claudeSessionId` from `status.json` / `status <run-id>`.

Round 2+:

```bash
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md \
  --round 2 \
  --resume-from <previous-run-id> \
  --log path/to/review-log.md \
  --wait
```

Rules:

- Prefer `--resume-from <previous-run-id>` so the runner reuses the prior `claudeSessionId`.
- Use `--claude-session-id <claudeSessionId>` only when manually resuming a known Claude session; the runner passes it to Claude as `--resume`, not as a fresh `--session-id`.
- `--round 2+` requires `--resume-from` or `--claude-session-id`; otherwise it is rejected to avoid accidental new-session “resume”.
- Append each Claude question and Codex response to a review log.
- Codex decides what to accept/reject, updates the plan/log, then resumes the same Claude session.
- Stop on `VERDICT: APPROVED` or a user/max-round cap. If capped with unresolved issues, surface the disagreement; do not fake approval.

`debate-*` is a backward-compatible alias; prefer `grill-*` in new work.

## Safety

- Review modes disable Claude tools but still use `stream-json` for observable progress.
- Grill/explore allow only read-oriented tools where available and disable Claude skills/slash commands to avoid hidden token spikes.
- Review/explore keep Claude local session history by default; `--no-persist` is an explicit opt-out.
- Inspect `status`, `events.jsonl`, and `tail` for progress instead of assuming a long silent run is stuck; use `cancel <run-id>` to stop a queued/running job.
- `status.json` records `status`, `workerPid`, `pid`, `claudePid`, `heartbeatAt`, `claudeSessionId`, `resultReady`, event/tool counters, stdout log truncation fields, and final `verdict`.
- Claude output is a signal, not ground truth. Codex must verify important claims against source/tests before acting.
- Codex may automatically fix `clearly actionable` review findings as defined above, but must still keep the patch scoped and verified.
- Do not delegate commit, push, deploy, migration, billing/auth changes, destructive commands, or secret handling to Claude automatically.
- For review jobs and other long jobs, submit in background, run the full first `await <run-id> --max-minutes 25 --claude-idle-seconds 420`, then inspect `status` or `result`; do not stream/poll continuously in chat. Only add `--cancel-on-idle` / `--cancel-on-timeout` after the first 25-minute await, unless the process is gone, terminal/error, or the user explicitly asks to stop it. Bare `submit review-* --wait` is rejected; `--wait-ok` is an explicit escape hatch.
