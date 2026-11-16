// agy-openai-bridge — exposes the official `agy` CLI as an OpenAI-compatible endpoint.
// Text in / text out. agy runs its own tools inside the client's project directory.
//
// State (logs + conversation bindings) lives in %LOCALAPPDATA%\agy-bridge
// (or $XDG_STATE_HOME / ~/.local/state). The code stays where you cloned it.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.AGY_BRIDGE_PORT || 8799);
const AGY = process.env.AGY_BINARY || "agy";
const FALLBACK_CWD = process.env.AGY_BRIDGE_CWD || "";
const FORCED_MODE = process.env.AGY_BRIDGE_MODE || "";

const HOME = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const STATE_DIR = process.env.AGY_BRIDGE_STATE || path.join(HOME, "agy-bridge");
const STATE = path.join(STATE_DIR, "conversations.json");
const LOG = path.join(STATE_DIR, "bridge.log");

fs.mkdirSync(STATE_DIR, { recursive: true });

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
};
const debug = (msg) => { if (process.env.AGY_BRIDGE_DEBUG === "1") log(`DEBUG ${msg}`); };

// Never die because a client hung up mid-stream.
process.on("uncaughtException", (err) => log(`UNCAUGHT ${err && err.stack ? err.stack : err}`));
process.on("unhandledRejection", (err) => log(`UNHANDLED ${err && err.stack ? err.stack : err}`));

let conversations = {};
try { conversations = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { conversations = {}; }

function saveConversations() {
  conversations = Object.fromEntries(Object.entries(conversations).slice(-200));
  try { fs.writeFileSync(STATE, JSON.stringify(conversations, null, 2)); } catch {}
}

// Fallback list; `agy models` is the source of truth and differs per account/plan.
const MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).filter(Boolean).join("\n");
  }
  return "";
};

const systemText = (messages) =>
  messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");

function flatten(messages) {
  return messages
    .map((m) => {
      const body = textOf(m.content);
      if (!body) return "";
      const role = m.role === "system" ? "SYSTEM" : m.role === "assistant" ? "ASSISTANT" : "USER";
      return `<<${role}>>\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

// Stable key for "this is the same conversation": system prompt + first user message.
function originKey(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  return createHash("sha256")
    .update(systemText(messages))
    .update("\u0000")
    .update(firstUser ? textOf(firstUser.content) : "")
    .digest("hex")
    .slice(0, 32);
}

let lastCwd = FALLBACK_CWD;

function resolveCwd(messages) {
  const system = systemText(messages);
  const m = system.match(/(?:working directory|directorio de trabajo)[^\n]*?([A-Za-z]:\\[^\n\r"`]+|\/[^\n\r"`]+)/i);
  if (m) { lastCwd = m[1].trim().replace(/[\\/]+$/, ""); return lastCwd; }
  return lastCwd;
}

function killTree(child) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  } catch {}
}

function runAgy({ prompt, model, cwd, conversationId, mode, onDelta, signal }) {
  return new Promise((resolve) => {
    const args = ["--add-dir", cwd, "--output-format", "stream-json", "--input-format", "stream-json"];
    if (mode) args.push("--mode", mode);
    if (model) args.push("--model", model);
    if (conversationId) args.push("--conversation", conversationId);

    let child;
    try {
      child = spawn(AGY, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ text: "", usage: {}, conversationId, code: -1, stderr: String(err) });
      return;
    }

    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let text = "";
    let convId = conversationId;
    let buf = "";
    let stderr = "";
    let done = false;

    // Feed the prompt over stdin: Windows caps command-line arguments at ~32k characters.
    try {
      child.stdin.write(JSON.stringify({
        event: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      }) + "\n");
      child.stdin.end();
    } catch (err) {
      stderr += String(err);
    }

    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ text, usage, conversationId: convId, code, stderr });
    };

    if (signal) signal.addEventListener("abort", () => killTree(child));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === "init" && ev.conversation_id) convId = ev.conversation_id;
        if (ev.event === "step_update") {
          const s = ev.step_update || {};
          if (s.step_type === "agent_response" && typeof s.text_delta === "string" && s.text_delta) {
            text += s.text_delta;
            onDelta(s.text_delta);
          }
          if (s.usage) usage = { ...usage, ...s.usage };
        }
        if (ev.event === "result") {
          const r = ev.result || {};
          if (r.conversation_id) convId = r.conversation_id;
          if (r.usage) usage = { ...usage, ...r.usage };
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { stderr += String(err); finish(-1); });
    child.on("close", (code) => finish(code));
  });
}

const canWrite = (res) => !res.writableEnded && !res.destroyed && res.writable !== false;
const sse = (res, obj) => {
  if (!canWrite(res)) return false;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch { return false; }
};
const sendDone = (res) => { if (canWrite(res)) { try { res.write("data: [DONE]\n\n"); } catch {} } };
const endRes = (res) => { if (!res.writableEnded && !res.destroyed) { try { res.end(); } catch {} } };
const jsonEnd = (res, code, payload) => {
  try { res.writeHead(code, { "content-type": "application/json" }); } catch {}
  if (!canWrite(res)) return;
  try { res.end(JSON.stringify(payload)); } catch {}
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "agy" })),
    }));
    return;
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    jsonEnd(res, 404, { error: { message: "not found" } });
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw || "{}"); } catch {
    jsonEnd(res, 400, { error: { message: "invalid JSON body" } });
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === "string" ? body.model : MODELS[1];
  const wantStream = Boolean(body.stream);
  debug(`model=${model} tools=${JSON.stringify((Array.isArray(body.tools) ? body.tools : []).map((t) => (t && t.function && t.function.name) || (t && t.name)).filter(Boolean))}`);

  const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  // Clients ask for a short session title: answer locally, no agy turn and no quota spent.
  if (/^You name coding sessions/i.test(systemText(messages).trim())) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const title = (textOf(lastUser && lastUser.content) || "Sesion")
      .replace(/\s+/g, " ")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim()
      .slice(0, 40)
      .replace(/\s+\S*$/, "");
    if (wantStream) {
      if (canWrite(res)) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        sse(res, chunk({ role: "assistant", content: "" }));
        sse(res, chunk({ content: title }));
        sse(res, chunk({}, "stop"));
        sendDone(res);
        endRes(res);
      }
    } else {
      jsonEnd(res, 200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    log(`title local model=${model} title=${JSON.stringify(title)}`);
    return;
  }

  // OpenCode does not name the agent on the wire, but it sends only the enabled tools.
  // A read-only agent (no write/edit) maps to agy's own plan mode, which agy enforces itself.
  const toolNames = Array.isArray(body.tools)
    ? body.tools.map((t) => (t && t.function && t.function.name) || (t && t.name)).filter(Boolean)
    : [];
  const mutating = ["write", "edit", "multiedit", "patch"].some((n) => toolNames.includes(n));
  const mode = FORCED_MODE || (toolNames.length > 0 && !mutating ? "plan" : "normal");

  const cwd = resolveCwd(messages);

  if (!cwd || !fs.existsSync(cwd)) {
    log(`ERROR unknown cwd for model=${model} msgs=${messages.length}`);
    jsonEnd(res, 400, { error: { message: "agy-bridge: unable to determine project directory" } });
    return;
  }

  const origin = originKey(messages);
  const bound = conversations[origin];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = bound && lastUser ? textOf(lastUser.content) : flatten(messages);

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  let sent = false;
  const headers = () => {
    if (sent || !canWrite(res)) return;
    sent = true;
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    } catch { return; }
    sse(res, chunk({ role: "assistant", content: "" }));
  };
  const emit = (delta) => { if (wantStream) { headers(); sse(res, chunk({ content: delta })); } };

  const started = Date.now();
  const result = await runAgy({
    prompt,
    model,
    cwd,
    conversationId: bound && bound.model === model ? bound.id : undefined,
    mode,
    onDelta: emit,
    signal: controller.signal,
  });

  if (result.conversationId) {
    conversations[origin] = { id: result.conversationId, model };
    saveConversations();
  }

  const usage = {
    prompt_tokens: result.usage.input_tokens || 0,
    completion_tokens: result.usage.output_tokens || 0,
    total_tokens: result.usage.total_tokens || 0,
  };
  log(`ok model=${model} mode=${mode} cwd=${cwd} reuse=${Boolean(bound)} ${Math.round((Date.now() - started) / 1000)}s in=${usage.prompt_tokens} out=${usage.completion_tokens}`);

  if (!result.text && result.code !== 0) {
    const message = (result.stderr || "agy failed").slice(0, 2000);
    log(`ERROR model=${model} ${message}`);
    if (wantStream && sent) {
      sse(res, chunk({ content: `\n[agy error] ${message}` }, "stop"));
      sendDone(res);
      endRes(res);
    } else {
      jsonEnd(res, 500, { error: { message } });
    }
    return;
  }

  if (wantStream) {
    headers();
    if (!result.text) sse(res, chunk({ content: result.text }));
    sse(res, chunk({}, "stop"));
    sse(res, { id, object: "chat.completion.chunk", created, model, choices: [], usage });
    sendDone(res);
    endRes(res);
    return;
  }

  jsonEnd(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    usage,
  });
});

server.on("error", (err) => {
  log(`FATAL ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`agy-openai-bridge listening on http://127.0.0.1:${PORT}/v1 mode=${FORCED_MODE || "auto"} state=${STATE_DIR}`);
});
