import { readCatalog, resolveModel, routeOf } from "./models.mjs";
import { withRuntime, localToken } from "./runtime.mjs";
import { WHOLE } from "./responses.mjs";

const invalid = message => Object.assign(new Error(message), { status: 400 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const merge = (base, extra) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(extra)])].map(key => [key,
  object(base[key]) && object(extra[key]) ? merge(base[key], extra[key]) : extra[key] === undefined ? base[key] : extra[key],
]));

async function requestText(raw, signal) {
  const limit = 4 * 1024 * 1024;
  const tooLarge = () => Object.assign(new Error("Request exceeds 4 MiB"), { status: 413 });
  signal.throwIfAborted();
  if (!(raw instanceof ReadableStream)) {
    if (Buffer.byteLength(raw) > limit) throw tooLarge();
    return typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  }
  const reader = raw.getReader();
  const cancel = reason => { void reader.cancel(reason).catch(() => {}); };
  const abort = () => cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function wireOf(url) {
  const path = new URL(url).pathname;
  const gemini = path.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)$/);
  if (gemini) return { wire: "gemini", model: decodeURIComponent(gemini[1]), stream: gemini[2] === "streamGenerateContent" };
  if (path.endsWith("/messages")) return { wire: "anthropic" };
  if (path.endsWith("/responses")) return { wire: "responses" };
  if (path.endsWith("/chat/completions")) return { wire: "chat" };
  return null;
}

// 只转换原工具的目录参数；消息、工具、推理块和输出均保持供应商原生结构。
export function nativeRequest(model, body, config = {}) {
  const wire = routeOf(model).wire;
  const defaults = structuredClone(model.model_kwargs);
  delete defaults.max_input_tokens;
  if (config.effort && ["output_config.effort", "reasoning.effort", "reasoning_effort", "thinking_config.thinking_level"].includes(model.config_options?.effort_path)) {
    const keys = model.config_options.effort_path.split(".");
    let target = defaults;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = config.effort;
  }
  if (wire === "gemini") {
    const thinking = defaults.thinking_config || {};
    const generationConfig = {
      ...(defaults.max_output_tokens !== undefined ? { maxOutputTokens: defaults.max_output_tokens } : {}),
      ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
      ...(defaults.top_p !== undefined ? { topP: defaults.top_p } : {}),
      ...(Object.keys(thinking).length ? { thinkingConfig: {
        ...(thinking.thinking_level !== undefined ? { thinkingLevel: thinking.thinking_level } : {}),
        ...(thinking.thinking_budget !== undefined ? { thinkingBudget: thinking.thinking_budget } : {}),
        ...(thinking.include_thoughts !== undefined ? { includeThoughts: thinking.include_thoughts } : {}),
      } } : {}),
    };
    const result = merge({ generationConfig }, body);
    delete result.model; delete result.stream;
    return result;
  }
  const result = merge(defaults, body);
  result.model = defaults.model;
  delete result.max_input_tokens;
  if (wire === "responses") {
    if (result.max_output_tokens === undefined && result.max_tokens !== undefined) result.max_output_tokens = result.max_tokens;
    delete result.max_tokens; delete result.stop;
    if (result.reasoning_effort !== undefined) {
      result.reasoning = { effort: result.reasoning_effort, ...result.reasoning };
      delete result.reasoning_effort;
    }
    if (!result.tools?.length) result.text = merge({ format: { type: "text" } }, result.text || {});
  }
  return result;
}

function proxyRoot() {
  const url = new URL(process.env.ADAL_PROXY_URL?.trim() || process.env.ADAL_APP_URL?.trim() || process.env.BACKEND_API_URL?.trim() || "https://adal.sylph.ai");
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("AdaL proxy URL must use HTTPS (HTTP is allowed only on loopback)");
  return url.href.replace(/\/$/, "") + "/proxy";
}

function errorResponse(error, wire) {
  const status = error.name === "TimeoutError" ? 504 : error.status || 502;
  const type = status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "api_error";
  const body = wire === "gemini" ? { error: { code: status, message: error.message, status: type } } : { ...(wire === "anthropic" ? { type: "error" } : {}), error: { type, message: error.message } };
  return Response.json(body, { status, headers: { "X-Magpie-Sign-In": error.signIn || "kept" } });
}

function forward(response, wire, streaming, controller, cleanup) {
  const headers = new Headers(response.headers);
  // fetch 已解压响应体，不能保留线上压缩长度和编码。
  headers.delete("content-length"); headers.delete("content-encoding");
  headers.set("X-Magpie-Sign-In", response.status === 401 ? "expired" : "kept");
  const reader = response.body?.getReader();
  if (!reader) { cleanup(); return new Response(null, { status: response.status, headers }); }
  const decoder = new TextDecoder();
  let pending = "", terminal = false, finish = false, size = 0;
  const observe = text => {
    pending += text;
    const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (value === "[DONE]") { terminal = finish; continue; }
      let event;
      try { event = JSON.parse(value); } catch { continue; }
      if (event.type === "error" || event.error) terminal = true;
      if (wire === "anthropic" && event.type === "message_stop") terminal = true;
      if (wire === "responses" && ["response.completed", "response.incomplete", "response.failed"].includes(event.type)) terminal = true;
      if (wire === "chat" && event.choices?.some(choice => choice.finish_reason)) finish = true;
      if (wire === "gemini" && (event.candidates?.some(candidate => candidate.finishReason) || event.promptFeedback?.blockReason)) terminal = true;
    }
  };
  return new Response(new ReadableStream({
    async pull(output) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (streaming && response.ok) {
            observe(decoder.decode() + "\n");
            if (!terminal) throw new Error("AdaL proxy stream ended before completion");
          }
          cleanup(); output.close(); return;
        }
        size += next.value.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error("AdaL proxy response exceeds 16 MiB");
        if (streaming && response.ok) observe(decoder.decode(next.value, { stream: true }));
        output.enqueue(next.value);
      } catch (error) {
        controller.abort(error); cleanup();
        await reader.cancel().catch(() => {});
        output.error(error);
      }
    },
    async cancel(reason) { controller.abort(reason); cleanup(); await reader.cancel(reason).catch(() => {}); },
  }), { status: response.status, headers });
}

export async function adalFetch(options, input, init = {}) {
  const request = input instanceof Request ? input : null;
  const signal = init.signal || request?.signal;
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("AdaL request timed out", "TimeoutError")), options.timeoutMs || 300000);
  const cleanup = () => clearTimeout(timer);
  let wire;
  try {
    const path = wireOf(request?.url || String(input));
    if (!path) throw invalid("Only native model API endpoints are supported");
    wire = path.wire;
    if ((init.method || request?.method || "GET").toUpperCase() !== "POST") throw invalid("Use POST for model requests");
    const text = await requestText(init.body ?? request?.body ?? "", combined);
    let body;
    try { body = JSON.parse(text); } catch { throw invalid("Invalid JSON request body"); }
    if (!object(body)) throw invalid("Request body must be a JSON object");
    const key = path.model || body.model;
    if (typeof key !== "string" || !key) throw invalid("model is required");
    const initial = resolveModel(key, await readCatalog());
    if (routeOf(initial).wire !== wire) throw invalid("The model's native API changed; reload the AdaL plugin");
    const response = await withRuntime(options, { model: initial.key, signal: combined }, async ({ get, sessionId }) => {
      const context = await get("/auth/context");
      if (!context.authenticated) throw Object.assign(new Error("AdaL is not authenticated; run adal to sign in."), { status: 401, signIn: "expired" });
      const info = await get("/model/info");
      const model = resolveModel(key, await readCatalog());
      if (info.model !== model.key || routeOf(model).wire !== wire) throw invalid("AdaL selected a different model; refresh its catalog and reload the plugin");
      if (info.connection_mode !== "proxy") throw invalid("This AdaL model uses local/BYOAK/connected credentials; use the AdaL CLI to preserve its billing path");
      const config = await get("/model/config");
      const route = routeOf(model);
      const token = await localToken();
      const headers = {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
        "X-Provider": model.provider, "X-Target-URL": route.target, "X-Session-ID": sessionId,
        "X-Content-Encoding": "base64", "X-Client-Call-Site": "agent.turn",
      };
      for (const [name, value] of Object.entries({ "X-Client-Source": context.client_surface || context.source, "X-Client-Entrypoint": context.client_entrypoint, "X-Client-OS": context.os, "X-Client-Version": context.client_version || context.cli_version })) if (value) headers[name] = value;
      const callerHeaders = new Headers(init.headers || request?.headers);
      for (const name of ["anthropic-version", "anthropic-beta", "openai-beta"]) if (callerHeaders.has(name)) headers[name] = callerHeaders.get(name);
      if (wire === "anthropic") { headers["anthropic-version"] ??= "2023-06-01"; headers["x-api-key"] = "dummy"; }
      const payload = nativeRequest(model, body, config);
      const streaming = wire === "gemini" ? path.stream : body.stream === true;
      // 与 AdaL 原工具一致：云端始终流式，本地按调用方需要合并完整回复。
      if (wire !== "gemini") payload.stream = true;
      const suffix = wire === "anthropic" ? "/v1/messages" : wire === "responses" ? "/responses" : wire === "chat" ? "/chat/completions" : `/v1beta/models/${encodeURIComponent(model.model_kwargs.model)}:streamGenerateContent?alt=sse`;
      const result = await fetch(proxyRoot() + suffix, { method: "POST", headers, body: Buffer.from(JSON.stringify(payload)).toString("base64"), signal: combined, redirect: "manual" });
      if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw new Error("AdaL proxy returned an unexpected redirect"); }
      return { result, streaming };
    });
    const result = forward(response.result, wire, true, controller, cleanup);
    if (response.streaming || !result.ok) return result;
    const events = (await result.text()).split("\n").filter(line => line.startsWith("data:")).flatMap(line => {
      const text = line.slice(5).trim();
      return text === "[DONE]" ? [] : [JSON.parse(text)];
    });
    const failed = events.find(event => event.type === "error" || event.error || event.type === "response.failed");
    if (failed) {
      const error = failed.error || failed.response?.error || {};
      const status = { rate_limit_error: 429, overloaded_error: 529, authentication_error: 401, invalid_request_error: 400 }[error.type] || 502;
      throw Object.assign(new Error(error.message || "AdaL proxy stream failed"), { status, ...(status === 401 ? { signIn: "expired" } : {}) });
    }
    const whole = WHOLE[wire](events);
    if (!whole) throw new Error("AdaL proxy returned no complete response");
    return Response.json(whole, { headers: { "X-Magpie-Sign-In": "kept" } });
  } catch (error) {
    const failure = controller.signal.reason?.name === "TimeoutError" ? controller.signal.reason : error;
    controller.abort(); cleanup();
    if (signal?.aborted) throw signal.reason;
    return errorResponse(failure, wire);
  }
}
