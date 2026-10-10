#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
let initialized;
let pending;
let repair;
const reply = (answer) => {
  send({ type: "assistant.delta", text: answer.slice(0, 2) });
  send({ type: "assistant.delta", text: answer.slice(2) });
  send({ type: "assistant.message.completed", message: { content: answer } });
  send({ type: "command.completed" });
};
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "initialize") {
    initialized = command;
    if (command.permission_mode !== "default" || command.enabled_default_tools?.[0] !== "__magpie_external_tools_only__") throw new Error("Tool isolation was lost");
    const backend = createServer((request, response) => {
      if (request.url !== "/auth/usage") { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ plan: { name: "Pro" }, wallet_balance: 12.4, weekly_usage: { usage_percentage: 37.5, resets_at: "2026-10-12T00:00:00Z" } }));
    });
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    process.stderr.write(`Found available port: ${backend.address().port}\n`);
    send({ type: "ready", protocol_version: 1, session_id: "test-session" });
  } else if (command.type === "control_request") {
    send({ type: "control_response", request_id: command.request_id, subtype: command.request.model === "invalid-model" ? "error" : "success", error: "Unknown model" });
  } else if (command.type === "query") {
    if (repair) {
      if (repair === "repeat") {
        pending = { repair: "repeat" };
        send({ type: "control_request", request_id: "approval", request: { subtype: "can_use_tool", tool_name: "connector_execute", input: {} } });
      } else if (repair === "bridge") {
        repair = null;
        reply(JSON.stringify({ content: null, tool_calls: [{ name: "bash", arguments: { command: "printf EXTERNAL_ONLY" } }] }));
      } else {
        repair = null;
        reply("Internal tool denied");
      }
      continue;
    }
    const body = JSON.parse(command.input);
    const content = body.messages.at(-1).content;
    if (content === "hang") continue;
    if (content === "stream-hang") { send({ type: "assistant.delta", text: `PID:${process.pid}` }); continue; }
    if (content === "auth-error") { send({ type: "error", code: "AUTH_FAILED", message: "Not authenticated" }); continue; }
    if (["internal-tool", "internal-prefix", "internal-repeat", "internal-start-before", "internal-start-after"].includes(content)) {
      if (content === "internal-prefix") send({ type: "assistant.delta", text: "Checking." });
      const staged = content.startsWith("internal-start-");
      pending = { repair: content === "internal-repeat" ? "repeat" : "answer", staged, startAfter: content === "internal-start-after" };
      if (content === "internal-start-before") send({ type: "tool.started", toolCallId: "native", name: "connector_execute", args: {} });
      send({ type: "control_request", request_id: "approval", request: { subtype: "can_use_tool", tool_call_id: "native", tool_name: "connector_execute", input: {} } });
      continue;
    }
    if (content === "unknown-native") {
      send({ type: "tool.started", toolCallId: "lookup", name: "read_file", args: { path: "a.txt" } });
      send({ type: "tool.completed", toolCallId: "lookup", name: "read_file", status: "failed", result: { output: "No tool found matching 'read_file'. Available tools: []" } });
      repair = "bridge";
      send({ type: "command.completed" });
      continue;
    }
    if (["unregistered-bash", "native-execution-success", "wrong-lookup", "wrong-lookup-id"].includes(content)) {
      const args = { command: "printf EXTERNAL_ONLY" };
      send({ type: "tool.started", toolCallId: "lookup", name: "bash", args });
      send({ type: "tool.completed", toolCallId: content === "wrong-lookup-id" ? "other" : "lookup", name: "bash",
        status: content === "native-execution-success" ? "completed" : "failed",
        result: { output: content === "native-execution-success" ? "EXTERNAL_ONLY" : `No tool found matching '${content === "wrong-lookup" ? "write" : "bash"}'. Available tools: []` } });
      continue;
    }
    if (content === "native-bash" || content === "native-bash-prefix" || content === "native-invalid-args") {
      const args = content === "native-invalid-args" ? "not JSON" : { command: "printf EXTERNAL_ONLY" };
      if (!initialized.can_use_tool) { send({ type: "tool.started", name: "bash", args }); continue; }
      if (content === "native-bash-prefix") send({ type: "assistant.delta", text: "I will check using the external tool." });
      pending = "Native tool denied";
      send({ type: "control_request", request_id: "approval", request: { subtype: "can_use_tool", tool_name: "bash", input: args } });
      continue;
    }
    if (content === "ungated-tool") {
      send({ type: "tool.started", toolCallId: "native", name: "connector_execute", args: {} });
      send({ type: "tool.completed", toolCallId: "native", name: "connector_execute", status: "completed", result: { output: "Unexpected execution" } });
      continue;
    }
    if (content === "exit") { process.exit(1); }
    const answer = body.tools?.length ? JSON.stringify({ content: null, tool_calls: [{ name: body.tools[0].function.name, arguments: { path: "a.txt" } }] }) : "你好 world";
    reply(answer);
  } else if (command.type === "control_response" && pending) {
    if (command.request_id !== "approval" || command.response?.behavior !== "deny") throw new Error("An AdaL-native tool was permitted to execute");
    if (typeof pending === "string") reply(pending);
    else {
      if (pending.startAfter) send({ type: "tool.started", toolCallId: "native", name: "connector_execute", args: {} });
      if (pending.staged) send({ type: "tool.completed", toolCallId: "native", name: "connector_execute", status: "cancelled", result: { output: "Native execution denied" } });
      repair = pending.repair;
      send({ type: "command.completed" });
    }
    pending = null;
  } else if (command.type === "shutdown") {
    process.exit(0);
  }
}
