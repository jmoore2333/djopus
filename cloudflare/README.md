# DJ Opus

A live-coding music environment that connects AI agents to [Strudel](https://strudel.cc) via WebSocket, deployed on Cloudflare Workers.

DJ Opus lets an AI compose, play, modify, and mix music in real time through a browser-based synthesizer. It replaces traditional browser automation (Playwright/Puppeteer) with a WebSocket architecture that enables bidirectional communication, persistent undo/redo history, incremental pattern editing, and live tempo changes.

## How It Works

DJ Opus has three layers:

### 1. MCP Server (runs locally)

The **Model Context Protocol** (MCP) server is a lightweight Node.js process that exposes 20 tools for music creation. It speaks the [MCP standard](https://modelcontextprotocol.io/), making it compatible with:

- **Claude Code** (Anthropic's CLI)
- **Claude Desktop**
- **Any MCP-compatible client** — including open-source harnesses like [mcphost](https://github.com/nicholasgasior/mcphost), [mcp-cli](https://github.com/wong2/mcp-cli), or custom integrations
- **Local/self-hosted models** — any LLM harness that supports MCP stdio transport can drive DJ Opus, including Ollama, LM Studio, or fine-tuned models

The MCP server connects to the Worker via WebSocket (as a `controller`) and REST API. It generates no audio itself — it sends commands.

### 2. Cloudflare Worker (runs at the edge)

The Worker handles:
- **WebSocket relay** via a Durable Object (`SessionBridge`) — routes commands from controllers to browsers and status/errors back
- **Pattern storage** via D1 (SQLite) — save, load, list, delete patterns
- **Pattern generation** via ported MusicTheory and PatternGenerator services — scales, chords, drum patterns, basslines, complete multi-layer compositions
- **Static asset serving** — the Strudel REPL itself
- **Session persistence** — the Durable Object uses SQLite storage that survives evictions, so your undo history and current pattern persist across sessions

### 3. Browser (runs on your machine)

The Strudel REPL runs in any browser. A small bridge script (`strudel-ws-bridge.js`) connects via WebSocket to the Worker as a `browser` role client. It receives commands (evaluate, stop, set_tempo, etc.) and calls the Strudel editor API (`strudelMirror`) to execute them. All audio synthesis happens here via Web Audio API.

```
AI Agent (Claude, Ollama, etc.)
        | MCP protocol (stdio)
        v
MCP Server (local Node.js)
        | WebSocket + REST
        v
Cloudflare Worker
        |
   Durable Object (SessionBridge)
   [SQLite-backed persistent state]
        | WebSocket
        v
Browser (Strudel REPL -> Web Audio API -> speakers)
```

## Why Cloudflare Workers?

DJ Opus runs entirely on Cloudflare's **free tier**:

| Resource | Free Tier Limit | DJ Opus Usage |
|----------|----------------|---------------|
| Worker requests | 100K/day | ~hundreds per session |
| Durable Object requests | 1M/month | WebSocket messages |
| Durable Object storage | 1GB | Pattern history (~KB) |
| D1 database | 5GB, 5M rows/day | Pattern storage |
| Static assets | 25MB | Strudel REPL |

Benefits:
- **Zero server cost** — no VMs, no containers, no billing surprises
- **Global edge deployment** — low latency WebSocket from anywhere
- **Durable Objects** — stateful WebSocket sessions with built-in persistence
- **D1** — serverless SQLite for pattern storage, zero config
- **Custom domains** — bring your own domain with automatic TLS
- **Cloudflare Access** — optional authentication without code changes

## MCP Tools (21)

### Session Pairing

The MCP auto-generates a unique session ID on startup (e.g., `opus-7f3k`). On the first tool call, if no browser is connected, the response includes the URL to open. Use `connect` to switch to an existing browser session without restarting.

| Category | Tool | Description |
|----------|------|-------------|
| **Playback** | `write` | Write pattern to editor, optionally play |
| | `play` | Evaluate and play current editor code |
| | `stop` | Stop playback |
| | `set_tempo` | Change BPM in real-time without rewriting pattern |
| | `get_state` | Get session state (playing, clients, history) |
| **Editing** | `get_code` | Read current editor content from browser |
| | `append_code` | Append code to current pattern |
| | `replace_code` | Search/replace in current code |
| | `add_effect` | Append effect chain (room, delay, etc.) |
| **History** | `undo` | Undo last pattern change (50 entries, persisted) |
| | `redo` | Redo previously undone change |
| **Storage** | `save` | Save current pattern to D1 database |
| | `load` | Load pattern from D1, optionally play |
| | `list` | List saved patterns (optional tag filter) |
| | `delete` | Delete a saved pattern |
| **Generation** | `generate_pattern` | Generate full multi-layer pattern |
| | `generate_drums` | Generate drum pattern by style |
| | `generate_bassline` | Generate bassline by key and style |
| **Validation** | `validate` | Check pattern syntax and safety |
| **Composite** | `compose` | One-shot: generate + write + play |
| **Session** | `connect` | Switch MCP to a different browser session by code |

Styles: techno, house, trance, dnb, ambient, trap, jungle, breakbeat, trip_hop, boom_bap, intelligent_dnb, experimental

## Quick Start

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier works)
- `wrangler` CLI (`npm install -g wrangler`)
- `pnpm` (for building Strudel from source)

### 1. Clone and install

```bash
git clone <this-repo>
cd cloudflare
npm install
cd mcp && npm install && cd ..
```

### 2. Configure Cloudflare

```bash
# Authenticate with Cloudflare
wrangler login

# Create D1 database
wrangler d1 create djopus

# Update wrangler.toml with your D1 database ID
# Change the custom domain to your domain (or remove the [[routes]] block)

# Apply D1 migrations
wrangler d1 migrations apply djopus --remote
```

### 3. Build the Strudel REPL

The `static/` directory needs the built Strudel REPL. Clone the Strudel source and build it:

```bash
git clone https://codeberg.org/uzu/strudel.git ../source
cd ../source && pnpm install && pnpm run build
rm -rf ../cloudflare/static
cp -r website/dist ../cloudflare/static
cp ../cloudflare/client/strudel-ws-bridge.js ../cloudflare/static/
cd ../cloudflare
```

The Astro template at `source/website/src/pages/index.astro` should include:
```html
<script is:inline src="/strudel-ws-bridge.js"></script>
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Register the MCP

With Claude Code (no session ID needed — auto-generated per conversation):
```bash
claude mcp add --transport stdio \
  -e DJOPUS_URL=https://your-domain.com \
  -s user \
  djopus -- npx tsx ./mcp/src/index.ts
```

Or manually in any MCP-compatible client's config:
```json
{
  "mcpServers": {
    "djopus": {
      "command": "npx",
      "args": ["tsx", "./mcp/src/index.ts"],
      "env": {
        "DJOPUS_URL": "https://your-domain.com"
      }
    }
  }
}
```

### 6. Use it

1. Open your deployed URL in a browser
2. Click "play" once to unlock the Web Audio context
3. Console should show `[strudel-ws] connected to session: default`
4. Ask your AI to `compose techno at 130 BPM in D minor`

## Project Structure

```
cloudflare/
├── wrangler.toml                 # Workers config (D1, DO w/ SQLite, assets, custom domain)
├── package.json
├── tsconfig.json
├── .gitignore
├── drizzle/
│   └── 0001_create_patterns.sql  # D1 schema
├── src/
│   ├── index.ts                  # Worker entry: routing, WS upgrade, asset serving
│   ├── env.ts                    # Env type bindings
│   ├── session-bridge.ts         # Durable Object: WS relay, undo/redo, SQLite persistence
│   ├── api.ts                    # REST API routes (CORS enabled)
│   ├── protocol.ts               # WebSocket message types (request_id correlation)
│   └── services/
│       ├── MusicTheory.ts        # Scales, chords, euclidean rhythms
│       ├── PatternGenerator.ts   # Genre-based pattern generation
│       └── PatternValidator.ts   # Pattern syntax validation
├── client/
│   └── strudel-ws-bridge.js      # Browser-side WebSocket client
├── mcp/                          # Lightweight MCP server (20 tools)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # MCP server entry (stdio transport)
│       ├── WorkerClient.ts       # WebSocket + REST client (auto-reconnect)
│       └── tools.ts              # Tool definitions
└── static/                       # Built Strudel REPL (not committed, build from source)
```

## WebSocket Protocol

Connect: `wss://your-domain.com/ws?session=<id>&role=<browser|controller>`

All commands support `request_id` (UUID) for request-response correlation.

### Commands (Controller -> Browser via DO)

```json
{"type":"evaluate","request_id":"uuid","payload":{"code":"s(\"bd*4\")"}}
{"type":"stop","request_id":"uuid"}
{"type":"set_code","request_id":"uuid","payload":{"code":"..."}}
{"type":"set_tempo","request_id":"uuid","payload":{"bpm":138}}
{"type":"get_code","request_id":"uuid"}
{"type":"append_code","request_id":"uuid","payload":{"code":"..."}}
{"type":"replace_code","request_id":"uuid","payload":{"search":"...","replace":"..."}}
{"type":"add_effect","request_id":"uuid","payload":{"effect":"room","params":{"0":0.5}}}
{"type":"undo","request_id":"uuid"}
{"type":"redo","request_id":"uuid"}
{"type":"get_state","request_id":"uuid"}
```

### Responses

```json
{"type":"ack","request_id":"uuid","status":"playing","payload":{"browsers":1}}
{"type":"ack","request_id":"uuid","status":"no_browser","payload":{"warning":"..."}}
{"type":"code_response","request_id":"uuid","payload":{"code":"..."}}
{"type":"session_state","payload":{"currentPattern":"...","isPlaying":false,"historySize":5}}
{"type":"client_status","payload":{"isPlaying":true,"bpm":138,"codeLength":245}}
{"type":"pattern_error","request_id":"uuid","payload":{"message":"..."}}
```

## REST API

```
GET    /api/health
GET    /api/patterns              # List (optional ?tag=)
POST   /api/patterns              # Save { name, content, tags[] }
GET    /api/patterns/:name        # Load
DELETE /api/patterns/:name        # Delete
POST   /api/generate/pattern      # { style, bpm?, key? }
POST   /api/generate/drums        # { style, complexity? }
POST   /api/generate/bassline     # { key, style }
POST   /api/generate/scale        # { root, scale }
POST   /api/generate/chords       # { key, style }
POST   /api/validate              # { pattern }
```

All responses include CORS headers.

## Adapting for Other Models

The MCP server uses the standard [Model Context Protocol](https://modelcontextprotocol.io/) over stdio transport. Any LLM that can call tools via MCP can drive DJ Opus:

**Cloud models:** Claude (via Claude Code or Desktop), GPT-4 (via MCP bridge), Gemini (via MCP adapter)

**Local models:** Run a local model (Ollama, LM Studio, llama.cpp) with an MCP-compatible harness. The model calls `compose`, `write`, `set_tempo`, etc. — no cloud AI required for the music generation itself.

**Fine-tuning opportunity:** The pattern generation services (`MusicTheory.ts`, `PatternGenerator.ts`) produce Strudel code strings. A model fine-tuned on Strudel patterns could bypass these services entirely and write patterns directly via the `write` tool, enabling more creative and genre-authentic output.

**Custom controllers:** You don't need the MCP at all. Any WebSocket client that connects to `/ws?session=<id>&role=controller` and speaks the protocol can control the REPL. Build a mobile app, a hardware controller, or a custom UI.

## Pattern Code Tips

When writing Strudel patterns:
- Use `setcps(bpm/60/4)` for tempo (standard 4/4 time)
- No emoji in pattern code
- No `.mul()` / `.add()` on slider values
- `.vowel("<a e i o>")` on sawtooth is reliable for vocal textures
- GM voice instruments may not produce output — use synthesis
- See the [Strudel docs](https://strudel.cc/workshop/getting-started/) for the full pattern language

## License

[MIT](../LICENSE) — see root LICENSE file for third-party notices.

The Strudel REPL (served from `static/`, not committed) is AGPL-3.0. The `MusicTheory.ts`, `PatternGenerator.ts`, and `PatternValidator.ts` services are ported from [strudel-mcp-server](https://github.com/williamzujkowski/strudel-mcp-server) (MIT, Copyright 2025 William Zujkowski).

## Credits

- [Strudel](https://strudel.cc) by Alex McLean and contributors (AGPL-3.0)
- [strudel-mcp-server](https://github.com/williamzujkowski/strudel-mcp-server) by William Zujkowski (MIT)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- Built by [moore.nyc](https://moore.nyc)
