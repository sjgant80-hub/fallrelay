#!/usr/bin/env node
// FallRelay MCP server · v1.0.0 · prime 1009
// Bridges Claude Code's `local_complete` tool calls to a browser tab running WebLLM.
//
// Architecture: stdio MCP server <-> WebSocket bridge <-> open browser tab (relay-browser)
//
// Run: node server.mjs           (stdio MCP — what Claude Code spawns)
//      node server.mjs --bridge  (only the WS bridge for the browser, for debugging)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const VERSION = '1.0.0';
const PRIME = 1009;
const PORT = +(process.env.FALLRELAY_PORT || 17345);
const REQUEST_TIMEOUT_MS = +(process.env.FALLRELAY_TIMEOUT_MS || 120000);

// -------- WS bridge: one browser tab provides the actual inference --------
let activeBrowser = null;            // current ws connection to browser
let browserModel = null;
const pending = new Map();           // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: PORT, path: '/relay' });
wss.on('connection', (ws) => {
  if (activeBrowser) {
    try { activeBrowser.close(1000, 'replaced by new browser'); } catch {}
  }
  activeBrowser = ws;
  process.stderr.write(`[fallrelay] browser connected on :${PORT}\n`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.kind === 'hello') {
      browserModel = msg.model || null;
      process.stderr.write(`[fallrelay] browser model: ${browserModel}\n`);
      return;
    }
    if (msg.kind === 'response') {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'browser error'));
    }
  });
  ws.on('close', () => {
    if (activeBrowser === ws) { activeBrowser = null; browserModel = null; }
    process.stderr.write(`[fallrelay] browser disconnected\n`);
    // reject any pending requests
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('browser disconnected'));
      pending.delete(id);
    }
  });
});

wss.on('error', (e) => {
  process.stderr.write(`[fallrelay] ws error: ${e.message}\n`);
});

function relayComplete({ prompt, messages, max_tokens = 512, temperature = 0.7, system = null }) {
  return new Promise((resolve, reject) => {
    if (!activeBrowser) {
      reject(new Error(`No browser tab connected to FallRelay on ws://localhost:${PORT}/relay. Open fallrelay/index.html, load a model, click "connect bridge", then retry.`));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    activeBrowser.send(JSON.stringify({
      kind: 'request', id, prompt, messages, max_tokens, temperature, system
    }));
  });
}

// -------- MCP stdio server --------
if (process.argv.includes('--bridge-only')) {
  process.stderr.write(`[fallrelay] bridge-only mode on :${PORT}\n`);
  // just keep the WS server alive
} else {
  const server = new Server({
    name: 'fallrelay',
    version: VERSION,
  }, {
    capabilities: { tools: {} }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'local_complete',
        description: 'Run a chat completion on the user\'s local WebLLM (FallRelay browser tab) instead of burning Claude API tokens. Use for routine subagent work: short summaries, classification, formatting, simple Q&A, draft generation. Latency: ~1-15s per call depending on model + hardware. Returns plain text. Falls back with a clear error if the browser tab is not open or has no model loaded. The browser-side defaults to Llama 3.2 1B Instruct but the user can swap to Phi-3.5-mini / Qwen 2.5 / Gemma 2 etc.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'A single user prompt. Use either `prompt` or `messages`, not both.' },
            messages: {
              type: 'array',
              description: 'Full chat messages array. Each item: {role: "system"|"user"|"assistant", content: "..."}. Use this for multi-turn or system-prompt-shaped calls.',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' }
                },
                required: ['role', 'content']
              }
            },
            system: { type: 'string', description: 'Optional system prompt (used only with `prompt`, not `messages`).' },
            max_tokens: { type: 'integer', description: 'Max completion tokens (default 512, capped 4096).', default: 512 },
            temperature: { type: 'number', description: 'Sampling temperature 0-2 (default 0.7).', default: 0.7 }
          }
        }
      },
      {
        name: 'local_status',
        description: 'Check the FallRelay bridge: is a browser connected, which model is loaded, queue depth. Use this before relying on local_complete for important work.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'local_status') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: !!activeBrowser,
              model: browserModel,
              port: PORT,
              pending: pending.size,
              version: VERSION,
              prime: PRIME,
              tip: activeBrowser
                ? `ready · model=${browserModel || '?'}`
                : `no browser connected · open fallrelay/index.html and click "connect bridge"`
            })
          }]
        };
      }
      if (name === 'local_complete') {
        const r = await relayComplete(args || {});
        return {
          content: [{ type: 'text', text: r.text }],
          isError: false,
          _meta: { model: r.model, latency_ms: r.latency_ms, usage: r.usage }
        };
      }
      throw new Error(`unknown tool: ${name}`);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `FallRelay error: ${e.message}` }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[fallrelay] mcp server ready · ws bridge :${PORT}\n`);
}

// Shutdown
process.on('SIGINT', () => { try { wss.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { wss.close(); } catch {} process.exit(0); });
