import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROMPTS } from '../core/guide';
import { REFERENCES, referenceUri } from '../core/references';

/**
 * Registers on `server` what tells an agent how to DJ: the two mode prompts (src/core/guide.ts) and the DJ skill's
 * reference files as resources (src/core/references.ts). The server instructions go in the McpServer constructor
 * (src/remote-mcp/agent.ts). All of it is static: no session, no storage.
 */
export function registerGuide(server: McpServer): void {
  for (const prompt of PROMPTS) {
    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }],
    }));
  }
  for (const reference of REFERENCES) {
    const uri = referenceUri(reference.name);
    server.registerResource(
      reference.name,
      uri,
      { title: reference.name, description: reference.description, mimeType: reference.mimeType },
      () => ({ contents: [{ uri, mimeType: reference.mimeType, text: reference.text }] }),
    );
  }
}
