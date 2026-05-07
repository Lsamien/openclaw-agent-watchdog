import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

type UnknownRecord = Record<string, unknown>;

type TaskEntry = {
  taskId: string;
  runtime?: string;
  status?: string;
  deliveryStatus?: string;
  lastEventAt?: number;
  startedAt?: number;
  createdAt?: number;
  endedAt?: number;
  runId?: string;
  label?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  agentId?: string;
  childSessionKey?: string;
  progressSummary?: string;
};

type WatchdogConfig = {
  pollIntervalMs: number;
  staleAfterMs: number;
  recentWindowMs: number;
  healthTimeoutMs: number;
  statusFile: string;
  openclawBin: string;
  openclawArgs: string[];
  autoAction: {
    enabled: boolean;
    mode: "command" | "chat_send";
    notifyStalled: boolean;
    notifyUndelivered: boolean;
    stalledSessionKeyTemplate: string;
    stalledMessageTemplate: string;
    undeliveredSessionKeyTemplate: string;
    undeliveredMessageTemplate: string;
    maxProgressChars: number;
    commandTemplate: string;
    cooldownMs: number;
    timeoutMs: number;
  };
  ui: {
    refreshMs: number;
    maxRows: number;
  };
};

type ActionRecord = {
  key: string;
  at: number;
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

type WatchdogState = {
  generatedAt: number;
  summary: {
    activeSubagentTasks: number;
    stalledSubagentTasks: number;
    recentUndeliveredTasks: number;
    channelIssues: number;
    errors: number;
  };
  agents: Array<{
    agentId: string;
    name: string;
    mainSessionAgeMs: number | null;
    activeSubagentTasks: number;
    stalledSubagentTasks: number;
  }>;
  activeTasks: Array<{
    taskId: string;
    agentId: string;
    status: string;
    ageMs: number;
    label: string;
    runId: string;
    requesterSessionKey: string;
  }>;
  stalledTasks: Array<{
    taskId: string;
    agentId: string;
    status: string;
    ageMs: number;
    label: string;
    runId: string;
    requesterSessionKey: string;
  }>;
  recentUndeliveredTasks: Array<{
    taskId: string;
    agentId: string;
    status: string;
    deliveryStatus: string;
    endedAgeMs: number;
    label: string;
    runId: string;
  }>;
  channelIssues: Array<{
    channel: string;
    accountId: string;
    reason: string;
    running: boolean;
    configured: boolean;
  }>;
  actions: ActionRecord[];
  errors: string[];
};

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const OK_DELIVERY_STATUSES = new Set(["delivered", "not_applicable"]);

const DEFAULTS: WatchdogConfig = {
  pollIntervalMs: 15000,
  staleAfterMs: 5 * 60 * 1000,
  recentWindowMs: 6 * 60 * 60 * 1000,
  healthTimeoutMs: 25000,
  statusFile: "~/.openclaw/tmp/agent-watchdog/status.json",
  openclawBin: "openclaw",
  openclawArgs: [],
  autoAction: {
    enabled: false,
    mode: "chat_send",
    notifyStalled: true,
    notifyUndelivered: true,
    stalledSessionKeyTemplate: "agent:{{agentId}}:main",
    stalledMessageTemplate:
      "[Watchdog] 任务 {{taskId}} 已卡住 {{stalledSeconds}} 秒（{{label}}）。请立刻同步进度；若已完成，请向 {{requesterSessionKey}} 交付结果。",
    undeliveredSessionKeyTemplate: "{{requesterSessionKey}}",
    undeliveredMessageTemplate:
      "[Watchdog自动通知] 子任务 {{taskId}} 已 {{status}}，但未成功回传（delivery={{deliveryStatus}}）。摘要：{{progressSummary}}",
    maxProgressChars: 600,
    commandTemplate: "",
    cooldownMs: 10 * 60 * 1000,
    timeoutMs: 20000,
  },
  ui: {
    refreshMs: 3000,
    maxRows: 30,
  },
};

function asObject(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const v = Math.round(parsed);
  return Math.max(min, Math.min(max, v));
}

function resolveHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function normalizeConfig(raw: unknown): WatchdogConfig {
  const cfg = asObject(raw);
  const autoAction = asObject(cfg.autoAction);
  const ui = asObject(cfg.ui);
  return {
    pollIntervalMs: clampInt(cfg.pollIntervalMs, DEFAULTS.pollIntervalMs, 5000, 600000),
    staleAfterMs: clampInt(cfg.staleAfterMs, DEFAULTS.staleAfterMs, 30000, 86400000),
    recentWindowMs: clampInt(cfg.recentWindowMs, DEFAULTS.recentWindowMs, 60000, 604800000),
    healthTimeoutMs: clampInt(cfg.healthTimeoutMs, DEFAULTS.healthTimeoutMs, 5000, 120000),
    statusFile: resolveHomePath(asString(cfg.statusFile, DEFAULTS.statusFile)),
    openclawBin: asString(cfg.openclawBin, DEFAULTS.openclawBin),
    openclawArgs: Array.isArray(cfg.openclawArgs)
      ? cfg.openclawArgs.filter((x): x is string => typeof x === "string")
      : [],
    autoAction: {
      enabled: asBoolean(autoAction.enabled, DEFAULTS.autoAction.enabled),
      mode: asString(autoAction.mode, DEFAULTS.autoAction.mode) === "command" ? "command" : "chat_send",
      notifyStalled: asBoolean(autoAction.notifyStalled, DEFAULTS.autoAction.notifyStalled),
      notifyUndelivered: asBoolean(autoAction.notifyUndelivered, DEFAULTS.autoAction.notifyUndelivered),
      stalledSessionKeyTemplate: asString(
        autoAction.stalledSessionKeyTemplate,
        DEFAULTS.autoAction.stalledSessionKeyTemplate,
      ),
      stalledMessageTemplate: asString(
        autoAction.stalledMessageTemplate,
        DEFAULTS.autoAction.stalledMessageTemplate,
      ),
      undeliveredSessionKeyTemplate: asString(
        autoAction.undeliveredSessionKeyTemplate,
        DEFAULTS.autoAction.undeliveredSessionKeyTemplate,
      ),
      undeliveredMessageTemplate: asString(
        autoAction.undeliveredMessageTemplate,
        DEFAULTS.autoAction.undeliveredMessageTemplate,
      ),
      maxProgressChars: clampInt(
        autoAction.maxProgressChars,
        DEFAULTS.autoAction.maxProgressChars,
        60,
        4000,
      ),
      commandTemplate: asString(autoAction.commandTemplate, DEFAULTS.autoAction.commandTemplate),
      cooldownMs: clampInt(autoAction.cooldownMs, DEFAULTS.autoAction.cooldownMs, 10000, 86400000),
      timeoutMs: clampInt(autoAction.timeoutMs, DEFAULTS.autoAction.timeoutMs, 1000, 300000),
    },
    ui: {
      refreshMs: clampInt(ui.refreshMs, DEFAULTS.ui.refreshMs, 500, 60000),
      maxRows: clampInt(ui.maxRows, DEFAULTS.ui.maxRows, 5, 200),
    },
  };
}

function extractJsonFromMixedOutput(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("No JSON object found in command output");
  }
  return JSON.parse(output.slice(start, end + 1));
}

async function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null }> {
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : `exit code ${code}` });
    });
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...rows.map((r) => (r[i] || "").length),
    ),
  );
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (c || "").slice(0, widths[i]).padEnd(widths[i], " "))
      .join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(r))].join("\n");
}

function interpolate(template: string, task: TaskEntry, ageMs: number): string {
  const progressSummary =
    typeof task.progressSummary === "string" ? task.progressSummary.replace(/\s+/g, " ").trim() : "";
  const pairs: Record<string, string> = {
    taskId: task.taskId || "",
    agentId: task.agentId || "",
    runId: task.runId || "",
    label: task.label || "",
    status: task.status || "",
    requesterSessionKey: task.requesterSessionKey || "",
    ownerKey: task.ownerKey || "",
    stalledSeconds: String(Math.floor(ageMs / 1000)),
    deliveryStatus: task.deliveryStatus || "",
    progressSummary,
    childSessionKey: task.childSessionKey || "",
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => pairs[key] || "");
}

function inferAgentId(task: TaskEntry): string {
  if (task.agentId) return task.agentId;
  const key = task.childSessionKey || task.ownerKey || task.requesterSessionKey || "";
  const m = key.match(/^agent:([^:]+):/);
  return m ? m[1] : "";
}

function safePreview(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

async function runChatSendViaGateway(
  cfg: WatchdogConfig,
  params: { sessionKey: string; message: string; idempotencyKey: string },
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null; command: string }> {
  const callParams = JSON.stringify({
    sessionKey: params.sessionKey,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
  });
  const args = [...cfg.openclawArgs, "gateway", "call", "chat.send", "--params", callParams, "--json"];
  const result = await runCommand(cfg.openclawBin, args, cfg.autoAction.timeoutMs);
  const command = `${cfg.openclawBin} ${args.join(" ")}`;
  return { ...result, command };
}

function mapTaskAges(tasks: TaskEntry[], now: number) {
  return tasks.map((task) => {
    const base =
      typeof task.lastEventAt === "number"
        ? task.lastEventAt
        : typeof task.startedAt === "number"
          ? task.startedAt
          : typeof task.createdAt === "number"
            ? task.createdAt
            : now;
    const ageMs = Math.max(0, now - base);
    return { task, ageMs };
  });
}

function buildAgentView(health: UnknownRecord, sessions: UnknownRecord, active: TaskEntry[], stalled: TaskEntry[]) {
  const sessionList = Array.isArray(sessions.sessions) ? (sessions.sessions as UnknownRecord[]) : [];
  const sessionAgeByAgent = new Map<string, number>();
  const agentNameById = new Map<string, string>();
  const agentIds = new Set<string>();
  for (const s of sessionList) {
    const key = asString(s.key);
    const agentId = asString(s.agentId);
    const ageMs = asNumber(s.ageMs);
    if (!key || !agentId) continue;
    agentIds.add(agentId);
    if (ageMs != null && key === `agent:${agentId}:main`) {
      sessionAgeByAgent.set(agentId, ageMs);
    }
  }
  const agents = Array.isArray(health.agents) ? (health.agents as UnknownRecord[]) : [];
  for (const agent of agents) {
    const agentId = asString(agent.agentId);
    if (!agentId) continue;
    agentIds.add(agentId);
    agentNameById.set(agentId, asString(agent.name, agentId));
  }
  for (const t of active) {
    if (t.agentId) agentIds.add(t.agentId);
  }
  for (const t of stalled) {
    if (t.agentId) agentIds.add(t.agentId);
  }
  return Array.from(agentIds).map((agentId) => {
    const a = active.filter((t) => t.agentId === agentId).length;
    const s = stalled.filter((t) => t.agentId === agentId).length;
    return {
      agentId,
      name: agentNameById.has(agentId) ? (agentNameById.get(agentId) as string) : agentId,
      mainSessionAgeMs: sessionAgeByAgent.has(agentId) ? (sessionAgeByAgent.get(agentId) as number) : null,
      activeSubagentTasks: a,
      stalledSubagentTasks: s,
    };
  });
}

async function readStatusFile(statusFile: string): Promise<WatchdogState | null> {
  try {
    const text = await readFile(statusFile, "utf8");
    return JSON.parse(text) as WatchdogState;
  } catch {
    return null;
  }
}

export default {
  id: "agent-watchdog",
  name: "Agent Watchdog",
  register(api: any) {
    const cfg = normalizeConfig(api.pluginConfig);
    const actionSeenAt = new Map<string, number>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;
    let latestState: WatchdogState | null = null;

    const writeState = async (state: WatchdogState) => {
      await mkdir(dirname(cfg.statusFile), { recursive: true });
      await writeFile(cfg.statusFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    };

    const collect = async (): Promise<WatchdogState> => {
      const now = Date.now();
      const errors: string[] = [];
      const actions: ActionRecord[] = [];

      const healthCmd = await runCommand(
        cfg.openclawBin,
        [...cfg.openclawArgs, "health", "--json", "--timeout", String(cfg.healthTimeoutMs)],
        cfg.healthTimeoutMs + 5000,
      );
      const tasksCmd = await runCommand(
        cfg.openclawBin,
        [...cfg.openclawArgs, "tasks", "list", "--runtime", "subagent", "--json"],
        20000,
      );
      if (!tasksCmd.ok) {
        throw new Error(`tasks command failed: ${tasksCmd.error || tasksCmd.stderr || "unknown"}`);
      }
      const sessionsCmd = await runCommand(
        cfg.openclawBin,
        [...cfg.openclawArgs, "sessions", "--all-agents", "--limit", "200", "--json"],
        20000,
      );
      if (!sessionsCmd.ok) {
        throw new Error(`sessions command failed: ${sessionsCmd.error || sessionsCmd.stderr || "unknown"}`);
      }

      let healthJson: UnknownRecord = {};
      let tasksJson: UnknownRecord;
      let sessionsJson: UnknownRecord;
      if (!healthCmd.ok) {
        errors.push(`health command failed: ${healthCmd.error || healthCmd.stderr || "unknown"}`);
      } else {
        try {
          healthJson = asObject(extractJsonFromMixedOutput(`${healthCmd.stdout}\n${healthCmd.stderr}`));
        } catch (err) {
          errors.push(`failed to parse health JSON: ${String(err)}`);
        }
      }
      try {
        tasksJson = asObject(extractJsonFromMixedOutput(`${tasksCmd.stdout}\n${tasksCmd.stderr}`));
      } catch (err) {
        throw new Error(`failed to parse tasks JSON: ${String(err)}`);
      }
      try {
        sessionsJson = asObject(extractJsonFromMixedOutput(`${sessionsCmd.stdout}\n${sessionsCmd.stderr}`));
      } catch (err) {
        throw new Error(`failed to parse sessions JSON: ${String(err)}`);
      }

      const allTasks = Array.isArray(tasksJson.tasks) ? (tasksJson.tasks as UnknownRecord[]) : [];
      const subagentTasks: TaskEntry[] = allTasks.map((t) => {
        const lastEventAt = asNumber(t.lastEventAt);
        const startedAt = asNumber(t.startedAt);
        const createdAt = asNumber(t.createdAt);
        const endedAt = asNumber(t.endedAt);
        return {
          taskId: asString(t.taskId),
          runtime: asString(t.runtime),
          status: asString(t.status),
          deliveryStatus: asString(t.deliveryStatus),
          lastEventAt: lastEventAt == null ? undefined : lastEventAt,
          startedAt: startedAt == null ? undefined : startedAt,
          createdAt: createdAt == null ? undefined : createdAt,
          endedAt: endedAt == null ? undefined : endedAt,
          runId: asString(t.runId),
          label: asString(t.label || t.task),
          requesterSessionKey: asString(t.requesterSessionKey),
          ownerKey: asString(t.ownerKey),
          agentId: asString(t.agentId),
          childSessionKey: asString(t.childSessionKey),
          progressSummary: asString(t.progressSummary),
        };
      });

      const active = subagentTasks.filter((t) => ACTIVE_TASK_STATUSES.has((t.status || "").toLowerCase()));
      const activeWithAge = mapTaskAges(active, now);
      const stalledWithAge = activeWithAge.filter((x) => x.ageMs >= cfg.staleAfterMs);
      const stalled = stalledWithAge.map((x) => x.task);

      const recentCompleted = subagentTasks.filter((t) => {
        const status = (t.status || "").toLowerCase();
        const endedAt = typeof t.endedAt === "number" ? t.endedAt : 0;
        return endedAt > 0 && now - endedAt <= cfg.recentWindowMs && !ACTIVE_TASK_STATUSES.has(status);
      });
      const undeliveredRecent = recentCompleted.filter((t) => {
        const ds = (t.deliveryStatus || "").toLowerCase();
        return !OK_DELIVERY_STATUSES.has(ds);
      });
      const undeliveredWithAge = undeliveredRecent.map((task) => ({
        task,
        endedAgeMs: Math.max(0, now - (typeof task.endedAt === "number" ? task.endedAt : now)),
      }));

      if (cfg.autoAction.enabled) {
        for (const { task, ageMs } of stalledWithAge) {
          if (!cfg.autoAction.notifyStalled) break;
          const key = `stalled:${task.taskId}`;
          const last = actionSeenAt.has(key) ? (actionSeenAt.get(key) as number) : 0;
          if (now - last < cfg.autoAction.cooldownMs) continue;
          const normalizedTask: TaskEntry = { ...task, agentId: inferAgentId(task) };
          let result:
            | { ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null }
            | null = null;
          let command = "";
          if (cfg.autoAction.mode === "command" && cfg.autoAction.commandTemplate.trim()) {
            command = interpolate(cfg.autoAction.commandTemplate, normalizedTask, ageMs);
            result = await runCommand("/bin/zsh", ["-lc", command], cfg.autoAction.timeoutMs);
          } else {
            const sessionKey = interpolate(cfg.autoAction.stalledSessionKeyTemplate, normalizedTask, ageMs).trim();
            if (!sessionKey) {
              result = {
                ok: false,
                code: null,
                stdout: "",
                stderr: "",
                error: "empty stalledSessionKeyTemplate result",
              };
            } else {
              const rawMessage = interpolate(cfg.autoAction.stalledMessageTemplate, normalizedTask, ageMs).trim();
              const message = rawMessage || DEFAULTS.autoAction.stalledMessageTemplate;
              const sent = await runChatSendViaGateway(cfg, {
                sessionKey,
                message: safePreview(message, 2000),
                idempotencyKey: `watchdog-stalled-${task.taskId}-${Math.floor(now / cfg.autoAction.cooldownMs)}`,
              });
              result = sent;
              command = sent.command;
            }
          }
          actionSeenAt.set(key, now);
          actions.push({
            key,
            at: now,
            command,
            ok: result ? result.ok : false,
            code: result ? result.code : null,
            stdout: result ? result.stdout.trim() : "",
            stderr: result ? result.stderr.trim() : "",
            error: result ? result.error : "missing action result",
          });
        }

        for (const { task, endedAgeMs } of undeliveredWithAge) {
          if (!cfg.autoAction.notifyUndelivered) break;
          const key = `undelivered:${task.taskId}`;
          const last = actionSeenAt.has(key) ? (actionSeenAt.get(key) as number) : 0;
          if (now - last < cfg.autoAction.cooldownMs) continue;
          const normalizedTask: TaskEntry = { ...task, agentId: inferAgentId(task) };
          const sessionKey = interpolate(cfg.autoAction.undeliveredSessionKeyTemplate, normalizedTask, endedAgeMs).trim();
          let result:
            | { ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null }
            | null = null;
          let command = "";
          if (!sessionKey) {
            result = {
              ok: false,
              code: null,
              stdout: "",
              stderr: "",
              error: "empty undeliveredSessionKeyTemplate result",
            };
          } else {
            const summary = safePreview(asString(task.progressSummary), cfg.autoAction.maxProgressChars);
            const msgTask: TaskEntry = { ...normalizedTask, progressSummary: summary };
            const rawMessage = interpolate(cfg.autoAction.undeliveredMessageTemplate, msgTask, endedAgeMs).trim();
            const message = rawMessage || DEFAULTS.autoAction.undeliveredMessageTemplate;
            const sent = await runChatSendViaGateway(cfg, {
              sessionKey,
              message: safePreview(message, 2000),
              idempotencyKey: `watchdog-undelivered-${task.taskId}-${Math.floor(now / cfg.autoAction.cooldownMs)}`,
            });
            result = sent;
            command = sent.command;
          }
          actionSeenAt.set(key, now);
          actions.push({
            key,
            at: now,
            command,
            ok: result ? result.ok : false,
            code: result ? result.code : null,
            stdout: result ? result.stdout.trim() : "",
            stderr: result ? result.stderr.trim() : "",
            error: result ? result.error : "missing action result",
          });
        }
      }

      const channelsObj = asObject(healthJson.channels);
      const channelIssues: WatchdogState["channelIssues"] = [];
      for (const [channelName, raw] of Object.entries(channelsObj)) {
        const channel = asObject(raw);
        const accounts = asObject(channel.accounts);
        for (const [accountId, accountRaw] of Object.entries(accounts)) {
          const account = asObject(accountRaw);
          const configured = asBoolean(account.configured, false);
          const runningState = asBoolean(account.running, false);
          const connectedState = asBoolean(account.connected, runningState);
          const lastError = asString(account.lastError);
          if (!configured || !runningState || !connectedState || lastError) {
            const reason = !configured
              ? "not_configured"
              : !runningState
                ? "not_running"
                : !connectedState
                  ? "not_connected"
                  : lastError;
            channelIssues.push({
              channel: channelName,
              accountId,
              reason,
              running: runningState,
              configured,
            });
          }
        }
      }

      const agentView = buildAgentView(healthJson, sessionsJson, active, stalled);

      return {
        generatedAt: now,
        summary: {
          activeSubagentTasks: active.length,
          stalledSubagentTasks: stalled.length,
          recentUndeliveredTasks: undeliveredRecent.length,
          channelIssues: channelIssues.length,
          errors: errors.length,
        },
        agents: agentView,
        activeTasks: activeWithAge.map(({ task, ageMs }) => ({
          taskId: task.taskId,
          agentId: task.agentId || "",
          status: task.status || "",
          ageMs,
          label: task.label || "",
          runId: task.runId || "",
          requesterSessionKey: task.requesterSessionKey || "",
        })),
        stalledTasks: stalledWithAge.map(({ task, ageMs }) => ({
          taskId: task.taskId,
          agentId: task.agentId || "",
          status: task.status || "",
          ageMs,
          label: task.label || "",
          runId: task.runId || "",
          requesterSessionKey: task.requesterSessionKey || "",
        })),
        recentUndeliveredTasks: undeliveredWithAge.map(({ task, endedAgeMs }) => ({
          taskId: task.taskId,
          agentId: task.agentId || "",
          status: task.status || "",
          deliveryStatus: task.deliveryStatus || "",
          endedAgeMs,
          label: task.label || "",
          runId: task.runId || "",
        })),
        channelIssues,
        actions,
        errors,
      };
    };

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const state = await collect();
        latestState = state;
        await writeState(state);
      } catch (err) {
        const prev = latestState;
        const fallback: WatchdogState = {
          generatedAt: Date.now(),
          summary: {
            activeSubagentTasks: prev ? prev.summary.activeSubagentTasks : 0,
            stalledSubagentTasks: prev ? prev.summary.stalledSubagentTasks : 0,
            recentUndeliveredTasks: prev ? prev.summary.recentUndeliveredTasks : 0,
            channelIssues: prev ? prev.summary.channelIssues : 0,
            errors: 1,
          },
          agents: prev ? prev.agents : [],
          activeTasks: prev ? prev.activeTasks : [],
          stalledTasks: prev ? prev.stalledTasks : [],
          recentUndeliveredTasks: prev ? prev.recentUndeliveredTasks : [],
          channelIssues: prev ? prev.channelIssues : [],
          actions: [],
          errors: [String(err)],
        };
        latestState = fallback;
        await writeState(fallback).catch(() => void 0);
        api.logger.warn(`agent-watchdog: tick failed: ${String(err)}`);
      } finally {
        running = false;
      }
    };

    api.registerService({
      id: "agent-watchdog",
      start: async () => {
        api.logger.info(
          `agent-watchdog: starting (poll=${cfg.pollIntervalMs}ms stale=${cfg.staleAfterMs}ms status=${cfg.statusFile})`,
        );
        await tick();
        timer = setInterval(() => {
          void tick();
        }, cfg.pollIntervalMs);
      },
      stop: async () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        api.logger.info("agent-watchdog: stopped");
      },
    });

    api.registerGatewayMethod("agent_watchdog.status", async ({ respond }: any) => {
      const state = latestState || (await readStatusFile(cfg.statusFile));
      respond(true, {
        ok: true,
        statusFile: cfg.statusFile,
        state,
      });
    });

    api.registerCli(
      ({ program }: any) => {
        const cmd = program.command("watchdog").description("Agent watchdog monitor and TUI dashboard");

        cmd
          .command("status")
          .option("--json", "print JSON")
          .action(async (opts: { json?: boolean }) => {
            const state = await readStatusFile(cfg.statusFile);
            if (!state) {
              console.log(`No watchdog status file yet: ${cfg.statusFile}`);
              return;
            }
            if (opts.json) {
              console.log(JSON.stringify(state, null, 2));
              return;
            }
            console.log(`Watchdog @ ${new Date(state.generatedAt).toLocaleString()}`);
            console.log(
              `active=${state.summary.activeSubagentTasks} stalled=${state.summary.stalledSubagentTasks} undelivered=${state.summary.recentUndeliveredTasks} channelIssues=${state.summary.channelIssues} errors=${state.summary.errors}`,
            );
          });

        cmd
          .command("ui")
          .option("--refresh <ms>", "refresh interval in ms")
          .action(async (opts: { refresh?: string }) => {
            const refreshMs = clampInt(Number(opts.refresh), cfg.ui.refreshMs, 500, 60000);
            const render = async () => {
              const state = await readStatusFile(cfg.statusFile);
              process.stdout.write("\x1bc");
              if (!state) {
                console.log(`Waiting for status file: ${cfg.statusFile}`);
                return;
              }
              console.log(`Agent Watchdog  |  ${new Date(state.generatedAt).toLocaleString()}`);
              console.log(
                `Active: ${state.summary.activeSubagentTasks}  Stalled: ${state.summary.stalledSubagentTasks}  Undelivered: ${state.summary.recentUndeliveredTasks}  Channel Issues: ${state.summary.channelIssues}`,
              );
              console.log("");

              const agentRows = state.agents
                .slice(0, cfg.ui.maxRows)
                .map((a) => [
                  a.agentId,
                  a.mainSessionAgeMs == null ? "-" : formatDuration(a.mainSessionAgeMs),
                  String(a.activeSubagentTasks),
                  String(a.stalledSubagentTasks),
                ]);
              console.log(renderTable(["Agent", "Main Session Age", "Active", "Stalled"], agentRows));
              console.log("");

              const stalledRows = state.stalledTasks
                .slice(0, cfg.ui.maxRows)
                .map((t) => [
                  t.agentId || "-",
                  t.taskId.slice(0, 8),
                  t.status || "-",
                  formatDuration(t.ageMs),
                  (t.label || "-").slice(0, 48),
                ]);
              console.log("Stalled Tasks");
              console.log(
                stalledRows.length > 0
                  ? renderTable(["Agent", "Task", "Status", "Age", "Label"], stalledRows)
                  : "None",
              );
              console.log("");

              const undeliveredRows = state.recentUndeliveredTasks
                .slice(0, cfg.ui.maxRows)
                .map((t) => [
                  t.agentId || "-",
                  t.taskId.slice(0, 8),
                  t.status || "-",
                  t.deliveryStatus || "-",
                  formatDuration(t.endedAgeMs),
                ]);
              console.log("Recent Undelivered");
              console.log(
                undeliveredRows.length > 0
                  ? renderTable(["Agent", "Task", "Status", "Delivery", "Ended"], undeliveredRows)
                  : "None",
              );
              console.log("");
              if (state.errors.length > 0) {
                console.log("Errors");
                for (const e of state.errors.slice(0, 5)) {
                  console.log(`- ${e}`);
                }
              }
            };
            await render();
            const interval = setInterval(() => {
              void render();
            }, refreshMs);
            const stop = () => {
              clearInterval(interval);
              process.exit(0);
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
          });
      },
      { commands: ["watchdog"] },
    );
  },
};
