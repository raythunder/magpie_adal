import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRuntime } from "../runtime.mjs";
import { adalFetch } from "../proxy.mjs";

const url = "http://127.0.0.1/adal/v1/messages";

test("initialization timeout cleans up descendants after the SDK parent exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "adal-orphan-test-"));
  const pidFile = join(root, "pid");
  const executable = join(root, "adal.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
process.exit(0);
`, { mode: 0o755 });
  const pending = withRuntime({ cliPath: executable, timeoutMs: 1000 }, {}, () => {}).catch(error => error);
  let deadline;
  try {
    const result = await Promise.race([pending, new Promise(resolve => { deadline = setTimeout(() => resolve("stalled"), 3000); })]);
    assert.notEqual(result, "stalled", "SDK descendants kept initialization open after timeout");
    assert.equal(result.name, "TimeoutError");
  } finally {
    clearTimeout(deadline);
    try { process.kill(-Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch {}
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

test("descendants that close pipes during SIGTERM cannot escape final cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "adal-cleanup-test-"));
  const pidFile = join(root, "pid");
  const readyFile = join(root, "ready");
  const executable = join(root, "adal.mjs");
  const worker = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.closeSync(1); fs.closeSync(2); }); fs.writeFileSync(${JSON.stringify(readyFile)}, "ready"); setInterval(() => {}, 1000);`;
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ group: process.pid, child: child.pid }));
process.exit(0);
`, { mode: 0o755 });
  const controller = new AbortController();
  const pending = withRuntime({ cliPath: executable, timeoutMs: 10000 }, { signal: controller.signal }, () => {}).catch(error => error);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await readFile(readyFile); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ready, true, "cleanup fixture did not initialize");
    controller.abort(new DOMException("test deadline", "TimeoutError"));
    assert.equal((await pending).name, "TimeoutError");
    const { child } = JSON.parse(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(child, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, "a descendant survived after closing its inherited pipes");
  } finally {
    controller.abort();
    try { const { group } = JSON.parse(await readFile(pidFile, "utf8")); process.kill(-group, "SIGKILL"); } catch {}
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

for (const abort of [false, true]) test(`stalled Request body obeys ${abort ? "caller cancellation" : "the request timeout"}`, async () => {
  let source, cancelled = false, deadline, abortTimer;
  const controller = new AbortController();
  const body = new ReadableStream({
    start(output) { source = output; output.enqueue(new TextEncoder().encode("{")); },
    cancel() { cancelled = true; },
  });
  const input = new Request(url, { method: "POST", body, duplex: "half", signal: controller.signal });
  const pending = adalFetch({ timeoutMs: abort ? 1000 : 30 }, input).catch(error => error);
  if (abort) abortTimer = setTimeout(() => controller.abort(), 30);
  try {
    const result = await Promise.race([pending, new Promise(resolve => { deadline = setTimeout(() => resolve("stalled"), 500); })]);
    assert.notEqual(result, "stalled", "Request body ignored its cancellation deadline");
    if (abort) assert.equal(result.name, "AbortError");
    else assert.equal(result.status, 504);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(deadline); clearTimeout(abortTimer);
    if (!cancelled) source.close();
    await pending;
  }
});

test("oversized Request bodies stop reading at the byte limit", async () => {
  let produced = 0, cancelled = false;
  const body = new ReadableStream({
    pull(output) {
      output.enqueue(new Uint8Array(64 * 1024));
      if (++produced === 100) output.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await adalFetch({}, new Request(url, { method: "POST", body, duplex: "half" }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(produced < 100, "the entire oversized body was consumed");
});
