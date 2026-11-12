# Test DJ Opus in ChatGPT

The stable endpoint associated with the OpenAI submission is
`https://chatgpt.djopus.party/mcp`. The separate development endpoint is
`https://chatgpt-dev.djopus.party/mcp`. Each runs its own Worker and Durable
Objects, so their sessions and crates are independent of each other and of
`play.djopus.party`. The app is not yet publicly listed.

Use the development endpoint for experiments. Changes to the stable Worker
affect the submission and may reach reviewers or, after publication, users.
Do not use a local tunnel for this setup.

Both ChatGPT endpoints are accountless. A player session ID acts as a
capability: anyone who obtains it can access and control that session.
ChatGPT conversation metadata associates calls across connections, but a
client that knows a conversation ID can impersonate it; the metadata is not
proof of identity. Keep session IDs and conversation metadata private and use
disposable data for tests.

Calls carrying the same `openai/session` metadata are associated with one
random player session even if ChatGPT reconnects its MCP transport. Without
that metadata, the Worker uses the MCP transport's own session binding. The
`connect` tool can explicitly bind a conversation to an existing player.

## Connect and test in ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins). Depending on the account
   and interface version, enable Developer Mode in Settings → Apps → Advanced
   settings. Workspace policies may restrict custom MCP servers.
2. Select **Add → Add custom MCP server**, enter
   `https://chatgpt-dev.djopus.party/mcp`, and choose **No authentication**.
   Acknowledge the warning and connect the private test app. Review its tools.
3. Start a new chat and select the development app. Ask it to open DJ Opus and
   make a beat. Use **Enable audio** or **Play** inside the player if prompted.
4. Test an edit, a tempo change, save and load, and stop. Confirm actual sound
   through the speakers; a successful tool response or simulated browser alone
   does not establish audible playback.

After changing tool descriptors, authentication, or UI resources, deploy to
the development Worker, refresh its tools in ChatGPT settings, and start a new
chat. Version widget resource URIs when a UI change could leave a cached
component. See OpenAI's [connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

The development Worker's configuration is `wrangler.chatgpt-dev.toml`. Before
deploying, check that the source link points to the public GitHub tag containing
the matching reviewed source. The proposed v3 link must not be deployed until
that tag is published. Test changes in the isolated development Worker before
deploying to the stable endpoint.

For local checks, run the unit and integration tests in `cloudflare/`. A local
Wrangler Worker can also be used for loopback-only tests; its Durable Object
state remains separate from the hosted Workers. Do not add `--remote` or use
production bindings for local tests.
