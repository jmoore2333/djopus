import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProxy } from './proxy.js';

// The stdio server for agents that cannot take a URL: the tools are the ones of the DJ Opus MCP server at <DJOPUS_URL>/mcp.
// DJOPUS_URL points at another host, such as a self-hosted one or a local `wrangler dev`; empty counts as not set.
const proxy = await createProxy({
  remoteUrl: process.env.DJOPUS_URL || 'https://play.djopus.party',
  local: new StdioServerTransport(),
});

// The agent that started this process is gone once its end of stdin closes, and nothing else would end the process: the
// open connection to the remote keeps it alive. So let go of the remote and exit. The exit waits for what is already
// written to stdout, because a write to a pipe is asynchronous and a response on its way out would be cut off by
// process.exit().
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  proxy
    .close()
    .catch(() => {}) // on the way out either way
    .then(() => process.stdout.write('', () => process.exit(0)));
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
