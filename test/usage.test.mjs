import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import { setup } from "../fixtures/testing.mjs";
import { usageOf } from "../usage.mjs";
import plugin from "../index.mjs";

const env = await setup();
const { cliPath } = env.options;
after(() => env.close());
const auth = async () => ({ type: "oauth", access: "local-cli" });

const sample = {
  plan: { name: "Pro", is_trialing: false }, wallet_balance: 12.4,
  weekly_usage: { usage_percentage: 37.5, resets_at: "2026-10-12T00:00:00Z", is_usage_limited: false },
};

test("maps AdaL plan, balance, weekly usage and reset time to Magpie", () => {
  assert.deepEqual(usageOf(sample), {
    plan: "Pro", balance: "$12.40", signIn: "kept",
    windows: [{ name: "Weekly", used: 37.5, aside: true, resetsAt: "2026-10-12T00:00:00Z", display: "37.5% used" }],
  });
});

test("preserves zero balances, trials and usage above the limit", () => {
  const result = usageOf({ ...sample, plan: { name: "Pro", is_trialing: true }, wallet_balance: 0, weekly_usage: { usage_percentage: 105.2 } });
  assert.equal(result.plan, "Pro (trial)");
  assert.equal(result.balance, "$0.00");
  assert.equal(result.windows[0].used, 105.2);
});

test("a plan without a weekly limit does not invent an allowance", () => {
  const result = usageOf({ ...sample, weekly_usage: null });
  assert.deepEqual(result.windows, []);
});

test("invalid or missing usage data is an error, not a zero usage report", () => {
  assert.throws(() => usageOf({}), /usage|balance/i);
  assert.throws(() => usageOf({ ...sample, wallet_balance: "12.4" }), /balance/i);
  assert.throws(() => usageOf({ ...sample, weekly_usage: { usage_percentage: NaN } }), /weekly/i);
});

test("the provider exposes Magpie's auth.usage hook", async () => {
  const hooks = await plugin.server({}, {});
  assert.equal(typeof hooks.auth.usage, "function");
  assert.deepEqual(await hooks.auth.usage(async () => undefined), { error: "AdaL CLI is not connected", signIn: "kept" });
});

test("reads the authenticated local quota endpoint without sending a model query", async () => {
  const hooks = await plugin.server({}, { cliPath, timeoutMs: 1000 });
  assert.deepEqual(await hooks.auth.usage(auth), usageOf(sample));
});

test("older CLI quota failures remain visible without marking the model login expired", async () => {
  const hooks = await plugin.server({}, { cliPath, timeoutMs: 1000 });
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  try {
    const result = await hooks.auth.usage(auth);
    assert.match(result.error, /1\.9\.0|upgrade/i);
    assert.equal(result.signIn, "kept");
  } finally { fetch.mock.restore(); }
});

test("authentication rejection is distinguished from network or quota errors", async () => {
  const hooks = await plugin.server({}, { cliPath, timeoutMs: 1000 });
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  try {
    const result = await hooks.auth.usage(auth);
    assert.equal(result.signIn, "expired");
  } finally { fetch.mock.restore(); }
});
