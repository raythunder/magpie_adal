#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
let initialized;
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
    const body = JSON.parse(command.input);
    const content = body.messages.at(-1).content;
    if (content === "hang") continue;
    if (content === "stream-hang") { send({ type: "assistant.delta", text: `PID:${process.pid}` }); continue; }
    if (content === "auth-error") { send({ type: "error", code: "AUTH_FAILED", message: "Not authenticated" }); continue; }
    if (content === "internal-tool") { send({ type: "control_request", request_id: "approval", request: { subtype: "can_use_tool" } }); continue; }
    if (content === "exit") { process.exit(1); }
    const answer = body.tools?.length ? JSON.stringify({ content: null, tool_calls: [{ name: body.tools[0].function.name, arguments: { path: "a.txt" } }] }) : "你好 world";
    send({ type: "assistant.delta", text: answer.slice(0, 2) });
    send({ type: "assistant.delta", text: answer.slice(2) });
    send({ type: "assistant.message.completed", message: { content: answer } });
    send({ type: "command.completed" });
  } else if (command.type === "shutdown") {
    process.exit(0);
  }
}
