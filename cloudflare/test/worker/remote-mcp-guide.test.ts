import { exports } from 'cloudflare:workers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTRUCTIONS, PROMPTS } from '../../src/core/guide';
import { REFERENCES, referenceUri } from '../../src/core/references';
import { TOOL_NAMES } from '../../src/core/tools';

// What the generic MCP (/mcp) tells an agent beyond its tools: the server instructions, the two mode prompts and the
// reference resources (src/remote-mcp/guide.ts). An agent on any client gets the DJ skill this way, with the URL alone.

const MCP_URL = 'https://djopus.test/mcp';
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'guide-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (input, init) => exports.default.fetch(input, init) });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe('server instructions', () => {
  it('reach the client on initialize, and are the guide', async () => {
    const client = await connectClient();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it('name the player flow, the slider architecture, the refusals, the prompts and every resource', () => {
    for (const phrase of ['/s/<id>', 'connect', 'slider(', 'replace_code', 'setcps(bpm/60/4)', '.gain() above 5', '30 idle days', 'megamix', 'tag-team']) {
      expect(INSTRUCTIONS).toContain(phrase);
    }
    for (const reference of REFERENCES) expect(INSTRUCTIONS).toContain(referenceUri(reference.name));
  });

  it('name only tools that exist', () => {
    // Every snake_case word is a tool name, but for a tool parameter (auto_play) and the gm_* instrument prefix.
    const toolLike = INSTRUCTIONS.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    const notTools = new Set(['auto_play']);
    for (const name of toolLike) {
      if (notTools.has(name) || name.startsWith('gm_')) continue;
      expect(TOOL_NAMES, name).toContain(name);
    }
  });

  it('stay short enough to send with every initialize', () => {
    expect(new TextEncoder().encode(INSTRUCTIONS).length).toBeLessThan(6000);
  });
});

describe('prompts', () => {
  it('lists the two modes', async () => {
    const client = await connectClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['megamix', 'tag-team']);
    for (const prompt of prompts) {
      expect(prompt.description).toBeTruthy();
      expect(prompt.arguments ?? []).toEqual([]);
    }
  });

  it.each(PROMPTS.map((p) => [p.name, p] as const))('%s returns its one user message', async (name, def) => {
    const client = await connectClient();
    const result = await client.getPrompt({ name });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toEqual({ type: 'text', text: def.text });
    expect(def.text).toContain('player URL');
  });
});

describe('resources', () => {
  it('lists the reference files with their URIs and MIME types', async () => {
    const client = await connectClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(REFERENCES.map((r) => referenceUri(r.name)));
    for (const [resource, reference] of resources.map((r, i) => [r, REFERENCES[i]!] as const)) {
      expect(resource.name).toBe(reference.name);
      expect(resource.mimeType).toBe(reference.mimeType);
      expect(resource.description).toBe(reference.description);
    }
  });

  it.each(REFERENCES.map((r) => [r.name, r] as const))('%s reads back whole', async (name, reference) => {
    const client = await connectClient();
    const uri = referenceUri(name);
    const { contents } = await client.readResource({ uri });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri, mimeType: reference.mimeType, text: reference.text });
  });

  it('refuses a reference that does not exist', async () => {
    const client = await connectClient();
    await expect(client.readResource({ uri: referenceUri('no-such-reference') })).rejects.toThrow(/not found|unknown|Resource/i);
  });
});
