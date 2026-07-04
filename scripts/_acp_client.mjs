#!/usr/bin/env node
/**
 * _acp_client.mjs - Minimal ACP (Agent Client Protocol) stdio client.
 *
 * Spawns an ACP agent (e.g. glm-acp-agent), drives it through the JSON-RPC
 * protocol, collects streamed assistant text, and writes the full answer to
 * stdout. Designed to be called by run_glm.sh.
 *
 * Usage:
 *   _acp_client.mjs --agent <binary> --prompt-file <path> --cwd <dir>
 *                    [--mcp-url <url>] [--model <id>] [--max-tokens <n>]
 *
 * Protocol sequence:
 *   initialize -> authenticate -> session/new -> session/set_mode ->
 *   session/prompt (collect streamed chunks) -> session/close
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "agent": { type: "string", default: "glm-acp-agent" },
    "prompt-file": { type: "string", short: "p" },
    "cwd": { type: "string" },
    "mcp-url": { type: "string" },
    "model": { type: "string" },
    "max-tokens": { type: "string" },
  },
  strict: true,
});

if (!args["prompt-file"] || !args["cwd"]) {
  process.stderr.write("usage: _acp_client.mjs --agent <bin> --prompt-file <f> --cwd <dir> [--mcp-url <u>] [--model <m>]\n");
  process.exit(2);
}

const promptText = readFileSync(args["prompt-file"], "utf-8");

const env = { ...process.env };
if (args["model"]) env.ACP_GLM_MODEL = args["model"];
if (args["max-tokens"]) env.ACP_GLM_MAX_TOKENS = args["max-tokens"];

/** @type {import("node:child_process").ChildProcess | undefined} */
let child;

function killChild() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

process.on("SIGINT", () => {
  killChild();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killChild();
  process.exit(143);
});

child = spawn(args["agent"], [], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
});

let nextId = 1;
const pending = new Map();
let buffer = "";
let collected = "";

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Agent -> Client request (has both method and id)
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      if (msg.method === "session/request_permission") {
        sendResponse(msg.id, { outcome: "allow" });
      } else {
        process.stderr.write(`[_acp_client] unhandled agent request: ${msg.method}\n`);
      }
      continue;
    }

    // Notification from agent (no id)
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === "session/update") {
        const update = msg.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          collected += update.content.text;
        }
      }
      continue;
    }

    // Response to our request
    const req = pending.get(msg.id);
    if (req) {
      pending.delete(msg.id);
      if (msg.error) {
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
    }
  }
});

child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    process.stderr.write(`[_acp_client] agent exited with code ${code}\n`);
    process.exit(code);
  }
});

async function main() {
  try {
    await sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "unifusion-acp-client", version: "1.0.0" },
    });

    await sendRequest("authenticate", { methodId: "z-ai-api-key" });

    const mcpServers = [];
    if (args["mcp-url"]) {
      mcpServers.push({
        type: "http",
        name: "exa",
        url: args["mcp-url"],
        headers: [],
      });
    }

    const sessionResp = await sendRequest("session/new", {
      cwd: args["cwd"],
      mcpServers,
    });
    const sessionId = sessionResp.sessionId;

    await sendRequest("session/set_mode", {
      sessionId,
      modeId: "bypass_permissions",
    });

    const promptResp = await sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });

    await sendRequest("session/close", { sessionId });

    killChild();

    process.stdout.write(collected);
    if (!collected.endsWith("\n")) process.stdout.write("\n");

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[_acp_client] error: ${err.message}\n`);
    killChild();
    process.exit(1);
  }
}

main();
