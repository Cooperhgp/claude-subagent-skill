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

Inspect jobs:

```bash
node "$SCRIPT" --cwd /path/to/project list
node "$SCRIPT" --cwd /path/to/project status <run-id>
node "$SCRIPT" --cwd /path/to/project await <run-id> --interval 30 --max-minutes 20
node "$SCRIPT" --cwd /path/to/project result <run-id>
node "$SCRIPT" --cwd /path/to/project verdict <run-id>
node "$SCRIPT" --cwd /path/to/project tail <run-id> --lines 80
node "$SCRIPT" --cwd /path/to/project cancel <run-id>
```

Use `doctor` before the first run or after changing Claude/Codex configuration. It is read-only and verifies the local Node runtime, Claude CLI help flags, `cwd`, runs-root symlink safety, and read-tool allowlist.

Use `await` for long jobs. It waits inside one local Node process by reading `status.json`; it does not ask Codex/Claude for progress and does not print the full result body. After `await` returns `status: done`, call `result <run-id>` once.

Review, grill, and explore jobs all use Claude `stream-json`. For progress, inspect `status <run-id>` fields such as `lastClaudeEventAt`, `claudeEventCount`, `toolUseCount`, and `resultReady`; use `tail` only for raw stdout/stderr diagnostics.

Prefer `review-working-tree` for code review: it includes `git status`, unstaged diff, staged diff, and small safe untracked text files. Use `review-diff` only when you deliberately want unstaged `git diff` scope. Review commands deliberately reject bare `--wait` to avoid tying up a Codex tool call while Claude reviews large diffs. Use `submit -> await -> result`. Only use `--wait --wait-ok` for tiny local smoke tests.

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
- Use `--claude-session-id <claudeSessionId>` only when manually resuming a known Claude session.
- `--round 2+` requires `--resume-from` or `--claude-session-id`; otherwise it is rejected to avoid accidental new-session “resume”.
- Append each Claude question and Codex response to a review log.
- Codex decides what to accept/reject, updates the plan/log, then resumes the same Claude session.
- Stop on `VERDICT: APPROVED` or a user/max-round cap. If capped with unresolved issues, surface the disagreement; do not fake approval.

`debate-*` is a backward-compatible alias; prefer `grill-*` in new work.

## Safety

- Review modes disable Claude tools but still use `stream-json` for observable progress.
- Grill/explore allow only read-oriented tools where available and disable Claude skills/slash commands to avoid hidden token spikes.
- Inspect `status`, `events.jsonl`, and `tail` for progress instead of assuming a long silent run is stuck; use `cancel <run-id>` to stop a queued/running job.
- `status.json` records `status`, `workerPid`, `pid`, `claudePid`, `heartbeatAt`, `claudeSessionId`, `resultReady`, event/tool counters, stdout log truncation fields, and final `verdict`.
- Claude output is a signal, not ground truth. Codex must verify important claims against source/tests before acting.
- Do not delegate commit, push, deploy, migration, billing/auth changes, destructive commands, or secret handling to Claude automatically.
- For review jobs and other long jobs, submit in background, run `await <run-id>` once, then inspect `result`; do not stream/poll continuously in chat. Bare `submit review-* --wait` is rejected; `--wait-ok` is an explicit escape hatch.
