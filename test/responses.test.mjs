import assert from "node:assert/strict";
import { test } from "node:test";
import { WHOLE } from "../responses.mjs";

test("Anthropic aggregation retains signed thinking, tool input and both usage events", () => {
  const response = WHOLE.anthropic([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", usage: { input_tokens: 10, cache_read_input_tokens: 8 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c", name: "echo", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"text":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"你好"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
  assert.deepEqual(response.content, [{ type: "thinking", thinking: "reason", signature: "signed" }, { type: "tool_use", id: "c", name: "echo", input: { text: "你好" } }]);
  assert.deepEqual(response.usage, { input_tokens: 10, cache_read_input_tokens: 8, output_tokens: 5 });
  assert.equal(response.stop_reason, "tool_use");
});

test("invalid native tool JSON is never substituted with empty arguments", () => {
  assert.throws(() => WHOLE.anthropic([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "echo" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } },
  ]), SyntaxError);
});

test("Anthropic aggregation retains citations from each text block delta", () => {
  const citation = { type: "char_location", cited_text: "source", document_index: 0, document_title: "Doc", start_char_index: 0, end_char_index: 6 };
  const response = WHOLE.anthropic([
    { type: "message_start", message: { id: "m", role: "assistant" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: [] } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer" } },
    { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } },
    { type: "message_stop" },
  ]);
  assert.deepEqual(response.content, [{ type: "text", text: "Answer", citations: [citation] }]);
});

test("Responses uses its authoritative final output and exact token counts", () => {
  const response = { id: "r", output: [{ type: "function_call", name: "echo", arguments: "{}" }], usage: { input_tokens: 2, output_tokens: 3 } };
  assert.deepEqual(WHOLE.responses([{ type: "response.completed", response }]), response);
  assert.equal(WHOLE.responses([{ type: "response.output_text.delta", delta: "partial" }]), null);
});

test("chat aggregation joins partial function arguments and retains reasoning", () => {
  const response = WHOLE.chat([
    { id: "r", choices: [{ index: 0, delta: { reasoning_content: "reason", tool_calls: [{ index: 0, id: "c", function: { name: "echo", arguments: '{"text":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, finish_reason: "tool_calls" }], usage: { total_tokens: 10 } },
  ]);
  assert.equal(response.choices[0].message.reasoning_content, "reason");
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.equal(response.usage.total_tokens, 10);
});

test("Gemini retains function call thought signatures and usage", () => {
  const response = WHOLE.gemini([{ candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: {} }, thoughtSignature: "signed" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 12 } }]);
  assert.equal(response.candidates[0].content.parts[0].thoughtSignature, "signed");
  assert.equal(response.usageMetadata.totalTokenCount, 12);
  assert.deepEqual(WHOLE.gemini([{ promptFeedback: { blockReason: "SAFETY" } }]).promptFeedback, { blockReason: "SAFETY" });
});
