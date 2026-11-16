// Supervisor for agy-openai-bridge.
//
//   node scripts/supervise.mjs          run the bridge, restarts it if it exits
//   node scripts/supervise.mjs --start  same, but clears a previous stop first
//   node scripts/supervise.mjs --stop   stop the loop (flag) and kill the listener
//
// Without --start a stop flag wins, so a scheduler that re-runs this file cannot resurrect
// a bridge you deliberately stopped.
//
// One implementation for every platform, and no .cmd/.vbs: script files that a Windows
// startup entry points at tend to get quarantined by antivirus products, while a signed
// node.exe running a .mjs does not.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SERVER = path.join(ROOT, "server.mjs");
const PORT = Number(process.env.AGY_BRIDGE_PORT || 8799);
const HOME = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const STATE_DIR = process.env.AGY_BRIDGE_STATE || path.join(HOME, "agy-bridge");
const FLAG = path.join(STATE_DIR, "stopped");

fs.mkdirSync(STATE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`supervise: ${msg}`);

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });
  } catch {
    return "";
  }
};

// PIDs listening on PORT, best effort: empty when the tools are missing or nothing listens.
function listenerPids() {
  if (process.platform === "win32") {
    return [...new Set(
      run("netstat", ["-ano"])
        .split(/\r?\n/)
        .filter((line) => line.includes(`127.0.0.1:${PORT}`) && /LISTENING/i.test(line))
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid),
    )];
  }
  return run("lsof", ["-ti", `tcp:${PORT}`]).split(/\s+/).filter(Boolean);
}

if (process.argv.includes("--stop")) {
  fs.writeFileSync(FLAG, `stopped ${new Date().toISOString()}\n`);
  const pids = listenerPids();
  if (!pids.length) log(`nothing was listening on ${PORT}`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      log(`killed pid ${pid}`);
    } catch (err) {
      log(`could not kill pid ${pid}: ${err.message}`);
    }
  }
  log("stopped. Start again with: node scripts/supervise.mjs");
  process.exit(0);
}

if (fs.existsSync(FLAG) && !process.argv.includes("--start")) {
  log("stopped flag present, not starting (use --start to override)");
  process.exit(0);
}

fs.rmSync(FLAG, { force: true });
log(`watching ${SERVER} on port ${PORT}`);
log(`state in ${STATE_DIR} — Ctrl+C to stop`);

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: "inherit" });
  const started = Date.now();
  const code = await new Promise((resolve) => child.on("close", resolve));

  if (fs.existsSync(FLAG)) {
    log("stop flag found, exiting");
    break;
  }
  if (stopping) break;
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`bridge exited with code ${code} after ${seconds}s, restarting`);
  await sleep(2000);
}

log("supervisor stopped");
