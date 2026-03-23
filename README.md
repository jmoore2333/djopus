# DJ Opus

AI-powered live-coding music platform built on Cloudflare Workers. Connect any AI agent to a browser-based synthesizer via WebSocket and make music in real time. This is a work in progress that works today - make it your own, or take a spin with DJ Opus.

DJ Opus bridges AI models and the [Strudel](https://strudel.cc) live-coding environment through the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), enabling AI-assisted composition, mixing, and live performance of electronic music - or whatever else you're into.

## What's Here

```
strudel/
├── cloudflare/           # The application (Worker + MCP server)
│   ├── src/              # Cloudflare Worker: WebSocket relay, REST API, pattern generation
│   ├── mcp/              # MCP server: 20 tools for AI-driven music control
│   ├── client/           # Browser WebSocket bridge script
│   └── drizzle/          # D1 database migrations
├── patterns/             # 16 curated example patterns from DJ sessions
├── skills/
│   └── dj-opus/          # Claude Code skill for live DJ workflows
└── reference-sample-banks.md  # Catalog of all Strudel sounds and instruments
```

## How It Works

```
AI Agent (Claude, GPT, Ollama, etc.)
        | MCP protocol (stdio)
        v
MCP Server (20 tools, local Node.js)
        | WebSocket + REST
        v
Cloudflare Worker (edge)
        |
   Durable Object (persistent sessions)
        | WebSocket
        v
Browser (Strudel REPL -> Web Audio -> speakers)
```

The AI sends commands (`compose`, `write`, `set_tempo`, `undo`) via MCP. The Worker relays them through a Durable Object to the browser, where Strudel synthesizes audio. Pattern history, undo/redo state, and saved patterns persist via Durable Object SQLite storage and D1.

See [`cloudflare/README.md`](cloudflare/README.md) for full architecture details, deployment guide, and API reference.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/jmoore/strudel.git
cd strudel/cloudflare

# 2. Install
npm install
cd mcp && npm install && cd ..

# 3. Build Strudel REPL (requires pnpm)
git clone https://codeberg.org/uzu/strudel.git ../source
cd ../source && pnpm install && pnpm run build
cp -r website/dist ../cloudflare/static
cp ../cloudflare/client/strudel-ws-bridge.js ../cloudflare/static/
cd ../cloudflare

# 4. Configure and deploy
wrangler login
wrangler d1 create djopus
# Update wrangler.toml with your D1 database ID and custom domain
wrangler d1 migrations apply djopus --remote
wrangler deploy

# 5. Register MCP with Claude Code (no session ID needed — auto-generated)
claude mcp add --transport stdio \
  -e DJOPUS_URL=https://your-domain.com \
  -s user \
  djopus -- npx tsx ./mcp/src/index.ts

# 6. Start Claude, call any DJ Opus tool — it gives you a URL to open
# 7. Open that URL in your browser, click play once, you're paired
```

## Example Patterns

The [`patterns/`](patterns/) directory contains 16 patterns from live DJ sessions:

| Pattern | Style | BPM | Description |
|---------|-------|-----|-------------|
| `4am-donato-dozzy` | Minimal/Hypnotic | 124 | Deep underwater techno with perlin filter drift |
| `megamix-v2-robert-miles` | Trance | 138 | Dreamy piano lead with 8-slider mega-mix |
| `galactic-euphoria-drop` | Epic Trance | 138 | Full euphoric drop with GM pads and reverb |
| `acid-303-bass` | Acid | 138 | Classic squelchy 303 with filter automation |
| `closing-set` | Ambient | 118 | No-kick wind-down with vowel filter pads |
| `progressive-groove` | Progressive House | 132 | Sasha/Digweed hypnotic groove |

## DJ Opus Skill

The [`skills/dj-opus/`](skills/dj-opus/) directory contains a Claude Code skill for live DJ performances. Two modes:

- **Megamix** — autonomous extended DJ sets with full arc design (intro, build, peak, wind-down)
- **Tag Team** — collaborative live coding where you and the AI build up, remix, and shape sound together

The skill encodes genre knowledge, pattern code best practices, and production techniques learned from live sessions.

## Session Pairing

DJ Opus uses auto-generated session IDs so multiple users can share the same deployment without interference.

**How it works:**
1. When the MCP starts, it generates a unique session code (e.g., `opus-7f3k`)
2. Your first tool call returns: *"Open this URL: https://your-domain.com?session=opus-7f3k"*
3. Open that link, click play — you're paired. No config needed.
4. Each new Claude Code conversation gets a fresh session automatically

**Reconnecting to an existing session:**
If you already have a browser tab open from a previous session, tell Claude *"connect to opus-7f3k"* (the code is in your browser's URL bar). The MCP switches its WebSocket to that session instantly — no new tab needed.

**Sharing a session:**
Multiple browsers can join the same session via the URL. All connected browsers hear the same music and see the same code changes in real time.

**Note:** Strudel saves its last session to localStorage. When joining a session via URL, there's a brief flash of the locally cached pattern before the WebSocket session state takes over (~1.5 seconds). This is by design to avoid modifying Strudel's core codebase.

## Compatibility

The MCP server uses standard stdio transport, making it compatible with:

- **Claude Code** and **Claude Desktop** (Anthropic)
- **Any MCP-compatible client** — [mcphost](https://github.com/nicholasgasior/mcphost), [mcp-cli](https://github.com/wong2/mcp-cli), custom integrations
- **Local models** — Ollama, LM Studio, llama.cpp with an MCP harness
- **Custom controllers** — any WebSocket client speaking the protocol can bypass MCP entirely

## Deploying Your Own Instance

After deploying to your own Cloudflare domain, update these references:

1. **MCP registration** — change `DJOPUS_URL` env var to your domain
2. **Skill** — update `skills/dj-opus/SKILL.md`: replace `djopus.moore.nyc` with your domain (7 occurrences in the description, architecture section, browser requirement rule, and troubleshooting)
3. **Durable Object** — `cloudflare/src/session-bridge.ts` has one domain reference in the "no browser" warning message
4. **wrangler.toml** — update the `[[routes]]` custom domain and your D1 `database_id`

```bash
# Quick find/replace across all files
grep -rl "djopus.moore.nyc" skills/ cloudflare/src/ cloudflare/mcp/ | \
  xargs sed -i '' 's/djopus\.moore\.nyc/your-domain.com/g'
```

## Runs Free on Cloudflare

The entire stack runs on Cloudflare's free tier: Workers, Durable Objects, D1, and static assets. No servers, no containers, no billing surprises. See [`cloudflare/README.md`](cloudflare/README.md) for the full free-tier breakdown.

## Credits

- **[Strudel](https://strudel.cc)** by Alex McLean and contributors — the live-coding pattern language (AGPL-3.0). DJ Opus serves a built copy of the Strudel REPL but does not include the source in this repository.
- **[strudel-mcp-server](https://github.com/williamzujkowski/strudel-mcp-server)** by William Zujkowski — the original Playwright-based MCP server (MIT). Music theory services were ported from this project.
- **[Cloudflare Workers](https://workers.cloudflare.com/)** — edge deployment platform
- **[Model Context Protocol](https://modelcontextprotocol.io/)** by Anthropic — the agent-tool communication standard
- **[TidalCycles](https://tidalcycles.org/)** — the Haskell live-coding language that Strudel is based on

## License

[MIT](LICENSE) — see LICENSE file for third-party notices.

The Strudel REPL (not included in this repo) is licensed under AGPL-3.0. You must clone and build it separately per the instructions above.

---

Built by [moore.nyc](https://moore.nyc)
