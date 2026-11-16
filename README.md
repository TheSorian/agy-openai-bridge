# agy-openai-bridge

Use Google's **Antigravity CLI** (`agy`) as an OpenAI-compatible model inside **OpenCode V2** — or any
client that speaks the OpenAI Chat Completions API.

A single Node file, no dependencies, no server-side wrapper around your credentials: it spawns the
official `agy` binary you already have signed in.

```text
OpenCode  ──HTTP──▶  agy-openai-bridge  ──spawn──▶  agy CLI  ──▶  Antigravity models
```

## Why this exists

The published `agy` integrations (`opencode-agy-plugin`, `opencode-agy-bridge`, `meridian`) target the
OpenCode **V1** plugin/provider contract. OpenCode V2 changed that contract: a provider package must
export `model(modelID, settings)` and return an internal `LanguageModel` built on an Effect `route`.
The V1 packages fail at load time with `Provider package ... does not export model(modelID, settings)`.

This project skips the provider contract entirely: it exposes `agy` over the OpenAI protocol, which
OpenCode V2 already supports natively through `@opencode/ai/providers/openai-compatible`.

## Requirements

- `agy` installed and signed in (`agy` once in a terminal, or `agy models` should list models).
- Node.js 20+ (tested on 24.22).
- Verified on Windows 11 with `agy` 1.5.7 and OpenCode 2.0.24. Linux/macOS paths are handled in code
  but not exercised by the author.

## Run it

```bash
node server.mjs
# agy-openai-bridge listening on http://127.0.0.1:8799/v1
```

The supervisor keeps it running and restarts it if it exits:

```bash
node scripts/supervise.mjs          # run, restart on exit
node scripts/supervise.mjs --stop   # stop the loop and kill the listener
```

The same through npm: `npm run supervise` and `npm run stop`.

**Windows autostart.** Run `scripts\install-task.ps1` once. It registers a hidden scheduled task that
runs `node.exe` with `scripts/supervise.mjs` at logon, for your user only. Task Scheduler starts the
process with no console window, so nothing appears in the taskbar. `-Uninstall` removes it again.

Why not a Startup shortcut or a `.cmd`/`.vbs` in `shell:startup`: script files there get quarantined
(Bitdefender removed this project's `.vbs` and then its `.cmd` during development), and a shortcut to
`node.exe` works but leaves a minimized console window.

The task passes `--start`, so logon always brings the bridge up. `npm run stop` keeps it down until the
next logon or a manual start, which is what "stopped" should mean.

Check it:

```bash
node smoke.mjs                           # one real turn, exits non-zero on failure
curl http://127.0.0.1:8799/v1/models     # model list
```

`smoke.mjs` runs its turn in the system temp directory, so it never writes into your project.

## Files

| Path | What it is |
| --- | --- |
| `server.mjs` | The bridge. The only file you need to run. |
| `scripts/supervise.mjs` | Supervisor: restarts the bridge, or stops it with `--stop`. |
| `scripts/install-task.ps1` | Registers the autostart task on Windows, or removes it with `-Uninstall`. |
| `smoke.mjs` | One end-to-end turn, for checking an install. |
| `examples/opencode.jsonc` | The provider block below, ready to paste. |

Runtime state (`bridge.log`, `conversations.json`) lives outside the repo, in
`%LOCALAPPDATA%\agy-bridge` or whatever `AGY_BRIDGE_STATE` points at.

## Configure OpenCode

Add a provider to `opencode.json(c)` (global or project) — a ready-to-paste copy of the block below is in
`examples/opencode.jsonc`. `apiKey` must be a non-empty string: the bridge does not authenticate, but
OpenCode's schema rejects `false`.

```jsonc
{
  "providers": {
    "agy": {
      "name": "Antigravity (agy)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8799/v1",
        "apiKey": "local-bridge"
      },
      "models": {
        "gemini-3.8-flash-high":   { "name": "Gemini 3.8 Flash (High)",   "tool_call": false },
        "gemini-3.8-flash-medium": { "name": "Gemini 3.8 Flash (Medium)", "tool_call": false },
        "gemini-3.8-flash-low":    { "name": "Gemini 3.8 Flash (Low)",    "tool_call": false },
        "claude-sonnet-4-6":       { "name": "Claude Sonnet 4.6",         "tool_call": false },
        "claude-opus-4-6-thinking":{ "name": "Claude Opus 4.6 (Thinking)","tool_call": false },
        "gpt-oss-120b-medium":     { "name": "GPT-OSS 120B (Medium)",     "tool_call": false }
      }
    }
  }
}
```

Model IDs must match what `agy models` prints for **your** account and plan. `tool_call: false` is
deliberate: the bridge does not forward tool calls, so `agy` uses its own tools instead of pretending to
call the client's.

## How it works

**One `agy` process per turn.** The bridge spawns:

```text
agy --add-dir <project> --output-format stream-json --input-format stream-json
    [--mode plan] [--model <id>] [--conversation <id>]
```

and writes `{"event":"user","message":{...}}` to stdin. The prompt goes over stdin because Windows
caps command-line arguments at ~32k characters, which a full transcript easily exceeds.

**Streaming.** `agy` emits NDJSON (`init`, `step_update` with `text_delta`, `result` with `usage`); the
bridge re-emits those deltas as OpenAI SSE chunks, so text appears as it is produced.

**Conversation reuse.** The first turn sends the whole transcript. The bridge remembers the
`conversation_id` from the `init` event, keyed by a hash of the system prompt + first user message, and
later turns send only the new message with `--conversation`. A cold start costs the client's full system
prompt (≈16k tokens with OpenCode); following turns are far cheaper.

**Plan mode.** OpenCode does not identify the agent in the request headers, but it sends only the enabled
tools. An agent without `write`/`edit` (OpenCode's plan agent) maps to `agy --mode plan`, which `agy`
enforces itself — it refuses to modify files even when the prompt asks it to ignore the restriction.
Set `AGY_BRIDGE_MODE=plan|normal` to force one mode and bypass the heuristic.

**Session titles.** OpenCode asks for a short title with a fixed system prompt. The bridge answers that
locally instead of spending an Antigravity turn.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGY_BRIDGE_PORT` | `8799` | Listening port (127.0.0.1 only). |
| `AGY_BINARY` | `agy` | Path to the CLI. |
| `AGY_BRIDGE_MODE` | *(auto)* | Force `plan` or `normal` for every turn. |
| `AGY_BRIDGE_STATE` | `%LOCALAPPDATA%\agy-bridge` | Directory for `bridge.log` and `conversations.json`. |
| `AGY_BRIDGE_CWD` | *(none)* | Fallback project directory when the client sends no environment block. |
| `AGY_BRIDGE_DEBUG` | *(off)* | Log the model and tool list of every request. |

## What this is not

- **Not a tool bridge.** Tools are not forwarded: `agy` uses its own file and shell tools inside the
  project, not the client's. You get no per-edit diff, no undo, and no approval prompt from OpenCode.
- **Text only.** Images, audio and PDF attachments are ignored.
- **Not a permission system.** In headless mode `agy` auto-approves its own tool calls. Plan mode is the
  only real restriction available, and it is `agy`'s.
- **Not audited or endorsed by Google.** It automates the official CLI with your existing sign-in; the
  usual caveats about automation and quota apply.

## Troubleshooting

- **Nothing answers:** check the port (`netstat -ano | findstr 8799`) and `bridge.log`.
- **`ENAMETOOLONG`:** obsolete — prompts now go through stdin. If you see it, you are running an old copy.
- **`unknown cwd`:** the client sent no working directory; set `AGY_BRIDGE_CWD`.
- **Empty or `[agy error]` replies:** run `agy models` to confirm the account is signed in and the model
  still exists. `agy changelog` will tell you whether the CLI changed its output format.

## Status

Written on 2026-11-16 against `agy` 1.5.7 and OpenCode 2.0.24. The `stream-json` event names are the one
part that can break with an `agy` update; the parser lives in `runAgy()` and is a few dozen lines.

## License

MIT. See the LICENSE file. Not affiliated with or endorsed by Google.
