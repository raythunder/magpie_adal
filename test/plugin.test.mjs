import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { _internal } from "../index.mjs";

const tool = { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } };
const chat = { model: "default", messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "你好" }] };

test("exports one v1 server and preserves user provider configuration", async () => {
  assert.equal(typeof plugin.server, "function");
  const hooks = await plugin.server({}, {});
  const config = { provider: { adal: { name: "My AdaL", models: { custom: { name: "Custom" } } } } };
  await hooks.config(config);
  assert.equal(config.provider.adal.name, "My AdaL");
  assert.equal(config.provider.adal.models.custom.name, "Custom");
  assert.ok(config.provider.adal.models.default);
  assert.equal(hooks.auth.provider, "adal");
});

test("preserves conversation history, Unicode and tool results", () => {
  const messages = [...chat.messages, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] }, { role: "tool", tool_call_id: "call_1", content: "文件内容" }];
  const prompt = _internal.buildPrompt({ ...chat, messages, tools: [tool] });
  assert.deepEqual(JSON.parse(prompt).messages, messages);
});

test("rejects images instead of silently discarding them", () => {
  assert.throws(() => _internal.buildPrompt({ ...chat, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }] }] }), /text|image/i);
});

test("validates structured tool replies and returns OpenAI tool calls", () => {
  const body = { ...chat, tools: [tool], tool_choice: "required" };
  const result = _internal.parseReply('```json\n{"content":null,"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}\n```', body);
  assert.equal(result.tool_calls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { path: "a.txt" });
  assert.match(result.tool_calls[0].id, /^call_/);
  assert.throws(() => _internal.parseReply('{"tool_calls":[{"name":"bash","arguments":{}}]}', body), /unknown|allowed/i);
  assert.throws(() => _internal.parseReply('{"content":"done"}', body), /required/i);
  assert.throws(() => _internal.parseReply('{"tool_calls":[{"name":"read_file","arguments":{}}]}', { ...body, tool_choice: "none" }), /none|disabled/i);
});

test("plain text is preserved when no tools are requested", () => {
  assert.deepEqual(_internal.parseReply("你好，world", chat), { role: "assistant", content: "你好，world" });
});

test("malformed bridge output fails visibly instead of looking like successful text", () => {
  assert.throws(() => _internal.parseReply("I'll call read_file now", { ...chat, tools: [tool] }), /JSON/i);
});
