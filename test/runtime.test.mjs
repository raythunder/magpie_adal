import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { _internal } from "../index.mjs";
import { setup, fakeProxy } from "../fixtures/testing.mjs";

const env = await setup();
const cloud = await fakeProxy();
process.env.ADAL_PROXY_URL = cloud.url;
after(async () => { await cloud.close(); await env.close(); });
const request = (model = "default", extra = {}) => ({ method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "你好" }], ...extra }) });
const url = path => "http://127.0.0.1/adal/v1" + path;
const call = (path = "/messages", init = request(), options = env.options) => _internal.adalFetch(options, url(path), init);

test("authenticated subprocess sends native cloud request, original defaults and identity", async () => {
  const response = await call();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /你好 world/);
  const sent = cloud.requests.at(-1);
  assert.equal(sent.url, "/proxy/v1/messages");
  assert.equal(sent.headers.authorization, "Bearer fixture-token");
  assert.equal(sent.headers["x-provider"], "anthropic");
  assert.equal(sent.headers["x-target-url"], "https://api.anthropic.com");
  assert.equal(sent.headers["x-client-version"], "1.10.3");
  assert.equal(sent.headers["x-content-encoding"], "base64");
  assert.equal(sent.body.model, "claude-test");
  assert.equal(sent.body.max_tokens, 128000);
  assert.equal(sent.body.system, undefined);
  assert.deepEqual(sent.body.messages, [{ role: "user", content: "你好" }]);
});

test("native non-streaming replies retain upstream token usage", async () => {
  const response = await call("/messages", request("default", { stream: false }));
  const body = await response.json();
  assert.equal(body.content[0].text, "你好 world");
  assert.deepEqual(body.usage, { input_tokens: 8, output_tokens: 4 });
  assert.equal(cloud.requests.at(-1).body.stream, true);
});

test("an omitted stream flag means a complete native response", async () => {
  const response = await call();
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await response.json()).content[0].text, "你好 world");
});

test("Request inputs preserve native beta headers without forwarding caller credentials", async () => {
  const input = new Request(url("/messages"), { ...request(), headers: { "anthropic-beta": "test-beta", "x-api-key": "caller-secret", Authorization: "Bearer caller-secret" } });
  await (await _internal.adalFetch(env.options, input)).text();
  const sent = cloud.requests.at(-1);
  assert.equal(sent.headers["anthropic-beta"], "test-beta");
  assert.equal(sent.headers["x-api-key"], "dummy");
  assert.equal(sent.headers.authorization, "Bearer fixture-token");
});

test("all native APIs use their original target and model route", async () => {
  for (const [path, model, target, upstream] of [
    ["/responses", "openai-test", "https://api.openai.com/v1", "/proxy/responses"],
    ["/chat/completions", "kimi-test", "https://api.moonshot.ai/v1", "/proxy/chat/completions"],
    ["/models/google-test:streamGenerateContent?alt=sse", "google-test", "https://generativelanguage.googleapis.com", "/proxy/v1beta/models/gemini-test:streamGenerateContent?alt=sse"],
  ]) {
    const response = await call(path, request(model, { input: "hi", contents: [{ role: "user", parts: [{ text: "hi" }] }], stream: true }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /你好 world/);
    assert.equal(cloud.requests.at(-1).headers["x-target-url"], target);
    assert.equal(cloud.requests.at(-1).url, upstream);
  }
});

test("tool schemas, signatures and tool results remain native and unmodified", async () => {
  const messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "signed" }, { type: "tool_use", id: "call", name: "echo", input: { text: "你好" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "你好" }] }];
  const tools = [{ name: "echo", input_schema: { type: "object" } }];
  await (await call("/messages", request("default", { messages, tools, tool_choice: { type: "auto" } }))).text();
  assert.deepEqual(cloud.requests.at(-1).body.messages, messages);
  assert.deepEqual(cloud.requests.at(-1).body.tools, tools);
});

test("invalid input and unknown models fail before any cloud request", async () => {
  const count = cloud.requests.length;
  for (const init of [{ method: "POST", body: "not JSON" }, request("unknown"), request("chatgpt-test")]) {
    assert.equal((await call("/messages", init)).status, 400);
  }
  assert.equal((await call("/auth/context")).status, 400);
  assert.equal((await call("/messages", { method: "GET" })).status, 400);
  assert.equal((await call("/responses", request())).status, 400);
  assert.equal(cloud.requests.length, count);
});

test("BYOAK and failed model selection cannot silently change the billing/model path", async () => {
  const count = cloud.requests.length;
  for (const failure of ["byoak", "wrong-model"]) {
    process.env.ADAL_FIXTURE_FAILURE = failure;
    try { assert.equal((await call()).status, 400); }
    finally { delete process.env.ADAL_FIXTURE_FAILURE; }
  }
  assert.equal(cloud.requests.length, count);
});

test("SDK authentication failures lapse the marker without exposing credentials", async () => {
  process.env.ADAL_FIXTURE_FAILURE = "auth";
  try {
    const response = await call();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired");
    assert.doesNotMatch(await response.text(), /fixture-token/);
  } finally { delete process.env.ADAL_FIXTURE_FAILURE; }
});

test("refreshed local credentials are read for each request", async () => {
  const path = join(env.home, ".adal/adal_oauth_creds.json");
  const original = await readFile(path, "utf8");
  try {
    await writeFile(path, JSON.stringify({ access_token: "renewed-fixture-token" }));
    await (await call()).text();
    assert.equal(cloud.requests.at(-1).headers.authorization, "Bearer renewed-fixture-token");
  } finally { await writeFile(path, original); }
});

test("upstream status and sign-in state remain visible", async () => {
  for (const status of [401, 402, 429, 503]) {
    cloud.respond = (_req, response) => response.writeHead(status, { "content-type": "application/json", "retry-after": "3" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "unavailable" } }));
    try {
      const response = await call();
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "3");
      assert.equal(response.headers.get("X-Magpie-Sign-In"), status === 401 ? "expired" : "kept");
      assert.match(await response.text(), /unavailable/);
    } finally { cloud.respond = null; }
  }
});

test("truncated native streams fail rather than looking complete", async () => {
  cloud.respond = (_req, response) => response.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n');
  try { await assert.rejects((await call("/messages", request("default", { stream: true }))).text(), /before completion/); }
  finally { cloud.respond = null; }
});

test("streamed upstream errors become native non-streaming errors with status", async () => {
  cloud.respond = (_req, response) => response.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n');
  try { const response = await call(); assert.equal(response.status, 529); assert.match(await response.text(), /busy/); }
  finally { cloud.respond = null; }
});

test("redirects cannot forward the credential to a different destination", async () => {
  cloud.respond = (_req, response) => response.writeHead(307, { location: "https://example.com" }).end();
  try { const response = await call(); assert.equal(response.status, 502); assert.match(await response.text(), /redirect/); }
  finally { cloud.respond = null; }
});

test("oversized requests are rejected before sending credentials or starting a query", async () => {
  const count = cloud.requests.length;
  const response = await call("/messages", request("default", { messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] }));
  assert.equal(response.status, 413);
  assert.equal(cloud.requests.length, count);
});

test("stream cancellation closes the upstream connection", async () => {
  let close;
  const disconnected = new Promise(resolve => { close = resolve; });
  cloud.respond = (req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n');
    response.on("close", close);
  };
  try {
    const reader = (await call("/messages", request("default", { stream: true }))).body.getReader();
    await reader.read();
    await reader.cancel();
    await disconnected;
  } finally { cloud.respond = null; }
});

test("request abort stops a stalled initialization", async () => {
  process.env.ADAL_FIXTURE_FAILURE = "hang";
  const controller = new AbortController();
  try {
    const pending = call("/messages", { ...request(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, { name: "AbortError" });
  } finally { delete process.env.ADAL_FIXTURE_FAILURE; }
});

test("the request timeout remains active while reading the cloud response", async () => {
  cloud.respond = (_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n');
  };
  try {
    const response = await call("/messages", request("default", { stream: true }), { ...env.options, timeoutMs: 1000 });
    await assert.rejects(response.text(), /timed out|abort/i);
  } finally { cloud.respond = null; }
});

test("initialization timeout returns 504 and missing executables are actionable", async () => {
  process.env.ADAL_FIXTURE_FAILURE = "hang";
  try { assert.equal((await call("/messages", request(), { ...env.options, timeoutMs: 1000 })).status, 504); }
  finally { delete process.env.ADAL_FIXTURE_FAILURE; }
  const response = await call("/messages", request(), { cliPath: "/does/not/exist" });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /cliPath|Install/);
});
