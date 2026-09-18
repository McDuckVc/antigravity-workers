import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchWorkerTerminal, workerTerminalConfig } from "../server/worker-terminal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const viewer = path.resolve(here, "..", "server", "worker-terminal.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-terminal-test-"));
const stdoutPath = path.join(root, "stdout.log");
const stderrPath = path.join(root, "stderr.log");
const completionPath = path.join(root, "complete.json");
const teamPath = path.join(root, "team.json");

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for streamed terminal output.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function waitForExit(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for terminal viewer to exit."));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

try {
  assert.equal(workerTerminalConfig({}, "linux").enabled, false);
  assert.equal(workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "linux").enabled, false);
  assert.equal(workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "win32").enabled, true);

  let launch;
  const fakeChild = { pid: 42, once() {}, unref() {} };
  const launched = launchWorkerTerminal({
    run: { id: "run-1", kind: "analysis", agent_id: "alpha", team_stage: "initial", model: "test-model", effort: "high", attempt: 1, pid: 41, worker_cwd: root },
    stdoutPath,
    stderrPath,
    completionPath,
    teamPath,
    config: workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "win32"),
  }, {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    scriptPath: viewer,
    launcherPath: path.join(path.dirname(viewer), "worker-terminal.cmd"),
    spawn(command, args, options) { launch = { command, args, options }; return fakeChild; },
  });
  assert.equal(launched.mode, "cmd");
  assert.equal(launched.launcher_pid, 42);
  assert.equal(launch.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(launch.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.match(Buffer.from(launch.args[4], "base64").toString("utf16le"), /Start-Process[\s\S]*WindowStyle Normal/);
  assert.equal(launch.options.cwd, path.dirname(viewer));
  assert.equal(launch.options.detached, undefined);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.stdio, "ignore");
  const launchPayload = JSON.parse(Buffer.from(launch.options.env.ANTIGRAVITY_TERMINAL_PAYLOAD, "base64url").toString("utf8"));
  assert.equal(launchPayload.agent_id, "alpha");
  assert.equal(launchPayload.completion_path, completionPath);
  assert.equal(launchPayload.team_path, teamPath);
  assert.equal(launchPayload.ready_path, `${completionPath}.viewer-ready`);
  assert.equal(launchPayload.auto_close_ms, 120_000);

  await Promise.all([
    fs.writeFile(stdoutPath, ""),
    fs.writeFile(stderrPath, ""),
    fs.writeFile(teamPath, JSON.stringify({ messages: [
      { id: "message-1", from: "coordinator", to: "alpha", kind: "feedback", body: "Check the parser edge case." },
      { id: "message-2", from: "beta", to: "gamma", kind: "peer-message", body: "Private beta-gamma note." },
    ] })),
  ]);
  const payload = {
    run_id: "viewer-test",
    kind: "analysis",
    agent_id: "alpha",
    team_stage: "initial",
    model: "mock-model",
    effort: "high",
    attempt: 1,
    worker_pid: process.pid,
    cwd: root,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    completion_path: completionPath,
    team_path: teamPath,
    ready_path: `${completionPath}.viewer-ready`,
    poll_ms: 25,
    exit_when_complete: true,
  };
  const child = spawn(process.execPath, [viewer, "--view-worker"], {
    env: {
      ...process.env,
      ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
      ANTIGRAVITY_TERMINAL_TEST_COLOR: "1",
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  await waitFor(() => output.includes("ANTIGRAVITY AGENT") && output.includes("Check the parser edge case."));
  await fs.appendFile(stdoutPath, [
    JSON.stringify({ event: "init", conversation_id: "conversation-1", init: { cwd: root } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "read_file" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " } }),
  ].join("\n") + "\n", "utf8");
  await waitFor(() => output.includes("Hello "));
  assert.doesNotMatch(output, /RUN METADATA/);
  await fs.appendFile(stdoutPath, JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "from the worker!" } }) + "\n", "utf8");
  const unicodeEvent = Buffer.from(JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: " 🚀" } }) + "\n", "utf8");
  const rocketOffset = unicodeEvent.indexOf(Buffer.from("🚀", "utf8"));
  await fs.appendFile(stdoutPath, unicodeEvent.subarray(0, rocketOffset + 1));
  await new Promise(resolve => setTimeout(resolve, 75));
  await fs.appendFile(stdoutPath, unicodeEvent.subarray(rocketOffset + 1));
  await fs.appendFile(stdoutPath, JSON.stringify({ event: "result", result: {
      conversation_id: "conversation-1",
      status: "SUCCESS",
      response: "Hello from the worker!",
      duration_seconds: 1.25,
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5 },
    } }) + "\n", "utf8");
  await fs.writeFile(stderrPath, "internal diagnostic that should stay hidden on success\n", "utf8");
  await fs.writeFile(completionPath, JSON.stringify({ status: "succeeded", exit_code: 0 }), "utf8");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, errors);
  const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(output, /\u001b\[96m/);
  assert.match(output, /\u001b\[93m/);
  const agentInfoIndex = plainOutput.indexOf("ANTIGRAVITY AGENT");
  const responseIndex = plainOutput.indexOf("Hello from the worker!");
  const metadataIndex = plainOutput.indexOf("RUN METADATA");
  assert.equal(agentInfoIndex >= 0, true);
  assert(agentInfoIndex < responseIndex);
  assert(responseIndex < metadataIndex);
  assert.match(plainOutput, /Agent\s+alpha/);
  assert.match(plainOutput, /Type\s+analysis/);
  assert.match(plainOutput, /Model\s+mock-model/);
  assert.match(plainOutput, /Effort\s+high/);
  assert.match(plainOutput, /LIVE RESPONSE & ACTIVITY/);
  assert.match(plainOutput, /\[connected · conversation-1\]/);
  assert.match(plainOutput, /\[tool ›\] read_file · ACTIVE/);
  assert.match(plainOutput, /TEAM MESSAGE · FEEDBACK[\s\S]*coordinator → alpha/);
  assert.match(plainOutput, /Check the parser edge case\./);
  assert.match(plainOutput, /🚀/);
  assert.doesNotMatch(plainOutput, /�|Private beta-gamma note/);
  assert.match(plainOutput, /---[\s\S]*Status\s+Succeeded/);
  assert.match(plainOutput, /Input tokens\s+10/);
  assert.match(plainOutput, /Output tokens\s+5/);
  assert.match(plainOutput, /Total tokens\s+15/);
  assert.match(plainOutput, /Duration\s+1.25 seconds/);
  assert.match(plainOutput, /Turns\s+2/);
  assert.match(plainOutput, /Run ID\s+viewer-test/);
  assert.doesNotMatch(plainOutput, /internal diagnostic/);
  assert.equal(JSON.parse(await fs.readFile(`${completionPath}.viewer-ready`, "utf8")).pid, child.pid);

  const timerPayload = { ...payload, run_id: "viewer-timer-test", ready_path: `${completionPath}.timer-ready`, exit_when_complete: false, auto_close_ms: 300 };
  const timerChild = spawn(process.execPath, [viewer, "--view-worker"], {
    env: {
      ...process.env,
      ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(timerPayload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timerOutput = "";
  timerChild.stdout.on("data", chunk => { timerOutput += chunk; });
  await waitFor(() => timerOutput.includes("WINDOW TIMER"));
  assert.match(timerOutput, /Auto-close\s+1 seconds/);
  assert.match(timerOutput, /Press any key before the timer ends/);
  timerChild.stdin.write("k");
  await waitFor(() => timerOutput.includes("Auto-close cancelled"));
  timerChild.kill();
  await new Promise((resolve, reject) => {
    timerChild.once("error", reject);
    timerChild.once("close", resolve);
  });

  const autoClosePayload = { ...timerPayload, run_id: "viewer-auto-close-test", ready_path: `${completionPath}.auto-close-ready`, auto_close_ms: 150 };
  const autoCloseStartedAt = Date.now();
  const autoCloseChild = spawn(process.execPath, [viewer, "--view-worker"], {
    env: {
      ...process.env,
      ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(autoClosePayload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let autoCloseOutput = "";
  autoCloseChild.stdout.on("data", chunk => { autoCloseOutput += chunk; });
  const autoCloseExit = await waitForExit(autoCloseChild);
  assert.equal(autoCloseExit, 0);
  assert.match(autoCloseOutput, /WINDOW TIMER/);
  assert(Date.now() - autoCloseStartedAt < 2_000, "test viewer should close when its short timer expires");

  if (process.platform === "win32") {
    const launcher = path.join(path.dirname(viewer), "worker-terminal.cmd");
    const cmd = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", path.basename(launcher)], {
      cwd: path.dirname(launcher),
      env: {
        ...process.env,
        ANTIGRAVITY_TERMINAL_NODE: process.execPath,
        ANTIGRAVITY_TERMINAL_SCRIPT: viewer,
        ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
        ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cmdOutput = "", cmdErrors = "";
    cmd.stdout.on("data", chunk => { cmdOutput += chunk; });
    cmd.stderr.on("data", chunk => { cmdErrors += chunk; });
    const cmdExit = await new Promise((resolve, reject) => {
      cmd.once("error", reject);
      cmd.once("close", resolve);
    });
    assert.equal(cmdExit, 0, cmdErrors);
    assert(cmdOutput.indexOf("ANTIGRAVITY AGENT") < cmdOutput.indexOf("Hello from the worker!"));
    assert(cmdOutput.indexOf("Hello from the worker!") < cmdOutput.indexOf("RUN METADATA"));
    assert.match(cmdOutput, /Status\s+Succeeded/);
  }

  const failedStdoutPath = path.join(root, "failed-stdout.log");
  const failedStderrPath = path.join(root, "failed-stderr.log");
  const failedCompletionPath = path.join(root, "failed-complete.json");
  await Promise.all([
    fs.writeFile(failedStdoutPath, [
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Partial streamed response." } }),
      JSON.stringify({ event: "result", result: { status: "FAILED", response: "Partial streamed response.", error: "CLI failure detail." } }),
    ].join("\n") + "\n", "utf8"),
    fs.writeFile(failedStderrPath, "", "utf8"),
    fs.writeFile(failedCompletionPath, JSON.stringify({ status: "failed", exit_code: 1, message: "Worker failed after the partial response." }), "utf8"),
  ]);
  const failedPayload = {
    ...payload,
    run_id: "viewer-failure-test",
    stdout_path: failedStdoutPath,
    stderr_path: failedStderrPath,
    completion_path: failedCompletionPath,
    ready_path: `${failedCompletionPath}.viewer-ready`,
  };
  const failedChild = spawn(process.execPath, [viewer, "--view-worker"], {
    env: {
      ...process.env,
      ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(failedPayload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failedOutput = "";
  failedChild.stdout.on("data", chunk => { failedOutput += chunk; });
  assert.equal(await waitForExit(failedChild), 0);
  assert.match(failedOutput, /Partial streamed response\./);
  assert.match(failedOutput, /Failure: Worker failed after the partial response\./);
  assert.match(failedOutput, /Status\s+Failed/);
  const launcherText = await fs.readFile(path.join(path.dirname(viewer), "worker-terminal.cmd"), "utf8");
  assert.match(launcherText, /chcp 65001 >nul/i);
  assert.match(launcherText, /color 0A/i);
  assert(launcherText.indexOf("chcp 65001") < launcherText.indexOf("color 0A"));
  assert(launcherText.indexOf("color 0A") < launcherText.indexOf("ANTIGRAVITY_TERMINAL_NODE"));
  process.stdout.write("Windows worker terminal colors and agent-response-metadata formatting: OK\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
