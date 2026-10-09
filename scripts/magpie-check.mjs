import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(root, "fixtures", "fake-adal.mjs");
await chmod(cliPath, 0o755);
const sandbox = await mkdtemp(join(tmpdir(), "magpie-adal-check-"));
const binary = process.env.MAGPIE_BIN || (process.platform === "darwin" ? "/Applications/magpie.app/Contents/MacOS/magpie" : "magpie");
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, ".config") };
const command = (...args) => {
  const result = spawnSync(binary, args, { env, encoding: "utf8", timeout: 60000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  process.stdout.write(result.stdout + result.stderr);
  return result.stdout;
};
try {
  command("plugin", "add", root);
  command("plugin", "options", root, JSON.stringify({ cliPath, timeoutMs: 10000 }));
  command("plugin", "login", "adal");
  const list = JSON.parse(command("plugin", "--json"));
  assert.ok(JSON.stringify(list).includes("adal"));
  assert.equal(list.providers.find((provider) => provider.id === "adal").usage, true);
  const quota = command("quota", "adal", "--json");
  assert.ok(quota.includes("37.5") && quota.includes("Pro"), "Magpie did not expose AdaL quota");
  command("provider", "test", "adal", "default");
  console.log("Isolated Magpie loading/login/quota/request: OK");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
