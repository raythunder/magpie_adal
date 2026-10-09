import assert from "node:assert/strict";
import plugin from "../index.mjs";

const model = process.env.ADAL_TEST_MODEL || "default";
const hooks = await plugin.server({}, {});
const flow = await hooks.auth.methods[0].authorize();
const auth = await flow.callback();
assert.equal(auth.type, "success", auth.error);
console.log("AdaL local sign-in: OK");
const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: auth.access }));
const messages = [{ role: "user", content: "Reply with only MAGPIE_ADAL_OK. Do not use tools." }];
const call = async (body) => {
  const response = await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model, ...body }) });
  if (!response.ok) throw new Error(await response.text());
  return response;
};
const response = await call({ messages, stream: true });
const stream = await response.text();
assert.ok(stream.includes("data: [DONE]"));
const chunks = stream.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
assert.match(chunks.map((chunk) => chunk.choices[0].delta.content || "").join(""), /MAGPIE_ADAL_OK/);
console.log(`AdaL SSE (${model}): OK`);
const tools = [{ type: "function", function: { name: "echo", description: "Return the supplied text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } }];
const toolResponse = await call({ messages: [{ role: "user", content: "Call echo with text MAGPIE_TOOL_OK." }], tools, tool_choice: "required" });
const result = await toolResponse.json();
assert.equal(result.choices[0].finish_reason, "tool_calls");
const toolCall = result.choices[0].message.tool_calls[0];
assert.equal(toolCall.function.name, "echo");
assert.equal(JSON.parse(toolCall.function.arguments).text, "MAGPIE_TOOL_OK");
console.log("AdaL external tool bridge: OK (no tool executed)");
const followup = await call({ messages: [
  { role: "user", content: "Call echo with text MAGPIE_TOOL_OK." },
  result.choices[0].message,
  { role: "tool", tool_call_id: toolCall.id, content: "MAGPIE_TOOL_OK" },
  { role: "user", content: "What text did the tool return? Reply with only that text." },
] });
assert.match((await followup.json()).choices[0].message.content, /MAGPIE_TOOL_OK/);
console.log("AdaL conversation with tool result: OK");
