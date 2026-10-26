import assert from "node:assert/strict";
import { test, after } from "node:test";
import plugin from "../index.mjs";
import { setup } from "../fixtures/testing.mjs";

const env = await setup();
after(() => env.close());

test("v1 server preserves user configuration and declares native model SDKs", async () => {
  const hooks = await plugin.server({}, env.options);
  const config = { provider: { adal: { name: "My AdaL", models: { custom: { name: "Custom" } } } } };
  await hooks.config(config);
  assert.equal(config.provider.adal.name, "My AdaL");
  assert.equal(config.provider.adal.models.custom.name, "Custom");
  assert.equal(config.provider.adal.models.default.provider.npm, "@ai-sdk/anthropic");
  assert.equal(config.provider.adal.models["openai-test"].provider.npm, "@ai-sdk/openai");
  assert.equal(hooks.auth.provider, "adal");
});

test("existing local connection markers remain valid; real tokens never enter Magpie auth", async () => {
  const hooks = await plugin.server({}, env.options);
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {});
  const flow = await hooks.auth.methods[0].authorize();
  const auth = await flow.callback();
  assert.equal(auth.type, "success", auth.error);
  assert.equal(auth.access, "local-cli");
  assert.equal(auth.refresh, "");
  const loader = await hooks.auth.loader(async () => ({ ...auth, type: "oauth" }));
  assert.equal(loader.apiKey, "local-cli");
  assert.equal(typeof loader.fetch, "function");
});

test("timeout configuration is validated before initialization", async () => {
  for (const timeoutMs of [0, 999, 1.5, "1000"]) await assert.rejects(plugin.server({}, { timeoutMs }), /timeoutMs/);
});
