import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'crypto';
import { WorkerClient } from './WorkerClient.js';
import { getTools } from './tools.js';

function generateSessionId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(4);
  return 'opus-' + Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

const WORKER_URL = process.env.DJOPUS_URL || 'https://djopus.moore.nyc';
const SESSION_ID = process.env.DJOPUS_SESSION || generateSessionId();
const SESSION_URL = `${WORKER_URL}?session=${SESSION_ID}`;

let client = new WorkerClient(WORKER_URL, SESSION_ID);
let hasSentPairingHint = false;

const server = new Server(
  { name: 'djopus', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Handle connect tool before requiring an active connection
  if (name === 'connect') {
    const newSession = args?.session as string;
    if (!newSession) {
      return { content: [{ type: 'text' as const, text: 'Error: session ID is required' }], isError: true };
    }
    client.disconnect();
    client = new WorkerClient(WORKER_URL, newSession);
    await client.connect();
    hasSentPairingHint = false;
    return {
      content: [{
        type: 'text' as const,
        text: `Connected to session: ${newSession}\nBrowser URL: ${WORKER_URL}?session=${newSession}`,
      }],
    };
  }

  // Lazy connect
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Connection failed: ${(err as Error).message}\n\nOpen this URL in your browser: ${SESSION_URL}`,
        }],
      };
    }
  }

  try {
    const result = await executeTool(name, args || {});
    let text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    // On first tool call, check if a browser is connected. If not, include the pairing URL.
    if (!hasSentPairingHint) {
      hasSentPairingHint = true;
      try {
        const state = await client.getState();
        if (state.connectedClients === 0) {
          text = `No browser connected. Open this URL to start:\n${SESSION_URL}\nThen click play once to unlock audio.\n\n${text}`;
        }
      } catch {
        // State check failed, include hint anyway
        text = `Session: ${SESSION_ID}\nBrowser URL: ${SESSION_URL}\n\n${text}`;
      }
    }

    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error: ${(err as Error).message}`,
      }],
      isError: true,
    };
  }
});

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'write': {
      const code = args.pattern as string;
      if (args.auto_play) {
        await client.evaluate(code);
        return { status: 'playing', length: code.length };
      } else {
        await client.setCode(code);
        return { status: 'written', length: code.length };
      }
    }

    case 'play': {
      const code = await client.getCode();
      await client.evaluate(code);
      return { status: 'playing', length: code.length };
    }

    case 'stop':
      await client.stop();
      return { status: 'stopped' };

    case 'set_tempo':
      await client.setTempo(args.bpm as number);
      return { status: 'tempo_set', bpm: args.bpm };

    case 'get_state':
      return await client.getState();

    case 'get_code':
      return { code: await client.getCode() };

    case 'append_code':
      await client.appendCode(args.code as string);
      return { status: 'appended' };

    case 'replace_code':
      await client.replaceCode(args.search as string, args.replace as string);
      return { status: 'replaced' };

    case 'add_effect':
      await client.addEffect(args.effect as string, args.params as Record<string, number>);
      return { status: 'effect_added', effect: args.effect };

    case 'undo':
      return await client.undo();

    case 'redo':
      return await client.redo();

    case 'save': {
      const code = await client.getCode();
      return await client.savePattern(args.name as string, code, args.tags as string[]);
    }

    case 'load': {
      const pattern = await client.loadPattern(args.name as string);
      if (args.auto_play) {
        await client.evaluate(pattern.content);
      } else {
        await client.setCode(pattern.content);
      }
      return { loaded: args.name, length: pattern.content.length };
    }

    case 'list':
      return await client.listPatterns(args.tag as string);

    case 'generate_pattern':
      return { pattern: await client.generatePattern(args.style as string, args.bpm as number, args.key as string) };

    case 'generate_drums':
      return { pattern: await client.generateDrums(args.style as string, args.complexity as number) };

    case 'generate_bassline':
      return { pattern: await client.generateBassline(args.key as string, args.style as string) };

    case 'validate':
      return await client.validatePattern(args.pattern as string);

    case 'delete':
      return await client.deletePattern(args.name as string);

    case 'compose': {
      const pattern = await client.generatePattern(args.style as string, args.bpm as number, args.key as string);
      await client.evaluate(pattern);
      return { status: 'playing', pattern };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
