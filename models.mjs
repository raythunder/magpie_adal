import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function models() {
  const result = { default: { name: "AdaL Default", tool_call: true, modalities: { input: ["text"], output: ["text"] } } };
  try {
    const catalog = JSON.parse(await readFile(join(homedir(), ".adal", "model_catalog.json"), "utf8"));
    for (const model of catalog.models || []) {
      if (typeof model.key !== "string" || !model.key) continue;
      const kwargs = model.model_kwargs || {};
      result[model.key] = {
        name: model.display_name || model.key,
        limit: { context: kwargs.max_input_tokens || 0, output: kwargs.max_tokens || 0 },
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read AdaL model catalog; run adal to refresh it.");
  }
  return result;
}
