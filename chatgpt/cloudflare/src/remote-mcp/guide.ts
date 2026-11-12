import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROMPTS } from '../core/guide';
import { REFERENCES, referenceUri } from '../core/references';
import { CHATGPT_PROMPTS } from './chatgpt-guide';

/**
 * Registers the mode prompts and DJ skill reference resources. ChatGPT receives inline-player prompts while generic
 * clients retain the standard prompts. The server instructions are chosen in the McpServer constructor (agent.ts).
 * All guidance is static: no session, no storage.
 */
export function registerGuide(server: McpServer, chatgpt = false): void {
  for (const prompt of chatgpt ? CHATGPT_PROMPTS : PROMPTS) {
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
