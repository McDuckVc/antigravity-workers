import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..", "server", "index.mjs");
const mock = path.resolve(here, "mock-agy.mjs");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-workers-test-"));
const repository = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-workers-repo-"));
const accountFile = path.join(state, "google_accounts.json");
const failOnceFile = path.join(state, "fail-once.marker");
const brainDirectory = path.join(state, "brain");
const mediaInput = path.join(state, "sample.txt");
await fs.writeFile(accountFile, JSON.stringify({ active: "test@example.com", old: [] }), "utf8");
await fs.writeFile(mediaInput, "scoped multimodal input\n", "utf8");
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    ANTIGRAVITY_STATE_DIR: state,
    ANTIGRAVITY_AGY_PATH: process.execPath,
    ANTIGRAVITY_AGY_PREFIX_ARGS_JSON: JSON.stringify([mock]),
    ANTIGRAVITY_MAX_WORKERS: "1",
    ANTIGRAVITY_MAX_TEAM_AGENTS: "8",
    ANTIGRAVITY_ACCOUNT_FILE: accountFile,
    ANTIGRAVITY_MOCK_FAIL_ONCE_FILE: failOnceFile,
    ANTIGRAVITY_BRAIN_DIR: brainDirectory,
    ANTIGRAVITY_MAX_BUFFERED_STDOUT_BYTES: "1024",
  },
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const handler = pending.get(message.id);
  if (handler) {
    pending.delete(message.id);
    handler(message);
  }
});

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

try {
  const initialized = await request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.serverInfo.name, "antigravity-workers");
  const listed = await request("tools/list");
  assert(listed.tools.some((tool) => tool.name === "start_analysis"));
  assert(listed.tools.some((tool) => tool.name === "apply_run"));
  assert(listed.tools.some((tool) => tool.name === "start_team"));
  assert(listed.tools.some((tool) => tool.name === "message_agent"));
  assert(listed.tools.some((tool) => tool.name === "team_dashboard"));
  assert(listed.tools.some((tool) => tool.name === "start_media_analysis"));
  assert(listed.tools.some((tool) => tool.name === "start_image_generation"));
  assert(listed.tools.some((tool) => tool.name === "start_image_edit"));
  assert(listed.tools.some((tool) => tool.name === "get_media_run"));
  const doctor = await request("tools/call", { name: "doctor", arguments: {} });
  assert.equal(doctor.isError, false);
  assert.equal(doctor.structuredContent.ok, true);
  assert.equal(doctor.structuredContent.max_workers, 1);
  const account = await request("tools/call", { name: "get_account", arguments: {} });
  assert.equal(account.structuredContent.active_account, "test@example.com");
  const started = await request("tools/call", {
    name: "start_analysis",
    arguments: { cwd: here, task: "Return the self-test marker." },
  });
  assert.equal(started.isError, false);
  const runId = started.structuredContent.id;
  const queued = await request("tools/call", {
    name: "start_analysis",
    arguments: { cwd: here, task: "Return the queued self-test marker." },
  });
  assert.equal(queued.isError, false);
  assert.equal(queued.structuredContent.status, "queued");
  const completed = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: runId, wait_ms: 5000 },
  });
  assert.equal(completed.isError, false);
  assert.equal(completed.structuredContent.status, "succeeded");
  assert.match(completed.structuredContent.response, /MOCK_OK/);
  const queuedCompleted = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: queued.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(queuedCompleted.structuredContent.status, "succeeded");
  assert(queuedCompleted.structuredContent.events.some((event) => event.type === "queued"));
  const retryStarted = await request("tools/call", {
    name: "start_analysis",
    arguments: { cwd: here, task: "FAIL_ONCE then return the retry marker.", max_retries: 1 },
  });
  const retryCompleted = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: retryStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(retryCompleted.structuredContent.status, "succeeded", retryCompleted.content?.[0]?.text);
  assert.equal(retryCompleted.structuredContent.attempt, 2);
  assert(retryCompleted.structuredContent.events.some((event) => event.type === "retrying"));
  const cappedStarted = await request("tools/call", {
    name: "start_analysis",
    arguments: { cwd: here, task: "STREAM_CAP_TEST return the final result after oversized progress.", max_retries: 0 },
  });
  const cappedCompleted = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: cappedStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(cappedCompleted.structuredContent.status, "succeeded", cappedCompleted.content?.[0]?.text);
  assert.match(cappedCompleted.structuredContent.response, /MOCK_OK/);
  await fs.writeFile(path.join(state, "runs", `${runId}.attempt-1.terminal.json`), JSON.stringify({ run_id: runId, status: "succeeded" }), "utf8");
  const recent = await request("tools/call", { name: "list_runs", arguments: { limit: 5 } });
  assert.equal(recent.structuredContent.count, 4);
  assert(recent.structuredContent.runs.every((run) => run.id && run.kind));
  const projectRuns = await request("tools/call", { name: "list_runs", arguments: { cwd: here, limit: 5 } });
  assert.equal(projectRuns.isError, false, projectRuns.content?.[0]?.text);
  assert.equal(projectRuns.structuredContent.count, 4);

  const mediaStarted = await request("tools/call", {
    name: "start_media_analysis",
    arguments: { file_paths: [mediaInput], task: "Report the supplied text.", model_policy: "fast" },
  });
  assert.equal(mediaStarted.isError, false, mediaStarted.content?.[0]?.text);
  const mediaCompleted = await request("tools/call", {
    name: "get_media_run",
    arguments: { run_id: mediaStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(mediaCompleted.structuredContent.status, "succeeded", mediaCompleted.content?.[0]?.text);
  assert.equal(mediaCompleted.structuredContent.media_inputs.length, 1);

  const imageStarted = await request("tools/call", {
    name: "start_image_generation",
    arguments: { prompt: "A tiny test pixel.", output_name: "self-test", model_policy: "fast" },
  });
  assert.equal(imageStarted.isError, false, imageStarted.content?.[0]?.text);
  const imageCompleted = await request("tools/call", {
    name: "get_media_run",
    arguments: { run_id: imageStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(imageCompleted.structuredContent.status, "succeeded", imageCompleted.content?.[0]?.text);
  assert.equal(imageCompleted.structuredContent.artifacts.length, 1);
  assert(imageCompleted.content.some((item) => item.type === "image"));
  const artifactList = await request("tools/call", { name: "list_artifacts", arguments: { run_id: imageStarted.structuredContent.id } });
  assert.equal(artifactList.structuredContent.count, 1);

  const teamStarted = await request("tools/call", {
    name: "start_team",
    arguments: {
      cwd: here,
      name: "Self-test team",
      objective: "Return and review two independent mock markers.",
      review_rounds: 1,
      agents: [
        { id: "alpha", role: "First investigator", task: "Return ALPHA marker." },
        { id: "beta", role: "Second investigator", task: "Return BETA marker." },
      ],
    },
  });
  assert.equal(teamStarted.isError, false, teamStarted.content?.[0]?.text);
  const teamId = teamStarted.structuredContent.id;
  let team;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    team = await request("tools/call", { name: "get_team", arguments: { team_id: teamId, include_transcript: true } });
    if (!["queued", "running"].includes(team.structuredContent.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(team.structuredContent.status, "awaiting-codex-review", team.content?.[0]?.text);
  assert(team.structuredContent.messages.some((message) => message.kind === "worker-report"));
  assert(team.structuredContent.messages.some((message) => message.kind === "review"));
  assert(team.structuredContent.messages.some((message) => message.kind === "revision"));
  const dashboard = await request("tools/call", { name: "team_dashboard", arguments: { team_id: teamId } });
  assert.equal(dashboard.structuredContent.team_id, teamId);
  assert.equal(dashboard.structuredContent.agents.length, 3);
  const message = await request("tools/call", {
    name: "message_agent",
    arguments: { team_id: teamId, from_agent_id: "codex", to_agent_id: "alpha", message: "Re-check the marker." },
  });
  assert.equal(message.structuredContent.delivery, "queued");
  let transcript;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    transcript = await request("tools/call", { name: "get_team", arguments: { team_id: teamId, include_transcript: true } });
    if (transcript.structuredContent.messages.some((entry) => entry.kind === "peer-reply")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(transcript.structuredContent.messages.some((entry) => entry.kind === "peer-reply"));
  await command("git", ["init"], repository);
  await fs.writeFile(path.join(repository, "seed.txt"), "seed\n", "utf8");
  await command("git", ["add", "seed.txt"], repository);
  await command("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "seed"], repository);
  const editStarted = await request("tools/call", {
    name: "start_edit",
    arguments: {
      cwd: repository,
      task: "CREATE_EDIT_TEST_FILE",
      acceptance_criteria: "Create the test marker file.",
    },
  });
  assert.equal(editStarted.isError, false, editStarted.content?.[0]?.text);
  const editCompleted = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: editStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(editCompleted.structuredContent.status, "succeeded");
  assert.equal(editCompleted.structuredContent.patch.empty, false);
  await assert.rejects(fs.stat(path.join(repository, "antigravity-worker-test.txt")));
  const applied = await request("tools/call", {
    name: "apply_run",
    arguments: { run_id: editStarted.structuredContent.id },
  });
  assert.equal(applied.isError, false, applied.content?.[0]?.text);
  assert.equal((await fs.readFile(path.join(repository, "antigravity-worker-test.txt"), "utf8")).trim(), "isolated worker output");
  const deniedEditStarted = await request("tools/call", {
    name: "start_edit",
    arguments: {
      cwd: repository,
      task: "DENY_EDIT_TEST",
      acceptance_criteria: "Exercise a denied edit that produces no patch.",
    },
  });
  assert.equal(deniedEditStarted.isError, false, deniedEditStarted.content?.[0]?.text);
  const deniedEditCompleted = await request("tools/call", {
    name: "get_run",
    arguments: { run_id: deniedEditStarted.structuredContent.id, wait_ms: 5000 },
  });
  assert.equal(deniedEditCompleted.structuredContent.status, "failed");
  assert.equal(deniedEditCompleted.structuredContent.patch.empty, true);
  assert.match(deniedEditCompleted.structuredContent.error, /produced no code changes/i);
  assert.match(deniedEditCompleted.structuredContent.error, /RunCommand/);
  assert.equal(deniedEditCompleted.structuredContent.events.filter((event) => event.type === "started").length, 1);
  process.stdout.write("MCP transport, queueing, multimodal analysis, native image artifacts, multi-agent review, messaging, dashboard, isolated edit, and patch application: OK\n");
} finally {
  child.kill();
  await fs.rm(state, { recursive: true, force: true });
  await fs.rm(repository, { recursive: true, force: true });
}
