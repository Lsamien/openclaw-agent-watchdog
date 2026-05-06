# Agent Watchdog

中文说明见 [README.zh-CN.md](./README.zh-CN.md)。

Monitors OpenClaw subagent task progress and delivery state, then writes a live snapshot to:

`~/.openclaw/tmp/agent-watchdog/status.json`

## One-Command Install

Install directly from GitHub:

```bash
openclaw plugins install https://github.com/Lsamien/openclaw-agent-watchdog.git --force
openclaw plugins enable agent-watchdog
openclaw gateway restart
```

Or use the bundled installer script:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Lsamien/openclaw-agent-watchdog/main/scripts/install.sh)
```

## Commands

- `openclaw watchdog status`
- `openclaw watchdog status --json`
- `openclaw watchdog ui`

## Auto Action

Optional automatic remediation when a task is stalled or completed-but-undelivered:

- Enable: `plugins.entries.agent-watchdog.config.autoAction.enabled = true`
- Mode:
  - `chat_send` (default): sends a follow-up to target session via `openclaw gateway call chat.send`
  - `command`: runs shell command template

Template variables:

- `{{taskId}}`
- `{{agentId}}`
- `{{runId}}`
- `{{label}}`
- `{{status}}`
- `{{stalledSeconds}}`
- `{{requesterSessionKey}}`
- `{{deliveryStatus}}`
- `{{progressSummary}}`
- `{{childSessionKey}}`
