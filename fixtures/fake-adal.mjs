#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const send = event => process.stdout.write(JSON.stringify(event) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "initialize") {
    if (command.permission_mode !== "default" || command.enabled_default_tools?.[0] !== "__magpie_external_tools_only__") throw new Error("Tool isolation was lost");
    if (process.env.ADAL_FIXTURE_FAILURE === "hang") continue;
    if (process.env.ADAL_FIXTURE_FAILURE === "exit") process.exit(1);
    if (process.env.ADAL_FIXTURE_FAILURE === "auth") { send({ type: "error", code: "AUTH_FAILED" }); continue; }
    const catalog = JSON.parse(await readFile(join(homedir(), ".adal/model_catalog.json"), "utf8"));
    const key = command.model || catalog.default_model;
    const model = catalog.models.find(entry => entry.key === key);
    const backend = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      let result;
      if (request.url === "/auth/usage") result = { plan: { name: "Pro" }, wallet_balance: 12.4, weekly_usage: { usage_percentage: 37.5, resets_at: "2026-10-12T00:00:00Z" } };
      else if (request.url === "/auth/context") result = { authenticated: true, client_surface: "cli", client_entrypoint: "adal-cli", os: process.platform, client_version: "1.10.3" };
      else if (request.url === "/model/info") result = { success: true, model: process.env.ADAL_FIXTURE_FAILURE === "wrong-model" ? "other" : key, connection_mode: process.env.ADAL_FIXTURE_FAILURE === "byoak" ? "byoak" : "proxy" };
      else if (request.url === "/model/config") result = { success: true, effort: model?.model_kwargs?.output_config?.effort };
      else { response.writeHead(404).end(); return; }
      response.end(JSON.stringify(result));
    });
    await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
    send({ type: "ready", protocol_version: 1, session_id: "test-session" });
  } else if (command.type === "query") {
    throw new Error("The direct plugin must never send an Agent query");
  } else if (command.type === "shutdown") process.exit(0);
}
