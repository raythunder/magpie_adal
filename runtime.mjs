import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const execute = promisify(execFile);

async function backendPort(pid, signal) {
  if (process.platform === "win32") throw new Error("AdaL connection currently requires macOS or Linux with lsof");
  let stdout;
  try {
    ({ stdout } = await execute(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-nP", "-a", "-g", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 2000, maxBuffer: 64 * 1024, signal }));
  } catch {
    signal?.throwIfAborted();
    throw new Error("Cannot locate AdaL's local backend port; connection requires lsof");
  }
  const ports = [...new Set([...stdout.matchAll(/^n(?:127\.0\.0\.1|\*):(\d+)$/gm)].map(match => Number(match[1])))];
  if (ports.length !== 1) throw new Error("Cannot identify a unique backend port owned by this AdaL process");
  return ports[0];
}

export function cliPath(options = {}) {
  const local = join(homedir(), ".adal", "bin", "adal");
  return options.cliPath || process.env.ADAL_RUNTIME_PATH || (existsSync(local) ? local : "adal");
}

export async function localToken() {
  if (process.env.ADAL_AUTH_TOKEN?.trim()) return process.env.ADAL_AUTH_TOKEN.trim();
  try {
    const credentials = JSON.parse(await readFile(join(homedir(), ".adal", "adal_oauth_creds.json"), "utf8"));
    if (typeof credentials.access_token === "string" && credentials.access_token) return credentials.access_token;
  } catch {}
  throw Object.assign(new Error("AdaL local credentials are unavailable; run adal to sign in."), { status: 401, signIn: "expired" });
}

// SDK 只完成原工具的认证和模型初始化，不发送 query，也不执行工具。
export async function withRuntime(options = {}, { model, signal } = {}, callback) {
  signal?.throwIfAborted();
  const workspace = await mkdtemp(join(tmpdir(), "magpie-adal-"));
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let child, closed, lines, failure, killTimer, childClosed = false;
  const kill = sig => {
    if (!child?.pid) return;
    try { if (process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch {}
  };
  const stop = () => {
    // 父进程退出后，后代仍可能持有管道；等待 close 前仍须清理整个进程组。
    if (!child?.pid || childClosed || killTimer) return;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const timer = setTimeout(() => controller.abort(new DOMException("AdaL request timed out", "TimeoutError")), options.timeoutMs || 300000);
  combined.addEventListener("abort", stop, { once: true });
  try {
    child = spawn(cliPath(options), ["--sdk-runtime"], { cwd: workspace, env: { ...process.env }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    closed = new Promise(resolve => {
      child.once("error", error => { failure = new Error(`Cannot start AdaL CLI (${error.code}). Install AdaL or set cliPath.`); lines.close(); resolve(); });
      child.once("close", () => { childClosed = true; resolve(); });
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    if (combined.aborted) { stop(); combined.throwIfAborted(); }
    child.stdin.write(JSON.stringify({ type: "initialize", protocol_version: 1, workspace, permission_mode: "default", can_use_tool: true,
      enabled_default_tools: ["__magpie_external_tools_only__"], ...(model && model !== "default" ? { model } : {}),
    }) + "\n");
    let size = 0;
    for await (const line of lines) {
      combined.throwIfAborted();
      size += Buffer.byteLength(line);
      if (size > 1024 * 1024) throw new Error("AdaL initialization output exceeds 1 MiB");
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "error") throw Object.assign(new Error(event.code === "AUTH_FAILED" ? "AdaL sign-in was refused; run adal to sign in again." : "AdaL runtime initialization failed"), event.code === "AUTH_FAILED" ? { status: 401, signIn: "expired" } : {});
      if (event.type !== "ready") continue;
      if (event.protocol_version !== 1) throw new Error("Unsupported AdaL SDK protocol version");
      const port = await backendPort(child.pid, combined);
      const get = async path => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: combined });
        if (!response.ok) throw Object.assign(new Error(`AdaL local endpoint failed (HTTP ${response.status}); upgrade AdaL if this endpoint is unavailable.`), { status: response.status === 401 ? 401 : 502, ...(response.status === 401 ? { signIn: "expired" } : {}) });
        return response.json();
      };
      return await callback({ get, sessionId: event.session_id, signal: combined });
    }
    combined.throwIfAborted();
    throw failure || new Error("AdaL runtime exited before initialization completed");
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", stop);
    lines?.close();
    if (child) {
      if (!child.stdin.destroyed) child.stdin.end('{"type":"shutdown"}\n');
      const shutdownTimer = setTimeout(stop, 2000);
      await closed;
      // 关闭管道不代表后代已退出；会话结束后清理本次独占进程组的残留。
      kill("SIGKILL");
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
    }
    await rm(workspace, { recursive: true, force: true });
  }
}
