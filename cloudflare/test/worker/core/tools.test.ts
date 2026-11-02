import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it } from 'vitest';
import { getTools, TOOL_DEFS, TOOL_NAMES } from '../../../src/core/tools';
import { MAX_CODE_BYTES, MAX_NAME_CHARS, MAX_TAG_CHARS, MAX_TAGS } from '../../../src/limits';

// The one tool registry (src/core/tools.ts). getTools() is also what cloudflare/mcp/src/tools.ts exports for the
// eval harness, so its schemas have to be the ones an MCP server built from the registry advertises.

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema & { description?: string }>;
  required?: string[];
  items?: JsonSchema;
  maxLength?: number;
  maxItems?: number;
};

function schemaOf(name: string): JsonSchema {
  const tool = getTools().find((t) => t.name === name);
  if (!tool) throw new Error(`getTools() has no ${name}`);
  return tool.inputSchema as JsonSchema;
}

it('registry has exactly the 23 tools', () => {
  expect([...TOOL_NAMES]).toEqual([
    'write', 'play', 'stop', 'set_tempo', 'get_state', 'recover_audio', 'reset_session', 'get_code',
    'append_code', 'replace_code', 'add_effect', 'undo', 'redo', 'save', 'load', 'list', 'delete', 'generate_pattern',
    'generate_drums', 'generate_bassline', 'validate', 'compose', 'connect',
  ]);
  expect(TOOL_DEFS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  expect(getTools().map((t) => t.name)).toEqual([...TOOL_NAMES]);
});

it('getTools matches what an McpServer built from the registry advertises', async () => {
  const server = new McpServer({ name: 'registry', version: '0.0.0' });
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input, annotations: def.annotations },
      async () => ({ content: [] }),
    );
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'registry-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => [t.name, t.description, t.inputSchema]))
      .toEqual(getTools().map((t) => [t.name, t.description, t.inputSchema]));
  } finally {
    await client.close();
  }
});

it('schemas carry the limits', () => {
  // zod counts characters, so these are character limits; the executor still counts the bytes of code (checkCode).
  expect(MAX_CODE_BYTES).toBe(65_536);
  expect(schemaOf('write').properties?.pattern.maxLength).toBe(MAX_CODE_BYTES);
  expect(schemaOf('validate').properties?.pattern.maxLength).toBe(MAX_CODE_BYTES);
  expect(schemaOf('append_code').properties?.code.maxLength).toBe(MAX_CODE_BYTES);
  expect(schemaOf('replace_code').properties?.search.maxLength).toBe(MAX_CODE_BYTES);
  expect(schemaOf('replace_code').properties?.replace.maxLength).toBe(MAX_CODE_BYTES);

  for (const name of ['save', 'load', 'delete']) {
    expect(schemaOf(name).properties?.name.maxLength, name).toBe(MAX_NAME_CHARS);
  }
  expect(MAX_NAME_CHARS).toBe(128);
  expect(schemaOf('save').properties?.tags).toMatchObject({
    type: 'array', maxItems: MAX_TAGS, items: { type: 'string', maxLength: MAX_TAG_CHARS },
  });
  expect([MAX_TAGS, MAX_TAG_CHARS]).toEqual([10, 32]);
  expect(schemaOf('list').properties?.tag.maxLength).toBe(MAX_TAG_CHARS); // a tag filter is a tag
});

it('keeps the inputs of the stdio list: the same properties, types and required fields, each described', () => {
  // Hand-copied from cloudflare/mcp/src/tools.ts as it was before the registry, plus the two tools it lacked.
  const stdio: Record<string, [properties: Record<string, string>, required: string[]]> = {
    write: [{ pattern: 'string', auto_play: 'boolean' }, ['pattern']],
    play: [{}, []],
    stop: [{}, []],
    set_tempo: [{ bpm: 'number' }, ['bpm']],
    get_state: [{}, []],
    recover_audio: [{}, []],
    reset_session: [{}, []],
    get_code: [{}, []],
    append_code: [{ code: 'string' }, ['code']],
    replace_code: [{ search: 'string', replace: 'string' }, ['search', 'replace']],
    add_effect: [{ effect: 'string', params: 'object' }, ['effect']],
    undo: [{}, []],
    redo: [{}, []],
    save: [{ name: 'string', tags: 'array' }, ['name']],
    load: [{ name: 'string', auto_play: 'boolean' }, ['name']],
    list: [{ tag: 'string' }, []],
    delete: [{ name: 'string' }, ['name']],
    generate_pattern: [{ style: 'string', bpm: 'number', key: 'string' }, ['style']],
    generate_drums: [{ style: 'string', complexity: 'number' }, ['style']],
    generate_bassline: [{ key: 'string', style: 'string' }, ['key', 'style']],
    validate: [{ pattern: 'string' }, ['pattern']],
    compose: [{ style: 'string', bpm: 'number', key: 'string' }, ['style']],
    connect: [{ session: 'string' }, ['session']],
  };
  expect(getTools().map((t) => t.name)).toEqual(Object.keys(stdio));
  for (const tool of getTools()) {
    const schema = tool.inputSchema as JsonSchema;
    const [properties, required] = stdio[tool.name];
    expect(schema.type, tool.name).toBe('object');
    const types = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, value.type]));
    expect(types, tool.name).toEqual(properties);
    expect(schema.required ?? [], tool.name).toEqual(required);
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      expect(value.description, `${tool.name}.${key}`).toMatch(/\S/);
    }
  }
});

const descriptionOf = (name: string) => TOOL_DEFS.find((def) => def.name === name)!.description;

it('describes the storage tools as the session crate and the read-only library, and says how to keep a pattern', () => {
  // The registry's texts are those of the generic MCP, whose saves are the crate (src/core/crate-store.ts). ChatGPT,
  // which still saves to D1, keeps its own (test/chatgpt/tools.test.ts).
  for (const name of ['save', 'load', 'list', 'delete']) {
    expect(descriptionOf(name), name).toMatch(/crate/);
    expect(descriptionOf(name), name).not.toMatch(/database/i);
  }
  const save = descriptionOf('save');
  for (const fact of [/private/, /50/, /30 days/, /file in the user's project/]) expect(save).toMatch(fact);
  expect(descriptionOf('list')).toMatch(/50/);
  expect(descriptionOf('list')).toMatch(/30 idle days/);
  for (const name of ['load', 'list']) expect(descriptionOf(name), name).toMatch(/read-only library/);
  expect(descriptionOf('delete')).toMatch(/Library patterns are read-only/);
});

it('describes connect with the 26-character id of the player URL, and no legacy example', () => {
  const connect = getTools().find((tool) => tool.name === 'connect')!;
  expect(`${connect.description} ${JSON.stringify(connect.inputSchema)}`).not.toMatch(/opus-|e\.g\./);
  expect(connect.description).toContain('https://<host>/s/<id>');
  expect(connect.description).toMatch(/26 characters/);
  expect((connect.inputSchema as JsonSchema).properties?.session.description).toMatch(/26 characters after \/s\//);
});

it('describes every tool without sending the agent to openDJOpus, which only ChatGPT has', () => {
  for (const def of TOOL_DEFS) {
    expect(def.description, def.name).toMatch(/\S/);
    expect(def.description, def.name).not.toMatch(/openDJOpus/);
  }
});
