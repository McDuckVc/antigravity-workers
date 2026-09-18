import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--version")) {
  process.stdout.write("agy mock 1.0.0\n");
  process.exit(0);
}

const prompt = valueAfter("-p") || "";
const conversation = valueAfter("--conversation") || `mock-${Date.now()}-${process.pid}`;
const streamJson = valueAfter("--output-format") === "stream-json";
const emitResult = (result) => {
  if (!streamJson) return process.stdout.write(JSON.stringify(result));
  process.stdout.write(`${JSON.stringify({ event: "init", conversation_id: conversation, init: { cwd: process.cwd() } })}\n`);
  if (result.response) {
    process.stdout.write(`${JSON.stringify({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: result.response } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ event: "result", result })}\n`);
};
if (prompt.includes("FAIL_ONCE") && process.env.ANTIGRAVITY_MOCK_FAIL_ONCE_FILE) {
  const marker = process.env.ANTIGRAVITY_MOCK_FAIL_ONCE_FILE;
  const exists = await fs.stat(marker).then(() => true).catch(() => false);
  if (!exists) {
    await fs.writeFile(marker, "failed once\n", "utf8");
    emitResult({ conversation_id: conversation, status: "FAILED", error: "intentional first-attempt failure" });
    process.exit(1);
  }
}
if (prompt.includes("CREATE_EDIT_TEST_FILE")) {
  await fs.writeFile("antigravity-worker-test.txt", "isolated worker output\n", "utf8");
}
if (prompt.includes("STREAM_CAP_TEST")) {
  process.stdout.write(`${JSON.stringify({ event: "step_update", step_update: { step_index: 99, state: "ACTIVE", step_type: "system_message", text_delta: "x".repeat(4096) } })}\n`);
}
if (prompt.includes("native generate_image tool") && process.env.ANTIGRAVITY_BRAIN_DIR) {
  const outputDirectory = path.join(process.env.ANTIGRAVITY_BRAIN_DIR, conversation);
  await fs.mkdir(outputDirectory, { recursive: true });
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=", "base64");
  await fs.writeFile(path.join(outputDirectory, "mock-generated.png"), tinyPng);
}
await new Promise((resolve) => setTimeout(resolve, 80));
emitResult({
  conversation_id: conversation,
  status: "SUCCESS",
  response: prompt.includes("native generate_image tool") ? "" : prompt.includes("DENY_EDIT_TEST") ? "The requested command was denied." : `MOCK_OK: ${prompt.slice(0, 80)}`,
  denied_actions: prompt.includes("DENY_EDIT_TEST") ? { action: "command", display_name: "RunCommand" } : undefined,
  duration_seconds: 0.08,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
});
