// Only used by runtime-regression-test.mjs with an isolated temporary ledger.
import fs from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("runtime-test mock 1"); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const prompt = value("-p") || "";
const conversation = args.includes("--conversation") ? value("--conversation") : `test-${process.pid}`;
const streamJson = value("--output-format") === "stream-json";
const log = event => fs.appendFile(process.env.ANTIGRAVITY_TEST_EVENTS, JSON.stringify({ event, pid: process.pid, conversation, prompt, at: Date.now() }) + "\n");
await log("start");
await new Promise(resolve => setTimeout(resolve, prompt.includes("TEST_SLOW") ? 1500 : 100));
await log("end");
const failed = prompt.includes("TEST_FAIL_COORD") && prompt.includes("You coordinate a team");
const result = { conversation_id: conversation, status: failed ? "FAILED" : "SUCCESS", response: failed ? "" : `MOCK_OK ${(prompt.match(/TEST_[A-Z_]+/g) || []).join(" ")}`, error: failed ? "intentional coordinator failure" : undefined };
if (streamJson) {
  console.log(JSON.stringify({ event: "init", conversation_id: conversation, init: { cwd: process.cwd() } }));
  if (result.response) console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: result.response } }));
  console.log(JSON.stringify({ event: "result", result }));
} else {
  console.log(JSON.stringify(result));
}
if (failed) process.exitCode = 1;
