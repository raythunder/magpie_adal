import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { models } from "./models.mjs";

const execute = promisify(execFile);

async function backendPort(pid, signal) {
  if (process.platform === "win32") throw new Error("AdaL quota lookup currently requires macOS or Linux with lsof");
  let stdout;
  try {
    ({ stdout } = await execute(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-nP", "-a", "-g", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 2000, maxBuffer: 64 * 1024, signal }));
  } catch {
    signal?.throwIfAborted();
    throw new Error("Cannot locate AdaL's local backend port; quota lookup requires lsof");
  }
  const ports = [...stdout.matchAll(/^n(?:127\.0\.0\.1|\*):(\d+)$/gm)].map((match) => Number(match[1]));
  if (new Set(ports).size !== 1) throw new Error("Cannot identify a unique backend port owned by this AdaL process");
  return ports[0];
}


export function cliPath(options = {}) {
  const local = join(homedir(), ".adal", "bin", "adal");
  return options.cliPath || process.env.ADAL_RUNTIME_PATH || (existsSync(local) ? local : "adal");
}

// SDK protocol v1, verified against AdaL 1.9.0's sdkRuntime source.
export async function* run(options, { model, prompt, system, signal, probe = false, usage = false, externalTools = [] }) {
  signal?.throwIfAborted();
  if (model && model !== "default" && !Object.hasOwn(await models(), model)) throw Object.assign(new Error(`Unknown AdaL model: ${model}. Run adal to refresh its model catalog.`), { status: 400 });
  const workspace = await mkdtemp(join(tmpdir(), "magpie-adal-"));
  let child;
  let closed;
  let timer;
  let killTimer;
  let failure;
  const stop = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (sig) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    };
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  try {
    const promptFile = join(workspace, "system.txt");
    await writeFile(promptFile, system || "You are a helpful assistant. Respond directly without using tools.", { mode: 0o600 });
    child = spawn(cliPath(options), ["--sdk-runtime"], {
      cwd: workspace, env: { ...process.env },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    closed = new Promise((resolve) => {
      child.once("error", (error) => { failure = new Error(`Cannot start AdaL CLI (${error.code}). Install AdaL or set cliPath.`); resolve(); });
      child.once("close", resolve);
    });
    child.stdin.on("error", () => {});
    // AdaL's stderr can include prompt data; never forward it into gateway logs.
    child.stderr.resume();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    timer = setTimeout(() => { failure = Object.assign(new Error("AdaL request timed out"), { status: 504 }); stop(); }, options.timeoutMs || 300000);
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    send({
      type: "initialize", protocol_version: 1, workspace,
      permission_mode: "default", can_use_tool: true, prompt_file: promptFile,
      // shortcut: AdaL 1.8.1 ignores empty allowlists; replace this unmatched name when the SDK supports an empty set.
      enabled_default_tools: ["__magpie_external_tools_only__"],
    });
    let ready = false;
    let complete = false;
    let size = 0;
    let denied = false;
    let repaired = false;
    const pendingCalls = new Map();
    const deniedCalls = new Set();
    const query = () => send({ type: "query", input: prompt });
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      signal?.throwIfAborted();
      size += Buffer.byteLength(line);
      if (size > 16 * 1024 * 1024) throw new Error("AdaL response exceeds 16 MiB");
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "error" || event.type === "command.failed") {
        const message = event.error?.message || event.message || "AdaL query failed";
        const error = new Error(message);
        if (event.code === "AUTH_FAILED") Object.assign(error, { status: 401, signIn: "expired" });
        throw error;
      }
      if (event.type === "ready") {
        if (event.protocol_version !== 1) throw new Error("Unsupported AdaL SDK protocol version");
        ready = true;
        if (usage) {
          // The SDK hides its backend URL; inspect only this request's isolated process group.
          const port = await backendPort(child.pid, signal);
          const timeout = AbortSignal.timeout(15000);
          const response = await fetch(`http://127.0.0.1:${port}/auth/usage`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
          if (response.status === 404) throw new Error("This AdaL CLI has no quota endpoint; upgrade to AdaL 1.9.0 or newer");
          if (!response.ok) throw Object.assign(new Error(`AdaL quota request failed (HTTP ${response.status})`), response.status === 401 ? { signIn: "expired" } : {});
          const data = await response.json();
          complete = true;
          yield { type: "usage", data };
          break;
        }
        if (probe) { complete = true; break; }
        // AdaL can acknowledge failed switches; reject unknown catalog keys before spawning, then request the switch explicitly.
        if (model !== "default") send({ type: "control_request", request_id: "model", request: { subtype: "set_model", model } });
        else query();
      } else if (event.type === "control_response" && event.request_id === "model") {
        if (event.subtype !== "success") throw new Error(event.error || "AdaL model switch failed");
        query();
      } else if (event.type === "control_request") {
        const request = event.request;
        send({ type: "control_response", request_id: event.request_id, response: {
          behavior: "deny", message: "AdaL-native tools are disabled. Return tool calls as JSON for the external agent instead.",
        } });
        if (request?.subtype !== "can_use_tool") throw new Error("Unsupported AdaL control request");
        if (externalTools.includes(request.tool_name)) {
          // Deny AdaL execution, then hand the proposed call to the external agent.
          send({ type: "cancel" });
          complete = true;
          yield { type: "external.tool_call", name: request.tool_name, args: request.input };
          yield { type: "command.completed" };
          break;
        }
        denied = true;
        deniedCalls.add(request.tool_call_id);
      } else if (event.type === "tool.started") {
        pendingCalls.set(event.toolCallId, event);
      } else if (event.type === "tool.completed") {
        if (deniedCalls.has(event.toolCallId) && ["failed", "cancelled"].includes(event.status)) {
          pendingCalls.delete(event.toolCallId);
          continue;
        }
        const call = pendingCalls.get(event.toolCallId);
        const output = typeof event.result === "string" ? event.result : event.result?.output;
        // shortcut: AdaL 1.9 has no typed lookup error; replace this prefix check when the SDK provides one.
        if (!call || (event.name && event.name !== call.name) || event.status !== "failed" || typeof output !== "string" || !output.startsWith(`No tool found matching '${call.name}'.`)) throw new Error("AdaL bypassed the tool permission gate; unexpected native tool result");
        pendingCalls.delete(event.toolCallId);
        if (!externalTools.includes(call.name)) { denied = true; continue; }
        send({ type: "cancel" });
        complete = true;
        yield { type: "external.tool_call", name: call.name, args: call.args };
        yield { type: "command.completed" };
        break;
      } else if (event.type === "command.completed") {
        if (denied) {
          if (repaired) throw new Error("AdaL could not produce a model-only reply after its native tool was denied");
          repaired = true;
          denied = false;
          pendingCalls.clear();
          deniedCalls.clear();
          send({ type: "query", input: 'The previous AdaL-native tool attempt did not execute. Answer the original conversation and keep following its system/developer messages, using only the provided context. Never call AdaL-native tools or claim they ran. If the original request contained tools, return ONLY {"content":"answer or null","tool_calls":[{"name":"client-provided function name","arguments":{}}]}, including an empty tool_calls array for a text answer. Respect the original tool_choice and parallel_tool_calls. If the original request had no tools, answer as plain text.' });
          yield { type: "external.retry" };
          continue;
        }
        if (pendingCalls.size) throw new Error("AdaL bypassed the tool permission gate; native lookup was not confirmed");
        complete = true;
        yield event;
        break;
      } else {
        if (event.type === "assistant.message.completed" && event.message?.content) denied = false;
        yield event;
      }
    }
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!ready || !complete) throw new Error("AdaL runtime exited before completing the request");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (child) {
      if (!child.stdin.destroyed) child.stdin.end('{"type":"shutdown"}\n');
      const shutdownTimer = setTimeout(stop, 2000);
      await closed;
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
    }
    await rm(workspace, { recursive: true, force: true });
  }
}
