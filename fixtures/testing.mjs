import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const cliPath = fileURLToPath(new URL("./fake-adal.mjs", import.meta.url));

export async function setup() {
  const home = await mkdtemp(join(tmpdir(), "adal-test-home-"));
  await mkdir(join(home, ".adal"));
  await copyFile(new URL("./catalog.json", import.meta.url), join(home, ".adal/model_catalog.json"));
  await writeFile(join(home, ".adal/adal_oauth_creds.json"), JSON.stringify({ access_token: "fixture-token", expiry_date: Date.now() + 3600000 }), { mode: 0o600 });
  await chmod(cliPath, 0o755);
  const previous = Object.fromEntries(["HOME", "ADAL_AUTH_TOKEN", "ADAL_FIXTURE_FAILURE", "ADAL_PROXY_URL"].map(key => [key, process.env[key]]));
  process.env.HOME = home;
  delete process.env.ADAL_AUTH_TOKEN;
  delete process.env.ADAL_FIXTURE_FAILURE;
  return { home, options: { cliPath, timeoutMs: 2000 }, async close() {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  } };
}

export async function fakeProxy() {
  const state = { requests: [], respond: null };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64").toString("utf8")); }
    catch { response.writeHead(400).end(); return; }
    state.requests.push({ url: request.url, headers: request.headers, body });
    if (state.respond) return state.respond(request, response, body);
    const text = "你好 world";
    const wire = request.url.includes("/messages") ? "anthropic" : request.url.includes("/responses") ? "responses" : request.url.includes("/models/") ? "gemini" : "chat";
    const stream = wire === "gemini" ? request.url.includes("streamGenerateContent") : body.stream;
    const useTool = wire === "anthropic" && body.tools?.some(tool => tool.name === "echo") && !body.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result"));
    const block = useTool ? { type: "tool_use", id: "toolu_fixture", name: "echo", input: { text: "fixture-tool" } } : { type: "text", text };
    const answer = wire === "anthropic" ? { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [block], stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 8, output_tokens: 4 } }
      : wire === "responses" ? { id: "resp_test", object: "response", created_at: 1, status: "completed", model: body.model, output: [{ id: "item_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } }
      : wire === "gemini" ? { candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } }
      : { id: "chat_test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } };
    if (!stream) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(answer)); return; }
    response.setHeader("content-type", "text/event-stream");
    const emit = event => response.write((event.type ? `event: ${event.type}\n` : "") + `data: ${JSON.stringify(event)}\n\n`);
    if (wire === "anthropic") {
      emit({ type: "message_start", message: { ...answer, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } });
      emit({ type: "content_block_start", index: 0, content_block: useTool ? { ...block, input: {} } : { type: "text", text: "" } });
      emit({ type: "content_block_delta", index: 0, delta: useTool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text } });
      emit({ type: "content_block_stop", index: 0 });
      emit({ type: "message_delta", delta: { stop_reason: answer.stop_reason, stop_sequence: null }, usage: { output_tokens: 4 } });
      emit({ type: "message_stop" });
    } else if (wire === "responses") {
      emit({ type: "response.created", response: { ...answer, status: "in_progress", output: [] }, sequence_number: 0 });
      emit({ type: "response.output_item.added", output_index: 0, item: { ...answer.output[0], status: "in_progress", content: [] }, sequence_number: 1 });
      emit({ type: "response.content_part.added", item_id: "item_test", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] }, sequence_number: 2 });
      emit({ type: "response.output_text.delta", item_id: "item_test", output_index: 0, content_index: 0, delta: text, sequence_number: 3 });
      emit({ type: "response.output_item.done", output_index: 0, item: answer.output[0], sequence_number: 4 });
      emit({ type: "response.completed", response: answer, sequence_number: 5 });
    } else if (wire === "gemini") emit(answer);
    else {
      emit({ ...answer, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      emit({ ...answer, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      response.write("data: [DONE]\n\n");
    }
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(state, { url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
}
