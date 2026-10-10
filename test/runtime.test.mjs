import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import plugin, { _internal } from "../index.mjs";

const cliPath = fileURLToPath(new URL("../fixtures/fake-adal.mjs", import.meta.url));
await chmod(cliPath, 0o755);
const options = { cliPath, timeoutMs: 1000 };
const url = "http://127.0.0.1/adal/v1/chat/completions";
const request = (content, extra = {}) => ({ method: "POST", body: JSON.stringify({ model: "default", messages: [{ role: "user", content }], ...extra }) });

function parseSSE(text) {
  return text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
}

test("local sign-in checks the runtime without spending a model query", async () => {
  const hooks = await plugin.server({}, options);
  const flow = await hooks.auth.methods[0].authorize();
  const result = await flow.callback();
  assert.equal(result.type, "success");
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: result.access }));
  assert.equal(typeof loader.fetch, "function");
});

test("real subprocess produces standard non-streaming chat response", async () => {
  const response = await _internal.adalFetch(options, url, request("hello"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "你好 world");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.model, "default");
});

test("SSE sends Unicode once, a finish reason and DONE", async () => {
  const response = await _internal.adalFetch(options, url, request("hello", { stream: true }));
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const text = await response.text();
  const chunks = parseSSE(text);
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || "").join(""), "你好 world");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("SSE translates external tool calls without executing them", async () => {
  const response = await _internal.adalFetch(options, url, request("read a file", {
    stream: true, tools: [{ type: "function", function: { name: "read_file" } }], tool_choice: "required",
  }));
  const chunks = parseSSE(await response.text());
  const call = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])[0];
  assert.equal(call.function.name, "read_file");
  assert.equal(call.index, 0);
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.txt" });
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("unknown models fail before AdaL can silently select its default", async () => {
  const response = await _internal.adalFetch(options, url, request("hello", { model: "invalid-model" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Unknown AdaL model/);
});

test("auth rejection is visible to Magpie", async () => {
  const response = await _internal.adalFetch(options, url, request("auth-error"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired");
});

test("native external calls are denied in AdaL and returned for the caller to execute", async () => {
  const response = await _internal.adalFetch(options, url, request("native-bash", {
    tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "required",
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "bash");
  assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { command: "printf EXTERNAL_ONLY" });
});

test("native tool bridging preserves streamed preamble and produces valid SSE", async () => {
  const response = await _internal.adalFetch(options, url, request("native-bash-prefix", {
    stream: true, tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "required",
  }));
  const chunks = parseSSE(await response.text());
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || "").join(""), "I will check using the external tool.");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("native argument validation remains required", async () => {
  const response = await _internal.adalFetch(options, url, request("native-invalid-args", {
    tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "required",
  }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /arguments/i);
});

test("AdaL-only tools are denied without discarding the eventual answer", async () => {
  const response = await _internal.adalFetch(options, url, request("internal-tool"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Internal tool denied");
});

test("unregistered native calls are bridged only after confirming failed lookup", async () => {
  const response = await _internal.adalFetch(options, url, request("unregistered-bash", {
    tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "required",
  }));
  assert.equal(response.status, 200);
  const call = (await response.json()).choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "bash");
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "printf EXTERNAL_ONLY" });
});

test("execution, a different lookup error, or mismatched IDs cannot be bridged", async () => {
  for (const content of ["native-execution-success", "wrong-lookup", "wrong-lookup-id"]) {
    const response = await _internal.adalFetch(options, url, request(content, {
      tools: [{ type: "function", function: { name: "bash" } }],
    }));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /permission gate/i);
  }
});

test("denied native turns resume with a model-only reply and valid text SSE", async () => {
  const response = await _internal.adalFetch(options, url, request("internal-prefix", { stream: true }));
  const chunks = parseSSE(await response.text());
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || "").join(""), "Checking.\n\nInternal tool denied");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("native start markers around denied approval do not imply execution", async () => {
  for (const content of ["internal-start-before", "internal-start-after"]) {
    const response = await _internal.adalFetch(options, url, request(content));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "Internal tool denied");
  }
});

test("a hallucinated unregistered name is repaired without being passed to the caller", async () => {
  const response = await _internal.adalFetch(options, url, request("unknown-native", {
    tools: [{ type: "function", function: { name: "bash" } }], tool_choice: "required",
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.tool_calls[0].function.name, "bash");
});

test("repeated native denials stop after one repair attempt", async () => {
  const response = await _internal.adalFetch(options, url, request("internal-repeat"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /model-only reply/i);
});

test("unapproved native results never become a successful external call", async () => {
  const response = await _internal.adalFetch(options, url, request("ungated-tool"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /internal tool|permission gate/i);
});

test("unexpected process exit is an error", async () => {
  const response = await _internal.adalFetch(options, url, request("exit"));
  assert.equal(response.status, 502);
});

test("timeouts terminate the child and return 504", async () => {
  const response = await _internal.adalFetch(options, url, request("hang"));
  assert.equal(response.status, 504);
});

test("aborted requests stop the child instead of waiting for the timeout", async () => {
  const controller = new AbortController();
  const promise = _internal.adalFetch({ ...options, timeoutMs: 30000 }, url, { ...request("hang"), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, { name: "AbortError" });
});

test("cancelling the response body terminates a stalled streaming process", async () => {
  const response = await _internal.adalFetch({ ...options, timeoutMs: 30000 }, url, request("stream-hang", { stream: true }));
  const reader = response.body.getReader();
  await reader.read();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  const pid = Number(parseSSE(text)[0].choices[0].delta.content.slice(4));
  await reader.cancel();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("invalid JSON and unsupported content return 400 before spawning", async () => {
  const response = await _internal.adalFetch({ cliPath: "/does/not/exist" }, url, { body: "not JSON" });
  assert.equal(response.status, 400);
});

test("missing executable gives actionable failure", async () => {
  const response = await _internal.adalFetch({ cliPath: "/does/not/exist" }, url, request("hello"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /cliPath|Install/);
});
