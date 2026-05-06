# Agent Watchdog（中文说明）

`agent-watchdog` 是一个 OpenClaw 插件，用于监控多 Agent 协作时的任务执行与交付状态，重点解决：

- 长任务已分派但没有后续反馈
- 子任务完成了但没有成功回传到发起会话
- 协作过程中需要持续看到每个 Agent 的状态

状态快照文件默认写入：

`~/.openclaw/tmp/agent-watchdog/status.json`

## 一键安装（推荐）

方式 1：直接安装 GitHub 仓库

```bash
openclaw plugins install https://github.com/Lsamien/openclaw-agent-watchdog.git --force
openclaw plugins enable agent-watchdog
openclaw gateway restart
```

方式 2：脚本一键安装（Agent 可直接执行）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Lsamien/openclaw-agent-watchdog/main/scripts/install.sh)
```

## 状态查看

```bash
openclaw watchdog status
openclaw watchdog status --json
openclaw watchdog ui
```

## 自动动作（Auto Action）

插件支持两类自动动作：

1. 任务卡住（stalled）时自动催办
2. 任务已完成但未成功交付（undelivered）时自动补通知

### 模式

- `chat_send`（默认）：通过 `openclaw gateway call chat.send` 自动发消息
- `command`：执行你自定义的 shell 命令模板

### 常用模板变量

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

## 卸载

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Lsamien/openclaw-agent-watchdog/main/scripts/uninstall.sh)
```
