import assert from "node:assert/strict";
import plugin from "../index.mjs";
import { readCatalog, resolveModel, routeOf } from "../models.mjs";

const key = process.env.ADAL_TEST_MODEL || "default";
const model = resolveModel(key, await readCatalog());
const { wire } = routeOf(model);
const id = model.model_kwargs.model;
const hooks = await plugin.server({}, {});
const flow = await hooks.auth.methods[0].authorize();
const auth = await flow.callback();
assert.equal(auth.type, "success", auth.error);
console.log("AdaL local SDK authentication: OK");
const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: auth.access }));
const path = wire === "anthropic" ? "/messages" : wire === "responses" ? "/responses" : wire === "chat" ? "/chat/completions" : `/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`;
const prompt = "Reply with exactly MAGPIE_ADAL_OK, and nothing else.";
const textBody = wire === "responses" ? { model: id, input: [{ role: "user", content: prompt }], stream: true }
  : wire === "gemini" ? { contents: [{ role: "user", parts: [{ text: prompt }] }] }
  : { model: id, messages: [{ role: "user", content: prompt }], stream: true };
const call = async body => {
  const response = await loader.fetch(loader.baseURL + path, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`AdaL HTTP ${response.status}: ${await response.text()}`);
  return response;
};
const response = await call(textBody);
const text = await response.text();
const events = text.split("\n").filter(line => line.startsWith("data:")).flatMap(line => {
  try { return [JSON.parse(line.slice(5))]; } catch { return []; }
});
let answer;
if (wire === "anthropic") answer = events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("");
else if (wire === "responses") answer = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
else if (wire === "gemini") answer = events.flatMap(event => event.candidates?.[0]?.content?.parts || []).filter(part => !part.thought).map(part => part.text || "").join("");
else answer = events.map(event => event.choices?.[0]?.delta?.content || "").join("");
assert.equal(answer?.trim(), "MAGPIE_ADAL_OK");
const usage = wire === "anthropic" ? { ...events.find(event => event.type === "message_start")?.message?.usage, ...events.findLast(event => event.type === "message_delta")?.usage }
  : wire === "responses" ? events.findLast(event => event.response?.usage)?.response.usage
  : wire === "gemini" ? events.findLast(event => event.usageMetadata)?.usageMetadata
  : events.findLast(event => event.usage)?.usage;
console.log(`AdaL native SSE (${key}, ${wire}): OK; usage=${JSON.stringify(usage)}`);
if (!process.argv.includes("--text-only")) {
  assert.equal(wire, "anthropic", "Use --text-only for the non-Anthropic smoke check; native tool round-trip is verified with Anthropic.");
  const messages = [{ role: "user", content: "Call echo once with text MAGPIE_TOOL_OK. Do not answer without calling echo." }];
  const tools = [{ name: "echo", description: "Return the supplied text", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }];
  const proposed = await (await call({ model: id, messages, tools, stream: false })).json();
  assert.equal(proposed.stop_reason, "tool_use");
  const tool = proposed.content.find(block => block.type === "tool_use");
  assert.equal(tool?.name, "echo");
  assert.deepEqual(tool.input, { text: "MAGPIE_TOOL_OK" });
  console.log("AdaL native non-streaming tool_use: OK (no tool executed)");
  const followup = await (await call({ model: id, tools, stream: false, messages: [
    ...messages, { role: "assistant", content: proposed.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "MAGPIE_TOOL_OK", is_error: false }, { type: "text", text: "Reply with exactly the text the tool returned, and nothing else." }] },
  ] })).json();
  assert.equal(followup.content.filter(block => block.type === "text").map(block => block.text).join("").trim(), "MAGPIE_TOOL_OK");
  console.log("AdaL native tool_result conversation: OK");
}
