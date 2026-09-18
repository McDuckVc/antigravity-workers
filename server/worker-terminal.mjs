import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const viewerScript = fileURLToPath(import.meta.url);
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "cmd"]);

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function workerTerminalConfig(env = process.env, platform = process.platform) {
  const requested = String(env.ANTIGRAVITY_WORKER_TERMINALS || "off").trim().toLowerCase();
  const supported = platform === "win32";
  return {
    requested,
    supported,
    enabled: supported && TRUE_VALUES.has(requested),
    mode: supported && TRUE_VALUES.has(requested) ? "cmd" : "off",
  };
}

function safeLabel(value, fallback) {
  const cleaned = String(value || fallback).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return cleaned.slice(0, 120) || fallback;
}

export function launchWorkerTerminal({ run, stdoutPath, stderrPath, completionPath, teamPath, config }, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (!config?.enabled || platform !== "win32") return null;

  const spawnProcess = dependencies.spawn || spawn;
  const env = dependencies.env || process.env;
  const nodePath = dependencies.nodePath || process.execPath;
  const scriptPath = dependencies.scriptPath || viewerScript;
  const launcherPath = dependencies.launcherPath || path.join(path.dirname(scriptPath), "worker-terminal.cmd");
  const powershell = dependencies.powershellPath || path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powershellScript = "$child = Start-Process -FilePath $env:ANTIGRAVITY_TERMINAL_LAUNCHER_FILE -WorkingDirectory $env:ANTIGRAVITY_TERMINAL_LAUNCHER_DIR -WindowStyle Normal -PassThru; $child.WaitForExit(); exit $child.ExitCode";
  const encodedPowerShell = Buffer.from(powershellScript, "utf16le").toString("base64");
  const payload = {
    run_id: safeLabel(run.id, "unknown"),
    kind: safeLabel(run.kind, "worker"),
    agent_id: run.agent_id ? safeLabel(run.agent_id, "worker") : "",
    team_stage: run.team_stage ? safeLabel(run.team_stage, "") : "",
    model: safeLabel(run.model, "unknown"),
    effort: safeLabel(run.effort, "unknown"),
    attempt: Number.isInteger(run.attempt) ? run.attempt : 1,
    worker_pid: Number.isInteger(run.pid) ? run.pid : null,
    cwd: run.worker_cwd,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    completion_path: completionPath,
    team_path: teamPath || null,
    ready_path: `${completionPath}.viewer-ready`,
    poll_ms: 100,
    auto_close_ms: 120_000,
  };
  const child = spawnProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell], {
    cwd: path.dirname(launcherPath),
    env: {
      ...env,
      ANTIGRAVITY_TERMINAL_NODE: nodePath,
      ANTIGRAVITY_TERMINAL_SCRIPT: scriptPath,
      ANTIGRAVITY_TERMINAL_LAUNCHER_DIR: path.dirname(launcherPath),
      ANTIGRAVITY_TERMINAL_LAUNCHER_FILE: launcherPath,
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.once?.("error", () => {});
  child.unref?.();
  return {
    mode: "cmd",
    status: "opened",
    launcher_pid: child.pid,
    completion_path: completionPath,
    ready_path: payload.ready_path,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createConsoleWriter() {
  if (process.env.ANTIGRAVITY_TERMINAL_TEST_OUTPUT === "stdout") {
    return { write: value => process.stdout.write(value), close() {} };
  }
  if (!process.stdout.isTTY) throw new Error("The worker viewer was not launched in a visible console.");
  return { write: value => process.stdout.write(value), close() {} };
}

function parseCliPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    const payload = JSON.parse(trimmed);
    return payload?.event === "result" && payload.result ? payload.result : payload;
  } catch {}
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { parsed.push(JSON.parse(lines[index])); } catch {}
  }
  const resultEvent = parsed.find(payload => payload?.event === "result" && payload.result);
  if (resultEvent) return resultEvent.result;
  const legacyPayload = parsed.find(payload => payload && typeof payload === "object" && !payload.event);
  if (legacyPayload) return legacyPayload;
  return { response: trimmed };
}

function valueFrom(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function displayText(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function titleCase(value) {
  const text = String(value || "finished").replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[91m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  blue: "\u001b[94m",
  magenta: "\u001b[95m",
  cyan: "\u001b[96m",
  white: "\u001b[97m",
  gray: "\u001b[90m",
};

function paint(enabled, color, value) {
  return enabled ? `${color}${value}${ANSI.reset}` : String(value);
}

function detailsFrame(titleText, rows, useColor) {
  const width = 72;
  const title = ` ${titleText} `;
  const left = Math.floor((width - title.length) / 2);
  const right = width - title.length - left;
  const frameColor = useColor ? ANSI.green : "";
  const reset = useColor ? ANSI.reset : "";
  const output = [`${frameColor}╔${"═".repeat(left)}${title}${"═".repeat(right)}╗${reset}`];
  for (const [label, rawValue, color = ANSI.white] of rows) {
    const labelText = ` ${String(label).padEnd(15)}`;
    const valueText = String(rawValue).slice(0, width - labelText.length);
    const padding = " ".repeat(width - labelText.length - valueText.length);
    output.push(`${frameColor}║${reset}${paint(useColor, ANSI.green, labelText)}${paint(useColor, color, valueText)}${padding}${frameColor}║${reset}`);
  }
  output.push(`${frameColor}╚${"═".repeat(width)}╝${reset}`);
  return output.join("\r\n");
}

function colorEnabled() {
  return process.env.ANTIGRAVITY_TERMINAL_TEST_COLOR === "1" || (Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env));
}

function sectionBanner(titleText, useColor, color = ANSI.magenta) {
  const width = 72;
  const title = ` ${titleText} `;
  const side = Math.max(2, Math.floor((width - title.length) / 2));
  const remainder = Math.max(2, width - title.length - side);
  return paint(useColor, `${ANSI.bold}${color}`, `${"─".repeat(side)}${title}${"─".repeat(remainder)}`);
}

function formatAgentHeader(payload, useColor) {
  const rows = [
    ["Agent", payload.agent_id || "Standalone", ANSI.white],
    ["Type", payload.kind, ANSI.cyan],
    ["Model", payload.model, ANSI.cyan],
    ["Effort", payload.effort, ANSI.yellow],
    payload.team_stage ? ["Stage", payload.team_stage, ANSI.cyan] : null,
  ].filter(Boolean);
  return `${detailsFrame("ANTIGRAVITY AGENT", rows, useColor)}\r\n\r\n${sectionBanner("LIVE RESPONSE & ACTIVITY", useColor)}\r\n`;
}

function formatResult(payload, completion, cli, stderrText, responseStreamed, useColor) {
  cli ||= {};
  const response = displayText(cli.response ?? cli.result) || completion.message || displayText(cli.error) || "No response returned.";
  const failed = ["failed", "interrupted", "cancelled"].includes(String(completion.status || cli.status || "").toLowerCase());
  const failureMessage = completion.message || displayText(cli.error) || (failed ? response : "");
  const usage = cli.usage || {};
  const inputTokens = valueFrom(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = valueFrom(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const reportedTotal = valueFrom(usage, ["total_tokens", "totalTokens"]);
  const totalTokens = reportedTotal ?? (Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : undefined);
  const cachedTokens = valueFrom(usage, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"]);
  const status = titleCase(completion.status || cli.status);
  const statusColor = ["Failed", "Interrupted", "Cancelled"].includes(status) ? ANSI.red : ANSI.green;
  const metadataRows = [
    ["Status", status, statusColor],
    inputTokens !== undefined ? ["Input tokens", inputTokens, ANSI.yellow] : null,
    outputTokens !== undefined ? ["Output tokens", outputTokens, ANSI.yellow] : null,
    totalTokens !== undefined ? ["Total tokens", totalTokens, ANSI.yellow] : null,
    cachedTokens !== undefined ? ["Cached tokens", cachedTokens, ANSI.yellow] : null,
    cli.duration_seconds !== undefined ? ["Duration", `${cli.duration_seconds} seconds`, ANSI.cyan] : null,
    cli.num_turns !== undefined ? ["Turns", cli.num_turns, ANSI.yellow] : null,
    Number.isInteger(completion.exit_code) ? ["Exit code", completion.exit_code, ANSI.white] : null,
    ["Attempt", payload.attempt, ANSI.yellow],
    cli.conversation_id ? ["Conversation", cli.conversation_id, ANSI.gray] : null,
    ["Run ID", payload.run_id, ANSI.gray],
  ].filter(Boolean);
  const lines = [];
  if (!responseStreamed && !failed) lines.push("", paint(useColor, `${ANSI.bold}${ANSI.cyan}`, response));
  if (failed) lines.push("", paint(useColor, `${ANSI.bold}${ANSI.red}`, `Failure: ${failureMessage || "The worker did not complete successfully."}`));
  lines.push("", paint(useColor, ANSI.green, "---"), detailsFrame("RUN METADATA", metadataRows, useColor));
  if ((completion.status === "failed" || completion.status === "interrupted") && String(stderrText || "").trim()) {
    lines.push("", paint(useColor, `${ANSI.bold}${ANSI.red}`, "Error details:"), paint(useColor, ANSI.red, String(stderrText).trim()));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function formatAutoCloseNotice(autoCloseMs, useColor) {
  const seconds = Math.ceil(autoCloseMs / 1000);
  const duration = seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`;
  return `${detailsFrame("WINDOW TIMER", [
    ["Auto-close", duration, ANSI.yellow],
    ["Keep open", "Press any key before the timer ends", ANSI.cyan],
  ], useColor)}\r\n`;
}

function streamState() {
  return {
    offset: 0,
    decoder: new StringDecoder("utf8"),
    lineBuffer: "",
    finalResult: null,
    responseStreamed: false,
    connected: false,
    seenSteps: new Set(),
    seenMessages: new Set(),
  };
}

async function readAppendedText(filePath, state) {
  const handle = await fs.open(filePath, "r").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    if (size < state.offset) {
      state.offset = 0;
      state.decoder = new StringDecoder("utf8");
      state.lineBuffer = "";
    }
    if (size === state.offset) return "";
    const buffer = Buffer.allocUnsafe(size - state.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
    state.offset += bytesRead;
    return state.decoder.write(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function shortLabel(value, fallback = "activity") {
  return safeLabel(value, fallback).slice(0, 80);
}

function renderStreamRecord(record, state, writer, useColor) {
  if (!record || typeof record !== "object") return;
  if (record.event === "init") {
    if (!state.connected) {
      const conversation = record.conversation_id || record.init?.conversation_id;
      writer.write(`${paint(useColor, ANSI.gray, `[connected${conversation ? ` · ${conversation}` : ""}]`)}\r\n`);
      state.connected = true;
    }
    return;
  }
  if (record.event === "result" && record.result) {
    state.finalResult = record.result;
    return;
  }
  if (record.event !== "step_update" || !record.step_update) {
    if (!record.event && (record.response !== undefined || record.status !== undefined)) state.finalResult = record;
    return;
  }
  const step = record.step_update;
  if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
    writer.write(paint(useColor, `${ANSI.bold}${ANSI.cyan}`, step.text_delta));
    state.responseStreamed = true;
    return;
  }
  const transition = `${step.step_index ?? "?"}:${step.state || "UPDATE"}`;
  if (state.seenSteps.has(transition)) return;
  state.seenSteps.add(transition);
  if (step.step_type === "tool") {
    const marker = step.state === "DONE" ? "✓" : step.state === "ERROR" ? "!" : "›";
    const color = step.state === "ERROR" ? ANSI.red : step.state === "DONE" ? ANSI.green : ANSI.yellow;
    writer.write(`\r\n${paint(useColor, color, `[tool ${marker}] ${shortLabel(step.tool_name || step.tool_info?.name, "tool")} · ${shortLabel(step.state, "ACTIVE")}`)}\r\n`);
  } else if (step.step_type === "subagent") {
    const agents = Array.isArray(step.subagent_info?.subagents) ? step.subagent_info.subagents : [];
    const names = agents.map(agent => agent.role || agent.type_name).filter(Boolean).join(", ") || "subagent";
    writer.write(`\r\n${paint(useColor, ANSI.magenta, `[subagent ◆] ${shortLabel(names)} · ${shortLabel(step.state, "ACTIVE")}`)}\r\n`);
  } else if (["checkpoint", "system_message"].includes(step.step_type)) {
    writer.write(`\r\n${paint(useColor, ANSI.gray, `[${shortLabel(step.step_type)}] ${shortLabel(step.state, "UPDATE")}`)}\r\n`);
  }
}

function processStreamText(text, state, writer, useColor, flush = false) {
  state.lineBuffer += text;
  const lines = state.lineBuffer.split(/\r?\n/);
  state.lineBuffer = flush ? "" : lines.pop() || "";
  if (flush && state.lineBuffer) lines.push(state.lineBuffer);
  for (const line of lines) {
    if (!line.trim()) continue;
    try { renderStreamRecord(JSON.parse(line), state, writer, useColor); }
    catch { writer.write(`${paint(useColor, ANSI.gray, line)}\r\n`); }
  }
}

async function pollTeamMessages(payload, state, writer, useColor) {
  if (!payload.team_path || !payload.agent_id) return;
  const team = await fs.readFile(payload.team_path, "utf8").then(JSON.parse).catch(error => {
    if (["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  });
  if (!team) return;
  for (const message of team.messages || []) {
    if (!message?.id || state.seenMessages.has(message.id)) continue;
    state.seenMessages.add(message.id);
    const incoming = message.from !== payload.agent_id && (message.to === payload.agent_id || message.to === "all");
    if (!incoming) continue;
    const kind = shortLabel(message.kind, "message");
    const route = `${shortLabel(message.from, "unknown")} → ${shortLabel(message.to, payload.agent_id)}`;
    const timestamp = message.at ? new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "live";
    const body = String(message.body || "").trim().split(/\r?\n/).map(line => `${paint(useColor, ANSI.magenta, "│")} ${paint(useColor, ANSI.white, line)}`).join("\r\n");
    writer.write([
      "",
      paint(useColor, `${ANSI.bold}${ANSI.magenta}`, `┌─ TEAM MESSAGE · ${kind.toUpperCase()} ${"─".repeat(Math.max(2, 49 - kind.length))}`),
      `${paint(useColor, ANSI.magenta, "│")} ${paint(useColor, ANSI.yellow, route)} ${paint(useColor, ANSI.gray, `· ${timestamp}`)}`,
      body,
      paint(useColor, ANSI.magenta, `└${"─".repeat(71)}`),
    ].join("\r\n") + "\r\n");
  }
}

async function runViewer() {
  const encoded = process.env.ANTIGRAVITY_TERMINAL_PAYLOAD;
  if (!encoded) throw new Error("Missing ANTIGRAVITY_TERMINAL_PAYLOAD.");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const writer = createConsoleWriter();
  const useColor = colorEnabled();
  const state = streamState();
  process.title = `Antigravity ${payload.agent_id || payload.kind} - ${payload.run_id}`;
  await fs.writeFile(payload.ready_path, `${JSON.stringify({ pid: process.pid, is_tty: Boolean(process.stdout.isTTY), started_at: new Date().toISOString() })}\n`, { flag: "wx" }).catch(() => {});
  writer.write(formatAgentHeader(payload, useColor));

  let completion = null;
  let workerGoneAt = null;
  const pollMs = clamp(payload.poll_ms, 25, 1000, 100);
  try {
    while (!completion) {
      processStreamText(await readAppendedText(payload.stdout_path, state), state, writer, useColor);
      await pollTeamMessages(payload, state, writer, useColor);
      completion = await fs.readFile(payload.completion_path, "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      });
      if (completion) break;
      if (payload.worker_pid && !isPidAlive(payload.worker_pid)) workerGoneAt ??= Date.now();
      else workerGoneAt = null;
      if (workerGoneAt && Date.now() - workerGoneAt >= 2000) {
        completion = { status: "interrupted", message: "Worker exited before the scheduler wrote its completion record." };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    processStreamText(await readAppendedText(payload.stdout_path, state), state, writer, useColor, true);
    await pollTeamMessages(payload, state, writer, useColor);
    const [stdoutText, stderrText] = await Promise.all([
      fs.readFile(payload.stdout_path, "utf8").catch(() => ""),
      fs.readFile(payload.stderr_path, "utf8").catch(() => ""),
    ]);
    const cli = state.finalResult || parseCliPayload(stdoutText) || {};
    writer.write(formatResult(payload, completion, cli, stderrText, state.responseStreamed, useColor));
    if (!payload.exit_when_complete) {
      const autoCloseMs = clamp(payload.auto_close_ms, 100, 24 * 60 * 60 * 1000, 120_000);
      writer.write(`\r\n${formatAutoCloseNotice(autoCloseMs, useColor)}`);
      process.stdin.resume();
      let stopped = false;
      let keepOpen = false;
      const onSignal = () => { stopped = true; };
      const onInput = (chunk) => {
        if (Buffer.from(chunk).includes(3)) stopped = true;
        else keepOpen = true;
      };
      const rawMode = Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
      if (rawMode) process.stdin.setRawMode(true);
      process.stdin.on("data", onInput);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      const deadline = Date.now() + autoCloseMs;
      while (!stopped && !keepOpen && Date.now() < deadline) {
        await pollTeamMessages(payload, state, writer, useColor);
        await new Promise(resolve => setTimeout(resolve, Math.max(250, pollMs)));
      }
      process.stdin.off("data", onInput);
      if (rawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (keepOpen && !stopped) {
        writer.write(`${paint(useColor, `${ANSI.bold}${ANSI.green}`, "\r\n✓ Auto-close cancelled. This window will remain open until you close it.\r\n")}`);
        while (!stopped) {
          await pollTeamMessages(payload, state, writer, useColor);
          await new Promise(resolve => setTimeout(resolve, Math.max(250, pollMs)));
        }
      }
    }
  } finally {
    writer.close();
  }
}

if (process.argv.includes("--view-worker")) {
  runViewer().catch(error => {
    try {
      const writer = createConsoleWriter();
      writer.write(`Antigravity worker terminal failed: ${error.message}\r\n`);
      writer.close();
    } catch {}
    process.exitCode = 1;
  });
}
