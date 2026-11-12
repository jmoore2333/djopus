# DJ Opus for ChatGPT

This directory contains the ChatGPT-specific DJ Opus player, Worker, and plugin
package. It is separate from the standard DJ Opus implementation at the root
of this repository. The `plugin/` directory contains the ChatGPT skill and its
reference material, listing metadata, and MCP configuration.

The app is being prepared for submission to OpenAI for review and approval and
is not yet publicly listed. This source is provided as a reference for the
ChatGPT version.

The stable submission endpoint is `https://chatgpt.djopus.party/mcp`; the
isolated development endpoint is `https://chatgpt-dev.djopus.party/mcp`. Their
sessions and saved patterns are independent. See
[`cloudflare/CHATGPT-APP.md`](cloudflare/CHATGPT-APP.md) for connection and
testing instructions.

## Build the player and Worker

From `cloudflare/`, with Node.js, Git, and rsync installed:

```sh
npm ci
npm run build:strudel
npm run predeploy:chatgpt
npx wrangler deploy --config wrangler.chatgpt.toml --dry-run
npx vitest run -c vitest.unit.config.ts test/unit/chatgpt-audio.test.ts test/unit/chatgpt-widget-bridge.test.ts
```

The Strudel build script checks out the upstream revision pinned in the script,
applies the patches in `cloudflare/patches/strudel/`, installs the pinned pnpm
and lockfile dependencies, and builds the player. The ChatGPT predeploy step
then installs `cloudflare/client/strudel-ws-bridge-chatgpt.js` into the player
assets. The build replaces the script's own `.strudel-build/` and `static/`
directories; do not keep unrelated files in them. The dry run does not deploy.

This snapshot supplies the files needed to build the player and the unified
Worker. Some package scripts concern legacy workers and tests that are not part
of this snapshot. The included stable Wrangler configuration omits the domain
verification token and must be adapted for any actual deployment. Do not use
the stable endpoint for routine development.

## Licensing

See [`NOTICE`](NOTICE), [`LICENSE`](LICENSE), and
[`cloudflare/patches/LICENSE`](cloudflare/patches/LICENSE). The modified Strudel
player uses upstream Strudel, which is AGPL-3.0-or-later; the pinned upstream
revision and the patches needed to build it are identified in the build script.
