# Claude Subagent Skill for Codex

[简体中文](./README.zh-CN.md)

Use local Claude CLI as a read-only Codex subagent for second-opinion reviews, code exploration, and same-session grilling.

This repository is a Codex skill folder. Clone it directly into your skills directory so `SKILL.md`, `agents/`, and `scripts/` stay at the repository root.

## Features

- `submit -> await -> result` workflow for long Claude jobs.
- `review-working-tree` covers `git status`, unstaged diff, staged diff, and safe small untracked text files.
- `review-commit` embeds committed patches automatically, avoiding review packets that ask Claude to inspect a diff it cannot see.
- `stream-json` observability: events, tool counts, heartbeat, and result readiness are written to `.claude-runs/<run-id>/status.json`.
- `cancel <run-id>` terminates recorded `claudePid`, worker `pid`, and `workerPid`.
- Raw `stdout.log` has a byte cap while the stream parser still receives full stdout.
- Review/explore runs keep Claude local session history by default, so IDE integrations such as the Claude VSCode plugin can show the conversations.
- Claude tools are constrained for reviews/exploration; Claude `Skill` is denied by default to avoid hidden token-heavy skill loads.

## Natural language invocation

After installation, users do not need to type the runner commands directly. In Codex, ask for Claude naturally; Codex should load this skill and translate the request into `submit -> await -> result`.

Examples:

| User says | Typical mode |
| --- | --- |
| "Use Claude to review the current changes." | `review-working-tree` |
| "Ask Claude for a second opinion on this diff." | `review-working-tree` or `review-diff` |
| "Use Claude to review the last commit." | `review-commit HEAD` |
| "Use Claude to review `docs/plan.md`." | `review-plan` or `review-file` |
| "Have Claude explore where login is implemented." | `explore` |
| "Let Claude challenge/grill this architecture plan." | `grill-plan` |
| "Continue the Claude grill from the previous run." | `grill-* --resume-from` |
| "Check the Claude subagent progress." | `status` / `await` |
| "Show me the Claude review result." | `result` |
| "Cancel that Claude review." | `cancel` |

Chinese examples also work, such as: "用 Claude 评审当前改动", "让 Claude explore 登录流程", "让 Claude 连续质询这个方案", "看一下 Claude 子代理进度", "取消刚才的 Claude 任务".

## Requirements

- Node.js 22+
- Claude CLI available as `claude`
- Git for diff/working-tree review modes

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/Cooperhgp/claude-subagent-skill.git ~/.agents/skills/claude-subagent
```

If you use a different Codex skills directory, clone this repository as a folder named `claude-subagent`.

## Quick start

```bash
SCRIPT="$HOME/.agents/skills/claude-subagent/scripts/claude-agent.mjs"

node "$SCRIPT" --cwd /path/to/project doctor

node "$SCRIPT" --cwd /path/to/project submit review-working-tree
node "$SCRIPT" --cwd /path/to/project await <run-id> --interval 30 --max-minutes 25 --claude-idle-seconds 420
node "$SCRIPT" --cwd /path/to/project result <run-id>
```

For already committed work, use `review-commit HEAD` or `review-commit HEAD --base origin/main`; it embeds the patch in the request. For large/noisy working trees, create a concise review packet and use `review-file` instead of repeatedly waiting on a broad review, but include any referenced unified diff in a fenced `diff` block. If bounded `await` reports idle/timeout while the run is still `running`, inspect `status`/`tail` first; cancel only when you intentionally want to stop Claude.

## Common commands

```bash
# Review
node "$SCRIPT" --cwd /path/to/project submit review-working-tree
node "$SCRIPT" --cwd /path/to/project submit review-diff
node "$SCRIPT" --cwd /path/to/project submit review-commit HEAD
node "$SCRIPT" --cwd /path/to/project submit review-commit HEAD --base origin/main
node "$SCRIPT" --cwd /path/to/project submit review-file path/to/file
node "$SCRIPT" --cwd /path/to/project submit review-plan path/to/plan.md

# Explore
node "$SCRIPT" --cwd /path/to/project submit explore "where is X implemented?"

# Same-session grill
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md --round 1
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md --round 2 --resume-from <previous-run-id>

# Inspect
node "$SCRIPT" --cwd /path/to/project list
node "$SCRIPT" --cwd /path/to/project status <run-id>
node "$SCRIPT" --cwd /path/to/project await <run-id> --interval 30 --max-minutes 25 --claude-idle-seconds 420
node "$SCRIPT" --cwd /path/to/project tail <run-id> --lines 80
node "$SCRIPT" --cwd /path/to/project verdict <run-id>

# Cancel
node "$SCRIPT" --cwd /path/to/project cancel <run-id>
```

Review commands deliberately reject bare `--wait` to avoid tying up Codex tool calls on large reviews. Use `submit -> await -> result`. For tiny smoke tests only, pass `--wait --wait-ok`.

Review and explore runs persist Claude local session history by default. If you want a one-off run that does not appear in Claude local history, pass `--no-persist` or set `CLAUDE_AGENT_NO_SESSION_PERSISTENCE=1`.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_AGENT_RUNS_DIR` | `.claude-runs` | Run state directory under `--cwd`. |
| `CLAUDE_AGENT_CLAUDE_BIN` | `claude` | Claude CLI binary. |
| `CLAUDE_AGENT_NODE_BIN` | current Node | Node binary for detached workers. |
| `CLAUDE_AGENT_READ_TOOLS` | `Read,Grep,Glob,LS` | Tools allowed for explore/grill. |
| `CLAUDE_AGENT_DISALLOWED_TOOLS` | `Skill` | Tools denied for all Claude invocations. |
| `CLAUDE_AGENT_NO_SESSION_PERSISTENCE` | unset | Set to `1`, `true`, `yes`, or `on` to opt out of Claude local history for review/explore. |
| `CLAUDE_AGENT_UNTRACKED_MAX_BYTES` | `65536` | Max bytes per untracked text file in `review-working-tree`. |
| `CLAUDE_AGENT_STDOUT_LOG_MAX_BYTES` | `1048576` | Max raw `stdout.log` bytes before truncation. |
| `CLAUDE_AGENT_CLAUDE_IDLE_SECONDS` | unset | Seconds without Claude stream events before `await` returns non-zero with `No Claude stream events`. |

## Safety model

- `--cwd` is the security boundary.
- Run IDs must match a strict generated pattern.
- `.claude-runs` must resolve inside `--cwd`; unsafe symlinks are rejected.
- Review modes disable Claude tools.
- Explore/grill modes allow only configured read tools and deny Claude `Skill` by default.
- Review/explore persist Claude local session history by default; use `--no-persist` only for sensitive one-off runs.
- Claude output is a signal, not ground truth; verify important findings against source/tests.
- Do not delegate commits, pushes, deploys, migrations, billing/auth changes, destructive commands, or secret handling automatically.

## Development

```bash
node --test scripts/claude-agent.test.mjs
node --check scripts/claude-agent.mjs
python3 /path/to/quick_validate.py .
```

## References and inspiration

- [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex) — inspiration for cross-model review/grilling loops. This project applies the inverse control model: Codex remains the controller, while Claude CLI acts as a bounded read-only reviewer/explorer.

## License

MIT
