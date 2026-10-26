import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "http://127.0.0.1/adal/v1";

// 与 AdaL 1.10.3 的 models/registry.py、各 model_client 的继承关系一致。
const ROUTES = {
  anthropic: ["AnthropicAPIClient", "anthropic", "https://api.anthropic.com"],
  minimax: ["MiniMaxClient", "anthropic", "https://api.minimax.io/anthropic"],
  openai: ["OpenAIClient", "responses", "https://api.openai.com/v1"],
  xai: ["XAIClient", "responses", "https://api.x.ai/v1"],
  deepseek: ["DeepSeekClient", "responses", "https://api.deepseek.com"],
  meta: ["MetaClient", "responses", "https://api.meta.ai/v1"],
  kimi: ["KimiClient", "chat", "https://api.moonshot.ai/v1"],
  zai: ["ZAIAPIClient", "chat", "https://api.z.ai/api/paas/v4"],
  qwen: ["QwenClient", "chat", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  google: ["GoogleGenAIClient", "gemini", "https://generativelanguage.googleapis.com"],
};
const NPM = { anthropic: "@ai-sdk/anthropic", responses: "@ai-sdk/openai", chat: "@ai-sdk/openai-compatible", gemini: "@ai-sdk/google" };

export function routeOf(model) {
  const route = Object.hasOwn(ROUTES, model?.provider) && ROUTES[model.provider];
  if (!route || route[0] !== model.model_client || !model.model_kwargs?.model || model.is_local_model) return null;
  return { wire: route[1], target: route[2], npm: NPM[route[1]] };
}

export async function readCatalog() {
  try {
    const value = JSON.parse(await readFile(join(homedir(), ".adal", "model_catalog.json"), "utf8"));
    if (!Array.isArray(value.models)) throw new Error("Invalid catalog");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { models: [] };
    throw new Error("Cannot read AdaL model catalog; run adal to refresh it.");
  }
}

export function resolveModel(key, catalog) {
  const wanted = key === "default" ? catalog.default_model : key;
  let model = catalog.models.find(entry => entry.key === wanted);
  if (!model) {
    const aliases = catalog.models.filter(entry => entry.model_kwargs?.model === wanted && routeOf(entry));
    if (aliases.length === 1) model = aliases[0];
    else if (aliases.length > 1) throw Object.assign(new Error(`Ambiguous AdaL API model id: ${key}`), { status: 400 });
  }
  if (!model) throw Object.assign(new Error(`Unknown AdaL model: ${key}. Run adal to refresh its model catalog.`), { status: 400 });
  if (!routeOf(model)) throw Object.assign(new Error(`AdaL model ${wanted} is not supported by the cloud proxy; local and connected subscriptions require the AdaL CLI.`), { status: 400 });
  return model;
}

function entry(model, key = model.key) {
  const route = routeOf(model);
  const kwargs = model.model_kwargs;
  const efforts = model.config_options?.effort || [];
  const variants = Object.fromEntries(efforts.map(effort => [effort,
    route.wire === "anthropic" ? { effort } : route.wire === "gemini" ? { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } : { reasoningEffort: effort },
  ]));
  return {
    id: kwargs.model, name: key === "default" ? `AdaL Default (${model.display_name || model.key})` : model.display_name || model.key,
    provider: { npm: route.npm, api: BASE_URL },
    limit: { context: kwargs.max_input_tokens || 0, output: kwargs.max_output_tokens || kwargs.max_tokens || 0 },
    tool_call: true, reasoning: !!model.is_thinking_model, attachment: !!model.supports_vision,
    modalities: { input: model.supports_vision ? ["text", "image"] : ["text"], output: ["text"] }, variants,
  };
}

export function modelEntries(catalog) {
  const available = catalog.models.filter(model => typeof model.key === "string" && model.key && routeOf(model));
  const result = Object.fromEntries(available.map(model => [model.key, entry(model)]));
  const selected = available.find(model => model.key === catalog.default_model);
  if (selected) result.default = entry(selected, "default");
  return result;
}

export async function models() { return modelEntries(await readCatalog()); }
