// smoke.mjs — one real turn against a running bridge. No dependencies.
//   node smoke.mjs [model]
// Sends a throwaway prompt from a temp directory, so nothing is written into your project.
import os from "node:os";
import path from "node:path";

const BASE = (process.env.AGY_BRIDGE_URL || "http://127.0.0.1:8799/v1").replace(/\/$/, "");
const MODEL = process.argv[2] || process.env.AGY_SMOKE_MODEL || "gemini-3.8-flash-medium";
const PROJECT = process.env.AGY_BRIDGE_CWD || os.tmpdir();

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

const metrics = await (async () => {
  let res;
  try {
    res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    fail(`cannot reach ${BASE} — is the bridge running? (${err.message})`);
  }
  if (!res.ok) fail(`GET /models returned ${res.status}`);
  const body = await res.json();
  const ids = (body.data || []).map((m) => m.id);
  if (!ids.length) fail("bridge reports no models");
  if (!ids.includes(MODEL)) fail(`model ${MODEL} not in list: ${ids.join(", ")}`);
  console.log(`ok    ${ids.length} models, using ${MODEL}`);
  return ids;
})();

const started = Date.now();
const res = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  signal: AbortSignal.timeout(180000),
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    // The bridge reads the project directory from the system prompt and runs agy there.
    messages: [
      { role: "system", content: `You are a test client. Working directory: ${PROJECT}` },
      { role: "user", content: "Reply with the single word: OK" },
    ],
    // A mutating tool present means build mode, not plan.
    tools: [{ type: "function", function: { name: "write", description: "write a file", parameters: { type: "object" } } }],
  }),
});

if (!res.ok) {
  const text = await res.text();
  fail(`POST /chat/completions returned ${res.status}: ${text.slice(0, 300)}`);
}

const body = await res.json();
const reply = (body.choices?.[0]?.message?.content || "").trim();
const usage = body.usage || {};
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!reply) fail("empty reply");
if (reply.length > 200) fail(`reply is suspiciously long (${reply.length} chars): ${reply.slice(0, 120)}…`);

console.log(`ok    reply in ${seconds}s: ${JSON.stringify(reply.slice(0, 80))}`);
console.log(`ok    tokens in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0}`);
console.log("\nbridge is working.");
