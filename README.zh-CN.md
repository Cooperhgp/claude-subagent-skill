# Claude Subagent Skill for Codex

[English](./README.md)

把本地 Claude CLI 作为 Codex 控制下的只读子代理，用于二次评审、代码探索、方案质询和长任务审查。

这个仓库本身就是一个 Codex skill 文件夹。安装时请把仓库直接 clone 到 skills 目录下，保持 `SKILL.md`、`agents/`、`scripts/` 位于 skill 根目录。

## 适合解决什么问题

- Codex 想让 Claude 做一次独立代码评审，但不想让 Claude 直接改文件。
- 当前 diff / working tree 比较大，希望用后台任务跑 Claude，不占住 Codex 工具调用。
- 需要 `submit -> await -> result` 这种可恢复、可观察的长任务协议。
- 需要同一个 Claude session 连续追问方案，也就是 `grill-*`。
- 想保留 Codex 主控：提交、推送、部署、迁移、鉴权/计费等高风险动作仍由 Codex/用户决定。

## 功能特性

- `submit -> await -> result`：长任务后台执行，Codex 不需要在中间反复请求大模型。
- `review-working-tree`：覆盖 `git status`、未暂存 diff、已暂存 diff，以及安全的小型 untracked 文本文件。
- `stream-json` 可观测性：事件数、工具调用数、heartbeat、结果状态都会写入 `.claude-runs/<run-id>/status.json`。
- `cancel <run-id>`：停止记录到的 `claudePid`、worker `pid`、`workerPid`。
- `stdout.log` 有大小上限；即使原始日志被截断，stream-json parser 仍接收完整 stdout。
- 默认禁用 Claude `Skill` 工具，避免 Claude 在评审中自动加载大体量 skill 文档造成隐藏 token 消耗。

## 环境要求

- Node.js 22+
- 本机已安装 Claude CLI，并能通过 `claude` 命令调用
- Git，用于 diff / working tree 评审

## 安装

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/Cooperhgp/claude-subagent-skill.git ~/.agents/skills/claude-subagent
```

如果你的 Codex skills 目录不同，请把仓库 clone 成名为 `claude-subagent` 的文件夹。

## 快速开始

```bash
SCRIPT="$HOME/.agents/skills/claude-subagent/scripts/claude-agent.mjs"

node "$SCRIPT" --cwd /path/to/project doctor

node "$SCRIPT" --cwd /path/to/project submit review-working-tree
node "$SCRIPT" --cwd /path/to/project await <run-id>
node "$SCRIPT" --cwd /path/to/project result <run-id>
```

推荐用 `review-working-tree` 做代码评审，因为它比 `review-diff` 范围完整：会同时看未暂存、已暂存和小型 untracked 文本文件。

## 常用命令

```bash
# 评审
node "$SCRIPT" --cwd /path/to/project submit review-working-tree
node "$SCRIPT" --cwd /path/to/project submit review-diff
node "$SCRIPT" --cwd /path/to/project submit review-file path/to/file
node "$SCRIPT" --cwd /path/to/project submit review-plan path/to/plan.md

# 只读探索
node "$SCRIPT" --cwd /path/to/project submit explore "where is X implemented?"

# 同 session 连续质询
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md --round 1
node "$SCRIPT" --cwd /path/to/project submit grill-plan plan.md --round 2 --resume-from <previous-run-id>

# 查看任务
node "$SCRIPT" --cwd /path/to/project list
node "$SCRIPT" --cwd /path/to/project status <run-id>
node "$SCRIPT" --cwd /path/to/project tail <run-id> --lines 80
node "$SCRIPT" --cwd /path/to/project verdict <run-id>

# 取消任务
node "$SCRIPT" --cwd /path/to/project cancel <run-id>
```

评审命令会拒绝裸 `--wait`，避免大型评审长时间占住 Codex 工具调用。推荐统一使用：

```bash
submit review-working-tree
await <run-id>
result <run-id>
```

只有很小的本地 smoke test 才建议显式使用 `--wait --wait-ok`。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLAUDE_AGENT_RUNS_DIR` | `.claude-runs` | 任务状态目录，位于 `--cwd` 下。 |
| `CLAUDE_AGENT_CLAUDE_BIN` | `claude` | Claude CLI 命令路径。 |
| `CLAUDE_AGENT_NODE_BIN` | 当前 Node | 后台 worker 使用的 Node。 |
| `CLAUDE_AGENT_READ_TOOLS` | `Read,Grep,Glob,LS` | explore/grill 允许的只读工具。 |
| `CLAUDE_AGENT_DISALLOWED_TOOLS` | `Skill` | 所有 Claude 调用默认禁用的工具。 |
| `CLAUDE_AGENT_UNTRACKED_MAX_BYTES` | `65536` | `review-working-tree` 中单个 untracked 文本文件最大读取字节数。 |
| `CLAUDE_AGENT_STDOUT_LOG_MAX_BYTES` | `1048576` | 原始 `stdout.log` 截断阈值。 |

## 安全边界

- `--cwd` 是安全边界。
- runId 必须符合严格生成格式。
- `.claude-runs` 必须解析到 `--cwd` 内部；危险 symlink 会被拒绝。
- review 模式禁用 Claude 工具。
- explore/grill 只允许配置的只读工具，并默认禁用 Claude `Skill`。
- Claude 输出只是信号，不是事实源；重要结论必须由 Codex 再读源码/跑测试确认。
- 不要自动委托 Claude 做 commit、push、deploy、迁移、鉴权/计费改动、破坏性命令或密钥处理。

## 开发与验证

```bash
node --test scripts/claude-agent.test.mjs
node --check scripts/claude-agent.mjs
python3 /path/to/quick_validate.py .
```

## 参考与借鉴

- [chaseai-yt/grill-me-codex](https://github.com/chaseai-yt/grill-me-codex)：跨模型质询/评审循环的设计参考。`grill-me-codex` 更像是 Claude 主控、让 Codex 不断质询；本仓库反过来，Codex 保持主控，Claude CLI 作为受限的只读评审/探索子代理。

## 许可证

MIT
