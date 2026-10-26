import { withRuntime } from "./runtime.mjs";

// Same fields and balance units as AdaL 1.9.0's /usage dialog.
export function usageOf(data) {
  if (!data || !Number.isFinite(data.wallet_balance)) throw new Error("AdaL returned no valid usage balance");
  const result = {
    ...(data.plan?.name ? { plan: data.plan.name + (data.plan.is_trialing ? " (trial)" : "") } : {}),
    balance: `$${data.wallet_balance.toFixed(2)}`,
    signIn: "kept",
    windows: [],
  };
  const weekly = data.weekly_usage;
  if (weekly != null) {
    if (!Number.isFinite(weekly.usage_percentage) || weekly.usage_percentage < 0) throw new Error("AdaL returned invalid weekly usage");
    result.windows.push({
      // BYOAK and connected subscriptions can still work after AdaL's included allowance is exhausted.
      name: "Weekly", used: weekly.usage_percentage, aside: true,
      ...(weekly.resets_at ? { resetsAt: weekly.resets_at } : {}),
      display: `${Number(weekly.usage_percentage.toFixed(2))}% used`,
    });
  }
  return result;
}

export async function usage(options, getAuth) {
  const auth = await getAuth();
  if (auth?.type !== "oauth" || auth.access !== "local-cli") return { error: "AdaL CLI is not connected", signIn: "kept" };
  try {
    return await withRuntime(options, {}, async ({ get }) => usageOf(await get("/auth/usage")));
  } catch (error) {
    return { error: error.message, signIn: error.signIn || "kept" };
  }
}
