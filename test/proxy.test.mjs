import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { modelEntries, resolveModel } from "../models.mjs";
import { nativeRequest, wireOf } from "../proxy.mjs";

const catalog = JSON.parse(await readFile(new URL("../fixtures/catalog.json", import.meta.url), "utf8"));

test("models use each provider's native SDK and retain selectable catalog keys", () => {
  const models = modelEntries(catalog);
  assert.equal(models.default.provider.npm, "@ai-sdk/anthropic");
  assert.equal(models["anthropic-test"].id, "claude-test");
  assert.equal(models["google-test"].id, "gemini-test");
  assert.equal(models["openai-test"].provider.npm, "@ai-sdk/openai");
  assert.equal(models["google-test"].provider.npm, "@ai-sdk/google");
  assert.equal(models["kimi-test"].provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["anthropic-test"].limit.output, 128000);
  assert.equal(models["openai-test"].limit.output, 128000);
  assert.equal(models["anthropic-test"].variants.low.effort, "low");
  assert.deepEqual(models["anthropic-test"].modalities.input, ["text", "image"]);
  assert.equal(models["chatgpt-test"], undefined);
});

test("unknown and non-proxy models fail instead of falling back or changing billing", () => {
  assert.equal(resolveModel("default", catalog).key, "anthropic-test");
  assert.throws(() => resolveModel("unknown", catalog), /Unknown AdaL model/);
  assert.throws(() => resolveModel("chatgpt-test", catalog), /cloud proxy/);
  assert.equal(resolveModel("claude-test", catalog).key, "anthropic-test");
  assert.throws(() => resolveModel("claude-test", { ...catalog, models: [...catalog.models, { ...catalog.models[0], key: "duplicate" }] }), /Ambiguous/);
});

test("Anthropic forwards native history, images and tools with AdaL defaults", () => {
  const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] }];
  const tools = [{ name: "echo", input_schema: { type: "object" } }];
  const request = nativeRequest(resolveModel("default", catalog), { model: "default", messages, tools, stream: true });
  assert.equal(request.model, "claude-test");
  assert.deepEqual(request.messages, messages);
  assert.deepEqual(request.tools, tools);
  assert.equal(request.max_tokens, 128000);
  assert.deepEqual(request.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(request.output_config.effort, "medium");
  assert.equal(request.max_input_tokens, undefined);
  assert.equal(request.system, undefined);
});

test("explicit caller overrides preserve other native defaults", () => {
  const request = nativeRequest(resolveModel("default", catalog), { model: "default", messages: [], max_tokens: 64, output_config: { effort: "low" }, stream: false });
  assert.equal(request.max_tokens, 64);
  assert.equal(request.output_config.effort, "low");
  assert.equal(request.stream, false);
  assert.equal(request.thinking.type, "adaptive");
});

test("Responses normalization matches AdaL and preserves tool output items", () => {
  const model = { ...resolveModel("openai-test", catalog), model_kwargs: { model: "gpt-test", max_input_tokens: 1000, max_tokens: 128, reasoning_effort: "medium" } };
  const input = [{ type: "function_call_output", call_id: "c", output: "工具结果" }];
  const request = nativeRequest(model, { input, stream: true });
  assert.equal(request.max_output_tokens, 128);
  assert.equal(request.max_tokens, undefined);
  assert.equal(request.max_input_tokens, undefined);
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.reasoning_effort, undefined);
  assert.deepEqual(request.input, input);
  assert.deepEqual(request.text.format, { type: "text" });
});

test("Gemini converts catalog defaults into native REST generationConfig", () => {
  const request = nativeRequest(resolveModel("google-test", catalog), { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: "low" } } });
  assert.equal(request.generationConfig.maxOutputTokens, 65536);
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: "low", includeThoughts: true });
  assert.equal(request.generationConfig.temperature, 0.2);
  assert.equal(request.model, undefined);
  assert.equal(request.stream, undefined);
  assert.equal(request.thinking_config, undefined);
});

test("only known native paths are served; Gemini model ids are decoded safely", () => {
  assert.equal(wireOf("http://127.0.0.1/adal/v1/messages").wire, "anthropic");
  assert.equal(wireOf("http://127.0.0.1/adal/v1/responses").wire, "responses");
  assert.equal(wireOf("http://127.0.0.1/adal/v1/chat/completions").wire, "chat");
  assert.deepEqual(wireOf("http://127.0.0.1/adal/v1/models/google-test:streamGenerateContent?alt=sse"), { wire: "gemini", model: "google-test", stream: true });
  assert.equal(wireOf("http://127.0.0.1/adal/v1/auth/context"), null);
});
