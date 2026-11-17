// Keeps the `providers.agy.models` list in your OpenCode config in step with `agy models`.
//
//   node scripts/sync-models.mjs                  update ~/.config/opencode/opencode.jsonc
//   node scripts/sync-models.mjs --dry            print the new block, write nothing
//   node scripts/sync-models.mjs --config <file>  use another config file
//
// It targets the global config on purpose: $OPENCODE_CONFIG usually points at a project file that
// has no agy block. Pass --config for a project-level setup.
//
// agy lists thinking levels as separate models (gemini-3.8-flash-low, -medium, -high). OpenCode
// picks the level with a variant instead, so siblings are folded into one model whose variants
// put the real agy id in the request body. Everything else is copied one to one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGY = process.env.AGY_BINARY || "agy";
const LEVELS = ["low", "medium", "high"];
const DEFAULT_LIMIT = { context: 200000, output: 16384 };

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const configIndex = argv.indexOf("--config");
let configPath =
  configIndex >= 0 && argv[configIndex + 1]
    ? path.resolve(argv[configIndex + 1])
    : path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");

if (!fs.existsSync(configPath) && configPath.endsWith(".jsonc")) {
  const json = configPath.replace(/c$/, "");
  if (fs.existsSync(json)) configPath = json;
}

const fail = (message) => {
  console.error(`sync-models: ${message}`);
  process.exit(1);
};

function readAgyModels() {
  let out;
  try {
    out = execFileSync(AGY, ["models"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    fail(`could not run \`${AGY} models\`: ${err.message}`);
  }
  const seen = new Set();
  const models = [];
  for (const line of out.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const [rawId, ...rest] = line.split("\t");
    const id = (rawId || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, title: rest.join("\t").trim() || id });
  }
  if (!models.length) fail("`agy models` returned no models");
  return models;
}

// Minimal JSON/JSONC scanner: enough to find a member's value range without reformatting the
// rest of the file.
function readString(text, start) {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (text[i] === "\\") { escaped = true; continue; }
    if (text[i] === '"') return i;
  }
  throw new Error("unterminated string");
}

function skipValue(text, start) {
  const open = text[start];
  if (open === '"') return readString(text, start);
  if (open === "{" || open === "[") {
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (lineComment) { if (ch === "\n") lineComment = false; continue; }
      if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
      if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error(`unterminated ${open}`);
  }
  let i = start;
  while (i < text.length && !",}] \t\r\n".includes(text[i])) i++;
  return i - 1;
}

function findMember(text, objectStart, key) {
  let i = objectStart + 1;
  while (i < text.length) {
    while (i < text.length && (/\s/.test(text[i]) || text[i] === ",")) i++;
    if (i >= text.length || text[i] === "}") return null;
    if (text[i] === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (text[i] !== '"') throw new Error(`expected a key at offset ${i}`);
    const keyEnd = readString(text, i);
    const name = JSON.parse(text.slice(i, keyEnd + 1));
    i = keyEnd + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ":") throw new Error(`expected ":" after ${name}`);
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    const start = i;
    const end = skipValue(text, i);
    if (name === key) return { start, end };
    i = end + 1;
  }
  return null;
}

function stripComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") { lineComment = false; out += ch; }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    out += ch;
  }
  return out;
}

const text = fs.readFileSync(configPath, "utf8");
const root = text.indexOf("{");
if (root < 0) fail("config does not look like JSON");

const providers = findMember(text, root, "providers");
if (!providers) fail("no providers block in the config");
const agy = findMember(text, providers.start, "agy");
if (!agy) fail("no providers.agy block in the config (paste examples/opencode.jsonc first)");
const modelsBlock = findMember(text, agy.start, "models");
if (!modelsBlock || text[modelsBlock.start] !== "{") fail("no providers.agy.models object in the config");

let current;
try {
  current = JSON.parse(stripComments(text.slice(modelsBlock.start, modelsBlock.end + 1)));
} catch (err) {
  fail(`could not parse providers.agy.models: ${err.message}`);
}

const models = readAgyModels();
const groups = new Map();
const singles = [];
for (const model of models) {
  const match = model.id.match(/^(.*)-(low|medium|high)$/);
  if (match) {
    if (!groups.has(match[1])) groups.set(match[1], new Map());
    groups.get(match[1]).set(match[2], model);
  } else {
    singles.push(model);
  }
}

const items = [];
for (const [base, levels] of groups) {
  if (levels.size < 2) {
    singles.push([...levels.values()][0]);
    continue;
  }
  const present = LEVELS.filter((level) => levels.has(level));
  const baseModel = levels.get("medium") || levels.get(present[0]);
  const title = baseModel.title.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, "").trim() || base;
  items.push({
    key: base,
    name: title,
    group: true,
    baseID: baseModel.id,
    levels: present.map((level) => ({ level, id: levels.get(level).id })),
  });
}
for (const model of singles) items.push({ key: model.id, name: model.title, group: false });

const next = {};
for (const item of items) {
  const existing =
    current[item.key] && typeof current[item.key] === "object" ? structuredClone(current[item.key]) : {};
  if (!existing.name) existing.name = item.name;
  if (!existing.limit) {
    const seed = item.group ? current[item.baseID] || current[item.levels[0].id] : current[item.key];
    existing.limit = seed && seed.limit ? structuredClone(seed.limit) : structuredClone(DEFAULT_LIMIT);
  }
  if (item.group) {
    existing.modelID = item.baseID;
    existing.capabilities = {
      ...(existing.capabilities || {}),
      reasoning: { supported: true, effort: item.levels.map((level) => level.level) },
    };
    existing.variants = item.levels.map((level) => ({ id: level.level, body: { model: level.id } }));
  }
  next[item.key] = existing;
}

// Models that vanished from the account, and hand-written entries, stay in place: being offline
// or on another plan should not silently delete a model you pinned.
const groupedIDs = new Set();
for (const [, levels] of groups) {
  if (levels.size < 2) continue;
  for (const model of levels.values()) groupedIDs.add(model.id);
}
for (const [key, value] of Object.entries(current)) {
  if (next[key] || groupedIDs.has(key)) continue;
  next[key] = value;
}

const body = Object.entries(next)
  .map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(",\n");
const block = body ? `{\n${body}\n      }` : "{}";
const updated = text.slice(0, modelsBlock.start) + block + text.slice(modelsBlock.end + 1);

try {
  JSON.parse(stripComments(updated));
} catch (err) {
  fail(`the rewritten config would not parse, nothing written: ${err.message}`);
}

const added = Object.keys(next).filter((key) => !current[key]);
const folded = [...groupedIDs].filter((id) => current[id] && !next[id]);
const removed = Object.keys(current).filter((key) => !next[key] && !groupedIDs.has(key));

console.log(`${models.length} models from agy, ${Object.keys(next).length} entries in ${configPath}`);
if (added.length) console.log(`added     : ${added.join(", ")}`);
if (folded.length) console.log(`folded    : ${folded.join(", ")}`);
if (removed.length) console.log(`dropped   : ${removed.join(", ")}`);

if (updated === text) {
  console.log("already in sync, nothing written");
  process.exit(0);
}

if (dry) {
  console.log("\n--- providers.agy.models (dry run, nothing written) ---");
  console.log(block);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const backup = `${configPath}.bak-${stamp}`;
fs.copyFileSync(configPath, backup);
fs.writeFileSync(configPath, updated);
console.log(`wrote it, backup at ${path.basename(backup)}`);
