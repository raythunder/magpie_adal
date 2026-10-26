import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setup, fakeProxy, cliPath } from "../fixtures/testing.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sandbox = await setup();
const cloud = await fakeProxy();
const binary = process.env.MAGPIE_BIN || (process.platform === "darwin" ? "/Applications/magpie.app/Contents/MacOS/magpie" : "magpie");
const env = { ...process.env, HOME: sandbox.home, XDG_CONFIG_HOME: join(sandbox.home, ".config"), ADAL_PROXY_URL: cloud.url };
const command = async (...args) => {
  const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(status, 0, output);
  if (!args.includes("--json")) process.stdout.write(output);
  return output;
};
let gateway, gatewayClosed;
try {
  await command("plugin", "add", root);
  await command("plugin", "options", root, JSON.stringify({ cliPath, timeoutMs: 10000 }));
  await command("plugin", "login", "adal");
  const list = JSON.parse(await command("plugin", "--json"));
  assert.ok(JSON.stringify(list).includes("adal"));
  assert.equal(list.providers.find((provider) => provider.id === "adal").usage, true);
  const quota = await command("quota", "adal", "--json");
  assert.ok(quota.includes("37.5") && quota.includes("Pro"), "Magpie did not expose AdaL quota");
  for (const model of ["default", "openai-test", "kimi-test"]) await command("provider", "test", "adal", model);
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const gatewayKey = "magpie-adal-isolated-test-key";
  gateway = spawn(binary, ["serve"], { env: { ...env, MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_GATEWAY_KEY: gatewayKey }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  gatewayClosed = once(gateway, "close");
  let gatewayLog = "";
  gateway.stdout.on("data", chunk => { gatewayLog += chunk; });
  gateway.stderr.on("data", chunk => { gatewayLog += chunk; });
  const headers = { Authorization: `Bearer ${gatewayKey}`, "Content-Type": "application/json" };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (gateway.exitCode !== null) throw new Error("Isolated gateway exited: " + gatewayLog);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers, signal: AbortSignal.timeout(500) });
      if (response.ok) { await response.body.cancel(); ready = true; break; }
      await response.body.cancel();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Isolated gateway did not become ready: " + gatewayLog);
  const gemini = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ model: "adal/google-test", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.equal(gemini.status, 200, await gemini.clone().text());
  assert.match(await gemini.text(), /你好 world/);
  assert.ok(cloud.requests.at(-1).url.includes("/v1beta/models/gemini-test:streamGenerateContent"));
  const messages = [{ role: "user", content: "Call echo once." }];
  const tools = [{ type: "function", function: { name: "echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } }];
  const chat = async turns => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model: "adal/default", messages: turns, tools, stream: false }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const proposed = await chat(messages);
  assert.equal(proposed.choices[0].finish_reason, "tool_calls");
  const tool = proposed.choices[0].message.tool_calls[0];
  assert.equal(tool.function.name, "echo");
  assert.deepEqual(JSON.parse(tool.function.arguments), { text: "fixture-tool" });
  const followup = await chat([...messages, proposed.choices[0].message, { role: "tool", tool_call_id: tool.id, content: "fixture-tool" }]);
  assert.match(followup.choices[0].message.content, /你好 world/);
  assert.equal(cloud.requests.length, 6);
  assert.ok(cloud.requests.every(request => request.headers.authorization === "Bearer fixture-token"));
  console.log("Isolated Magpie loading/login/quota/Anthropic/Responses/Chat: OK");
  console.log("Magpie gateway Chat → native Gemini → Chat SSE: OK (CLI Google probe is unsupported on 0.1.1318)");
  console.log("Magpie gateway Chat tools → native Anthropic tool_use → Chat tool_calls and follow-up: OK");
} finally {
  if (gateway?.exitCode === null) {
    process.kill(-gateway.pid, "SIGTERM");
    const kill = setTimeout(() => { try { process.kill(-gateway.pid, "SIGKILL"); } catch {} }, 2000);
    await gatewayClosed;
    clearTimeout(kill);
  }
  await cloud.close();
  await sandbox.close();
}
