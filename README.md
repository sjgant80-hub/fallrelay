# ◊ FallRelay · sovereign WebLLM bridge for Claude Code

**Save Sonnet API tokens by routing subagent work through your own browser's GPU.**

Prime 1009 · part of the [sjgant80-hub](https://github.com/sjgant80-hub) sovereign estate.

---

## For end users · the 30-second pitch

You're paying Anthropic for every token your Claude Code subagents spend. Most of those tokens go on routine work — short summaries, classifications, format conversions, fact-finds — that a free 1B-parameter model running in your browser would handle perfectly well.

FallRelay is two files that fix that:

1. **`index.html`** — open it in Chrome/Edge, click "load model", a Llama 3.2 1B (or Phi 3.5 / Qwen / Gemma) downloads once into your browser's IndexedDB cache. From then on it runs in your GPU (WebGPU) at ~1–15 seconds per call. Free.
2. **`mcp-server/server.mjs`** — a tiny Node MCP server you add to Claude Code's config. It exposes a `local_complete` tool that forwards prompts to your open browser tab via WebSocket and returns the completion.

When Claude Code needs subagent-tier work, it calls `local_complete` instead of spawning a Sonnet subagent. Your token bill drops. Your laptop fan spins.

Live: <https://sjgant80-hub.github.io/fallrelay/>

---

## Quick start

### 1. Open the browser side
- Visit <https://sjgant80-hub.github.io/fallrelay/> (or `open index.html` locally — works from `file://`).
- You need Chrome 113+ or Edge 113+ with WebGPU enabled. Check `chrome://gpu` — "WebGPU: Hardware accelerated" should be green.
- Pick a model from the dropdown. **Llama 3.2 1B** is the default (~1.2GB, fastest, fine for routine subagent work). For better quality try Phi 3.5 mini or Qwen 2.5 3B (~2.5GB, slower).
- Click "load / reload model". First time downloads weights (one-off, ~1-3 minutes); subsequent loads are instant from cache.
- When the model badge turns green, click "connect bridge".

### 2. Install the MCP server
```bash
git clone https://github.com/sjgant80-hub/fallrelay
cd fallrelay/mcp-server
npm install
```

### 3. Wire it into Claude Code
Edit `~/.claude/.mcp.json` (or `~/.claude/settings.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "fallrelay": {
      "command": "node",
      "args": ["C:/full/path/to/fallrelay/mcp-server/server.mjs"],
      "env": {
        "FALLRELAY_PORT": "17345"
      }
    }
  }
}
```

Restart Claude Code. The `local_complete` and `local_status` tools should appear.

### 4. Tell Claude to use it
Add to your project `CLAUDE.md` or a global preference:

> When a sub-task is routine — short summary, classification, format conversion, fact extract, draft prose — call `local_complete` first. Only fall back to spawning a Sonnet subagent or doing it yourself if the local result is empty, malformed, or off-topic.

That's it. Your token bill shrinks immediately.

---

## What "routine" looks like

Good fits for `local_complete` (Llama 3.2 1B can handle these):
- Summarise a 2k-token file into 5 bullets
- Classify a list of GitHub issues into bug / feature / question
- Convert markdown to JSON or vice versa
- Generate boilerplate (commit messages, PR descriptions)
- Extract entities from text (names, dates, urls)
- Rewrite for tone (formal / casual / brief)
- Simple regex / pattern explanation
- Translate short snippets

Bad fits (use Sonnet):
- Architectural reasoning across many files
- Debugging non-trivial code
- Cross-file refactors
- Writing novel non-trivial code
- Anything safety-critical

Rule of thumb: if Sonnet would do it in under 30 seconds and the answer fits in 200 tokens, try `local_complete` first.

---

## Estimated token savings

The browser KPI tile shows estimated Sonnet output cost saved (priced at $15/M output tokens × 0.79 GBP). A typical day of Claude Code with FallRelay handling routine subagent calls:

- 100 calls × 300 tokens output each = 30k tokens
- 30k × $15/M × 0.79 = **~£0.36 per day** in saved Sonnet output costs
- More importantly: those 30k tokens don't count toward your 5hr quota window. Subagent-heavy days that used to bounce off the limit now don't.

---

## For developers · architecture

```
Claude Code              MCP server                Browser tab
─────────────            ──────────                ───────────
[Tool call]   stdio    [server.mjs]      WS       [index.html]
local_complete  ──>    routes msg   ──>          waits for req
              <──      back via WS    <──         runs WebLLM
              <──      back to tool   <──         returns text
```

- **MCP server (`mcp-server/server.mjs`)**: stdio-protocol server speaking MCP 1.0. Two tools: `local_complete(prompt|messages, max_tokens, temperature, system)` and `local_status()`. Maintains one active WebSocket connection from the browser tab on `ws://localhost:17345/relay`. Each tool call gets a UUID, is sent to the browser, awaits the response (timeout 120s default).
- **Browser tab (`index.html`)**: sovereign single-file. Loads [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) via ESM CDN. WebGPU inference. WebSocket client. Persistent IDB cache for model weights. Test pane for local sanity checks. Live KPIs: total calls, tokens generated, cost saved, average latency.

### Why a browser tab and not Node-based llama.cpp?
- **WebGPU works out-of-the-box** in modern Chrome/Edge with no native install.
- **Model cache survives across Claude Code sessions** in IDB without a separate model directory to manage.
- **Sovereign** — weights never leave the user's machine, no third-party model server.
- **Forkable** — anyone can replace the model dropdown with their own URL list.

### Limitations / gotchas
- One browser tab at a time (the WS server reuses the connection — second tab kicks the first off).
- Tab must stay open. Closing it = no inference until you reopen.
- WebGPU needs a discrete or modern integrated GPU. Old laptops will fall back to CPU/WASM (slow, ~30-90s/call).
- First model load downloads ~1.2-3GB. Be on a decent connection.
- Llama 3.2 1B is *fast but small* — quality matches GPT-3.5-tier for short tasks. Don't expect Claude-tier reasoning.
- No streaming yet. Each call returns the full completion at the end.
- Currently English-tuned models default — for other languages, swap to Qwen 2.5 (better multilingual) or a Gemma variant.

### Customising the model list
Edit `index.html` `<select id="modelSelect">` — any model ID from the [MLC model registry](https://mlc.ai/models) works as-is (they're all auto-cached after first download).

### Custom MCP port
Set `FALLRELAY_PORT` env in your `.mcp.json` config. Browser tab's "MCP bridge port" input must match. Default 17345 (prime, 17345 = 5 × 3469 — fine, doesn't need to be prime for the port).

### Testing the bridge standalone
Run `node mcp-server/server.mjs --bridge-only` to start just the WS server (no MCP stdio). Useful for testing the browser side without Claude Code.

---

## 14-pt sovereign gate compliance

- ✅ Single HTML file (browser side) + tiny Node MCP server (necessary for stdio bridge — same pattern as `fall-mcp-bridge`)
- ✅ `<400KB target — index.html is ~14KB
- ✅ Sovereign — runs from `file://` or static host
- ✅ No external services beyond MLC model registry (CDN-served weights)
- ✅ KONOMI shim baked (sovereign tier, prime 1009)
- ✅ fall-signal mesh hook on boot
- ✅ PWA manifest data: URL
- ✅ Mobile-responsive layout (not the primary use case but doesn't break)
- ✅ MIT licence
- ✅ Two-audience README (this file)

---

## Roadmap (out of scope for v1.0.0)

- Streaming token responses through MCP (currently buffers to completion)
- Multiple-tab load balancing
- Anti-cost-overflow guard rails (auto-block calls > N tokens)
- Built-in eval suite for "is this task local-suitable?" routing classifier
- Optional `fall-client` mesh integration (cross-tool client context for the IFA / law / etc. bundles)

---

## Licence

MIT · 2026 · Simon Gant · part of the sjgant80-hub sovereign estate.

> Phoenix's idea, Simon's build, sovereign by default.
