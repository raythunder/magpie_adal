import assert from "node:assert/strict";
import plugin from "../index.mjs";

const hooks = await plugin.server({}, { timeoutMs: 30000 });
const result = await hooks.auth.usage(async () => ({ type: "oauth", access: "local-cli" }));
assert.equal(result.error, undefined, result.error);
console.log(JSON.stringify(result, null, 2));
