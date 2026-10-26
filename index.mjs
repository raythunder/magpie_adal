import { withRuntime } from "./runtime.mjs";
import { models, BASE_URL } from "./models.mjs";
import { usage } from "./usage.mjs";
import { adalFetch } from "./proxy.mjs";

async function server(_input, options = {}) {
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000)) throw new Error("timeoutMs must be an integer >= 1000");
  return {
    async config(config) {
      config.provider ??= {};
      const provider = config.provider.adal ??= {};
      const available = await models();
      provider.name ??= "Adal";
      provider.npm ??= available.default?.provider.npm || "@ai-sdk/anthropic";
      provider.api ??= BASE_URL;
      provider.models = { ...available, ...provider.models };
    },
    auth: {
      provider: "adal", maxConcurrency: 1,
      usage: getAuth => usage(options, getAuth),
      methods: [{
        type: "oauth", label: "Use local AdaL CLI sign-in",
        async authorize() {
          return {
            url: "", method: "auto", instructions: "Uses your local AdaL sign-in. If needed, run adal in a terminal and sign in first.",
            async callback() {
              try {
                await withRuntime(options, {}, async ({ get }) => {
                  const context = await get("/auth/context");
                  if (!context.authenticated) throw new Error("AdaL is not authenticated; run adal to sign in.");
                });
                return { type: "success", refresh: "", access: "local-cli", expires: 0, accountId: "AdaL CLI (local)" };
              } catch (error) { return { type: "failed", error: error.message }; }
            },
          };
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "oauth" || auth.access !== "local-cli") return {};
        return { baseURL: BASE_URL, apiKey: "local-cli", fetch: (input, init) => adalFetch(options, input, init) };
      },
    },
  };
}

export default { id: "adal", server };
export const _internal = { adalFetch };
