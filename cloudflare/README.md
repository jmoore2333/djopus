# DJ Opus

A live-coding music environment that connects AI agents to [Strudel](https://strudel.cc) via WebSocket, deployed on Cloudflare Workers.

DJ Opus lets an AI compose, play, modify, and mix music in real time through a browser-based synthesizer. It replaces traditional browser automation (Playwright/Puppeteer) with a WebSocket architecture that enables bidirectional communication, persistent undo/redo history, incremental pattern editing, and live tempo changes.

## How It Works

DJ Opus has three layers:

### 1. MCP endpoint (`/mcp`)

The Worker is itself a remote **Model Context Protocol** server, at `/mcp` (Streamable HTTP, built on the Cloudflare Agents SDK's `McpAgent`). It exposes 23 tools for music creation and speaks the [MCP standard](https://modelcontextprotocol.io/), so any client that can take an MCP URL can use it:

- **Claude Code** (Anthropic's CLI)
- **Any MCP-compatible client** — including open-source harnesses like [mcphost](https://github.com/nicholasgasior/mcphost), [mcp-cli](https://github.com/wong2/mcp-cli), or custom integrations
- **Local/self-hosted models** — any LLM harness that supports MCP, including Ollama, LM Studio, or fine-tuned models

Each MCP session gets its own Durable Object, which remembers the DJ Opus session it is bound to. `/mcp` requests are rate limited per IP.

For clients that can only start a local process, [`mcp/`](mcp/) is a thin stdio-to-HTTP proxy for the same endpoint. It forwards `tools/list` and `tools/call` to `<DJOPUS_URL>/mcp` (`DJOPUS_URL` defaults to `https://play.djopus.party`) and, when the remote has forgotten its MCP session, starts a new one and retries the request once. Use it only for clients without HTTP MCP.

The server generates no audio itself: it sends commands.

### 2. Cloudflare Worker (runs at the edge)

The Worker handles:
- **Session relay** via a Durable Object (`SessionBridge`), one per DJ Opus session — routes commands from the MCP tools to the browser and status/errors back
- **Session state** — the Durable Object's SQLite storage keeps the current pattern, the undo/redo history (up to 50 entries) and the session's crate of saved patterns, so they survive evictions. A session is deleted after 30 days without activity
- **Pattern generation** via ported MusicTheory and PatternGenerator services — scales, chords, drum patterns, basslines, complete multi-layer compositions
- **Static asset serving** — the Strudel REPL itself, with the player at `/s/<id>`

The app has no database (no D1) and needs no secrets.

### 3. Browser (runs on your machine)

The player is a patched build of the Strudel REPL. A small bridge script (`strudel-ws-bridge.js`) connects to `/ws?session=<id>` and receives commands (evaluate, stop, set_tempo, etc.), which it runs against the Strudel editor API (`strudelMirror`). All audio synthesis happens here via Web Audio API. When you run code yourself, the bridge reports it to the session as a `code_update`, so the session's pattern, history and `get_code` follow what you play. A status pill shows the connection ("Waiting for your agent" until the first command arrives) and links to the source of DJ Opus and of the Strudel build (AGPL-3.0).

```
AI Agent (Claude, Ollama, etc.)
        | MCP over HTTP (/mcp)
        v
Cloudflare Worker
        |
   Durable Objects
   [one per MCP session, one per DJ Opus session (SessionBridge, SQLite)]
        | WebSocket (/ws?session=<id>, browser only)
        v
Browser (Strudel REPL -> Web Audio API -> speakers)
```

## Why Cloudflare Workers?

DJ Opus runs on Cloudflare's **Workers Free plan**. Its limits are daily and reset at 00:00 UTC; past one of them, further operations of that kind fail until the reset:

| Resource | Workers Free limit | DJ Opus usage |
|----------|--------------------|---------------|
| Worker requests | 100,000/day | The API, `/mcp` and the socket upgrades; the player's pages and files are static assets |
| Durable Object requests | 100,000/day | MCP tool calls and socket connects; incoming WebSocket messages count 1 in 20 |
| Durable Object duration | 13,000 GB-s/day | Sessions in use; an idle session with open sockets hibernates |
| Durable Object SQLite rows written | 100,000/day | Pattern, history and crate saves |
| Durable Object SQLite rows read | 5 million/day | Loading a session |
| Durable Object stored data | 5 GB (total) | Pattern history and crates (~KB each) |
| Static assets | 20,000 files per version, 25 MiB each | The Strudel REPL |

Limits are from Cloudflare's [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers](https://developers.cloudflare.com/workers/platform/limits/) documentation, which is the place to check them.

Benefits:
- **No hosting fees on the Free plan** — no VMs, no containers; past a daily limit, operations fail until the reset rather than being billed
- **Global edge deployment** — low latency WebSocket from anywhere
- **Durable Objects** — stateful sessions with built-in persistence
- **Custom domains** — bring your own domain with automatic TLS

## MCP Tools (23)

### Session Pairing

The first tool call that needs a player starts a DJ Opus session and fails with a message that names its player URL, `https://<host>/s/<id>` (the id is 26 characters); `get_state` returns the URL as `playerUrl`. Open it, click once to unlock audio, and run the tool again. If you opened a player first, tell the agent its id and it calls `connect` to bind to it. A session, with its crate, is deleted after 30 days without activity.

| Category | Tool | Description |
|----------|------|-------------|
| **Playback** | `write` | Write pattern to editor, optionally play |
| | `play` | Evaluate and play current editor code |
| | `stop` | Stop playback |
| | `set_tempo` | Change BPM in real-time without rewriting pattern |
| | `get_state` | Get session state (playing, clients, history, player URL) |
| | `recover_audio` | Resume a suspended or stuck audio context and replay |
| | `reset_session` | Stop and clear the editor and undo history; saved patterns are kept |
| **Editing** | `get_code` | Read current editor content from browser |
| | `append_code` | Append code to current pattern |
| | `replace_code` | Search/replace in current code |
| | `add_effect` | Append effect chain (room, delay, etc.) |
| **History** | `undo` | Undo last pattern change (up to 50 entries, persisted) |
| | `redo` | Redo previously undone change |
| **Storage** | `save` | Save current pattern to this session's crate |
| | `load` | Load a pattern from the crate or the library, optionally play |
| | `list` | List crate and library patterns (optional tag filter) |
| | `delete` | Delete a pattern from the crate |
| **Generation** | `generate_pattern` | Generate full multi-layer pattern |
| | `generate_drums` | Generate drum pattern by style |
| | `generate_bassline` | Generate bassline by key and style |
| **Validation** | `validate` | Check pattern syntax and safety |
| **Composite** | `compose` | One-shot: generate + write + play |
| **Session** | `connect` | Bind this connection to an open player by its session id |

Styles: techno, house, trance, dnb, ambient, trap, jungle, breakbeat, trip_hop, boom_bap, intelligent_dnb, experimental

### Saving patterns

The **crate** is private to a session and holds up to 50 patterns; it is deleted with the session. The **library** is the curated set from [`../patterns/`](../patterns/), read-only and the same for every session; `load` looks in the crate first and then the library. To keep a pattern beyond the session, write its code to a file in your project.

## Quick Start

### Prerequisites

- Node.js 22+
- A Cloudflare account (free tier works) with a zone (a domain on Cloudflare) for the app's custom domain
- `git` and `rsync` (the Strudel build uses them; it fetches `pnpm` itself)

### 1. Clone and install

```bash
git clone https://github.com/jmoore2333/djopus.git
cd djopus/cloudflare
npm ci
```

### 2. Build the Strudel REPL

```bash
npm run build:strudel
```

This clones Strudel (https://codeberg.org/uzu/strudel.git) into `.strudel-build/` at a pinned commit (`9f19e4616a358ad31032e0f9af82060d23bc0d70`), applies the patches in `patches/strudel/` (one loads the bridge script, one keeps the PWA service worker from answering `/api`, `/ws`, `/mcp` and `/widget`), builds it with a pinned pnpm, and puts the result in `static/` together with `client/strudel-ws-bridge.js`, `client/_headers` and `djopus-build.json`, a record of what was built. `npm run deploy` refuses a `static/` that this script did not finish.

Each install in this build prints a warning about the ignored build script of the upstream `@serialport/bindings-cpp` dependency. That is expected; the player does not use it.

### 3. Configure Cloudflare

```bash
npx wrangler login
```

In `wrangler.toml`, change the `[[routes]]` `pattern` to your hostname, on a zone in your account. It is a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/): the deploy creates its DNS record and certificate, and the hostname must not already have a CNAME record. The app has no `workers.dev` URL (`workers_dev = false`). There is no D1 database to create. The two `[[ratelimits]]` bindings need a `namespace_id` that is unique in your account: change the numbers if another Worker there uses them.

No secret is required. The logs carry a keyed hash of the session id, never the id; `npx wrangler secret put LOG_HASH_KEY` sets the key, so that a session hashes the same way in every isolate (unset, each isolate picks a random one).

If you change the player (the patches, the Strudel commit or `client/strudel-ws-bridge.js`) and deploy it, point its "Source" link (`SOURCE_LINKS` in the bridge script) at your own copy of the source: see [NOTICE](../NOTICE).

### 4. Deploy

```bash
npm run deploy
```

### 5. Register the MCP

With Claude Code (run it in a terminal, not inside a Claude session):
```bash
claude mcp add --transport http djopus https://your-domain.com/mcp
```

`--scope` is `local` (the default), `project` (writes `.mcp.json`) or `user`. Or in the config of any client that takes JSON:
```json
{
  "mcpServers": {
    "djopus": { "type": "http", "url": "https://your-domain.com/mcp" }
  }
}
```

`type` is required: an entry with a `url` and no `type` is read as stdio. Check the connection with `claude mcp list`.

For a client without HTTP MCP, register the stdio proxy instead:
```bash
cd mcp && npm install
claude mcp add --transport stdio \
  -e DJOPUS_URL=https://your-domain.com \
  -s user \
  djopus -- "$PWD/node_modules/.bin/tsx" "$PWD/src/index.ts"
```

### 6. Use it

1. Ask your AI to `compose techno at 130 BPM in D minor`
2. Its answer names the player URL, `https://your-domain.com/s/<id>`: open it
3. Click once to unlock the Web Audio context. The status pill leaves "Waiting for your agent" when the first command arrives

Or open `https://your-domain.com` first (it starts a session and moves to `/s/<id>`) and tell the agent to connect to that id.

## Development

```bash
npm run dev          # wrangler dev; static/ must be built first
npm test             # the Worker and unit suites (and the ChatGPT Worker's, where its code is present)
npm run sync:static  # copy client/strudel-ws-bridge.js and client/_headers into static/
npm run build:strudel
```

`npm run dev` and `wrangler dev` need `static/` (from `npm run build:strudel`). A local `wrangler dev` of the app serves the player at `http://localhost:8787/s/<id>` and the MCP at `http://localhost:8787/mcp`; the stdio proxy and the smoke script take it as `DJOPUS_URL` or as their argument.

## Project Structure

```
cloudflare/
├── wrangler.toml                 # Workers config (Durable Objects w/ SQLite, assets, rate limits, custom domain)
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Worker entry: /mcp, WS upgrade, API, asset serving
│   ├── session-bridge.ts         # Durable Object: WS relay, undo/redo, crate, SQLite persistence, expiry
│   ├── remote-mcp/               # /mcp: the McpAgent Durable Object, its guards and tool registration
│   ├── core/                     # The tool registry (tools.ts), executor, crate store, library, session ids
│   ├── routes/                   # WS upgrade rules, REST API, asset serving, rate limiting
│   ├── protocol.ts               # WebSocket message types (request_id correlation)
│   ├── limits.ts                 # Size limits
│   ├── log.ts                    # Structured log events
│   └── services/
│       ├── MusicTheory.ts        # Scales, chords, euclidean rhythms
│       ├── PatternGenerator.ts   # Genre-based pattern generation
│       └── PatternValidator.ts   # Pattern validation against src/core/strudel-names.generated.json
├── client/
│   ├── strudel-ws-bridge.js      # Browser-side WebSocket client (the canonical copy)
│   └── _headers                  # Referrer-Policy for the static assets
├── patches/                      # LICENSE (AGPL-3.0-or-later) and strudel/, the patches applied to the pinned Strudel build
├── scripts/                      # build-strudel.sh, build-library.mjs, check-static.mjs, ensure-static.mjs
├── mcp/                          # stdio-to-HTTP proxy for clients without HTTP MCP
│   ├── package.json
│   └── src/
│       ├── index.ts              # Proxy entry (stdio transport, DJOPUS_URL)
│       ├── proxy.ts              # Forwards tools/list and tools/call to <DJOPUS_URL>/mcp
│       └── tools.ts              # Re-exports the tool registry of src/core/tools.ts
├── test/                         # Worker (test/worker) and unit (test/unit) suites
└── static/                       # Built Strudel REPL (not committed; npm run build:strudel makes it)

`npm run build:strudel` also regenerates `src/core/strudel-names.generated.json`, the list of function names the pinned Strudel build defines; the validator refuses a pattern that calls a name not in it (and `.gain()` above 5) before it reaches the player. `npm run check:names` verifies the committed list against the clone in `.strudel-build/`.
```

## Browser WebSocket Protocol

The socket is for the player page alone: `wss://your-domain.com/ws?session=<id>`, where `<id>` is the 26-character session id of the player URL. The upgrade must come from a page of the host itself (the `Origin` has to be the host's), and `role=controller` is refused with a 403. Agents do not connect here: they use `/mcp`.

The Durable Object sends the page commands, and the page answers with `request_id` correlation:

```json
{"type":"evaluate","request_id":"uuid","payload":{"code":"s(\"bd*4\")"}}
{"type":"stop","request_id":"uuid"}
{"type":"set_code","request_id":"uuid","payload":{"code":"..."}}
{"type":"set_tempo","request_id":"uuid","payload":{"bpm":138}}
{"type":"get_code","request_id":"uuid"}
{"type":"append_code","request_id":"uuid","payload":{"code":"..."}}
{"type":"replace_code","request_id":"uuid","payload":{"search":"...","replace":"..."}}
{"type":"add_effect","request_id":"uuid","payload":{"effect":"room","params":{"0":0.5}}}
{"type":"recover_audio","request_id":"uuid"}
{"type":"reset_session","request_id":"uuid"}
```

### From the page

```json
{"type":"ack","request_id":"uuid","status":"playing"}
{"type":"ack","request_id":"uuid","status":"stopped"}
{"type":"code_response","request_id":"uuid","payload":{"code":"..."}}
{"type":"status_report","payload":{"isPlaying":true,"bpm":138,"codeLength":245,"hasErrors":false,"errorMessage":null}}
{"type":"error","request_id":"uuid","payload":{"message":"..."}}
{"type":"code_update","payload":{"code":"..."}}
```

`code_update` is sent unasked when you run the editor's code by hand (Ctrl+Enter or the play button) and it runs without an error: the session takes that text as its current pattern and counts itself as playing.

### From the session

```json
{"type":"session_state","payload":{"currentPattern":"...","isPlaying":false,"rev":3,"historySize":5}}
```

`session_state` goes to every page that connects, with the session's pattern, so a reload or a second tab picks up where the session is.

## REST API

```
GET    /api/health
POST   /api/generate/pattern      # { style, bpm?, key? }
POST   /api/generate/drums        # { style, complexity? }
POST   /api/generate/bassline     # { key, style }
POST   /api/generate/scale        # { root, scale }
POST   /api/generate/chords       # { key, style }
POST   /api/validate              # { pattern }
```

All responses include CORS headers. Saved patterns are not on the REST API: a session's saves are its crate, which the `save`, `load`, `list` and `delete` tools reach.

## Adapting for Other Models

`/mcp` is a standard remote [Model Context Protocol](https://modelcontextprotocol.io/) server. Any LLM that can call tools via MCP can drive DJ Opus:

**Cloud models:** Claude (via Claude Code), GPT-4 (via an MCP bridge), Gemini (via an MCP adapter)

**Local models:** Run a local model (Ollama, LM Studio, llama.cpp) with an MCP-compatible harness. The model calls `compose`, `write`, `set_tempo`, etc. — no cloud AI required for the music generation itself. A harness that only starts local processes can use the stdio proxy in `mcp/`.

**Fine-tuning opportunity:** The pattern generation services (`MusicTheory.ts`, `PatternGenerator.ts`) produce Strudel code strings. A model fine-tuned on Strudel patterns could bypass these services entirely and write patterns directly via the `write` tool, enabling more creative and genre-authentic output.

**Custom controllers:** An agent or app reaches a session through `/mcp`, so a mobile app, a hardware controller or a custom UI can be an MCP client of its own: connect to `/mcp`, `connect` to a player's session id, and call the tools.

## Pattern Code Tips

When writing Strudel patterns:
- Use `setcps(bpm/60/4)` for tempo (standard 4/4 time)
- No emoji in pattern code
- No `.mul()` / `.add()` on slider values
- `.vowel("<a e i o>")` on sawtooth is reliable for vocal textures
- GM voice instruments may not produce output — use synthesis
- See the [Strudel docs](https://strudel.cc/workshop/getting-started/) for the full pattern language

## License

[MIT](../LICENSE), except `patches/`, which is [AGPL-3.0-or-later](patches/LICENSE) like the Strudel code it changes. [NOTICE](../NOTICE) explains the split.

The Strudel REPL (built into `static/` by `npm run build:strudel`, not committed) is AGPL-3.0-or-later; its pinned commit, `patches/strudel/` and `scripts/build-strudel.sh` are the source of the player. The `MusicTheory.ts`, `PatternGenerator.ts`, and `PatternValidator.ts` services are ported from [strudel-mcp-server](https://github.com/williamzujkowski/strudel-mcp-server) (MIT, Copyright 2025 William Zujkowski).

## Credits

- [Strudel](https://strudel.cc) by Alex McLean and contributors (AGPL-3.0)
- [strudel-mcp-server](https://github.com/williamzujkowski/strudel-mcp-server) by William Zujkowski (MIT)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- Built by [moore.nyc](https://moore.nyc)
