import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// The one tool registry: names, input schemas, descriptions and annotations of the DJ Opus tools. Every MCP surface
// registers from it (the ChatGPT one layers its own descriptions and openDJOpus on top), and getTools() is the
// canonical list that cloudflare/mcp/src/tools.ts exports for the eval harness.
//
// The stdio package compiles this file with no Workers types, so it imports nothing from the Worker. The limits
// below are the ones of src/limits.ts (test/worker/core/tools.test.ts checks that they match). zod counts characters,
// so code is limited here to as many characters as src/limits.ts allows bytes, and the executor still counts its
// bytes with checkCode.
const MAX_CODE_BYTES = 65_536;
const MAX_NAME_CHARS = 128;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 32;

export const TOOL_NAMES = ['write', 'play', 'stop', 'set_tempo', 'get_state', 'recover_audio', 'reset_session', 'get_code',
  'append_code', 'replace_code', 'add_effect', 'undo', 'redo', 'save', 'load', 'list', 'delete', 'generate_pattern',
  'generate_drums', 'generate_bassline', 'validate', 'compose', 'connect'] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDef {
  name: ToolName;
  description: string;
  input: z.ZodRawShape;
  annotations: ToolAnnotations;
}

const code = (description: string) => z.string().max(MAX_CODE_BYTES).describe(description);
const patternName = (description: string) => z.string().max(MAX_NAME_CHARS).describe(description);

// Changes the session (its code, its playback or its saves), and nothing outside it.
const CHANGES_SESSION: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

export const TOOL_DEFS: readonly ToolDef[] = [
  // --- playback ---
  {
    name: 'write',
    description: 'Write a Strudel pattern to the editor and optionally start playback',
    input: {
      pattern: code('Strudel pattern code'),
      auto_play: z.boolean().optional().describe('Start playback immediately (default: false)'),
    },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'play',
    description: 'Evaluate and play the current editor code',
    input: {},
    annotations: CHANGES_SESSION,
  },
  {
    name: 'stop',
    description: 'Stop playback',
    input: {},
    annotations: CHANGES_SESSION,
  },
  {
    name: 'set_tempo',
    description: 'Change BPM without rewriting the pattern. Changes tempo in real-time.',
    input: { bpm: z.number().describe('Tempo in beats per minute') },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'get_state',
    description: 'Get current session state: playing status, connected clients, pattern history info',
    input: {},
    annotations: READ_ONLY,
  },
  {
    name: 'recover_audio',
    description: 'Use this when the user says they hear nothing, playback seems stuck, or pressing play did not work. It checks the browser\'s audio state, tries to resume audio, and replays the current pattern when it can. If the browser still needs a user gesture, keep the reply short and ask the user to click once in the player to unlock audio.',
    input: {},
    annotations: CHANGES_SESSION,
  },
  {
    name: 'reset_session',
    description: 'Use this when the user explicitly wants to clear the current DJ Opus session and start fresh, or the player feels wedged and needs a clean reset. It stops playback and clears the editor and the undo history of this session only; saved patterns are kept.',
    input: {},
    annotations: CHANGES_SESSION,
  },

  // --- editing ---
  {
    name: 'get_code',
    description: 'Read the current editor content from the browser',
    input: {},
    annotations: READ_ONLY,
  },
  {
    name: 'append_code',
    description: 'Append code to the current pattern in the editor',
    input: { code: code('Code to append') },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'replace_code',
    description: 'Search and replace text in the current pattern',
    input: { search: code('Text to find'), replace: code('Replacement text') },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'add_effect',
    description: 'Append an effect chain to the current pattern (e.g., room, delay, cutoff)',
    input: {
      effect: z.string().describe('Effect name (room, delay, cutoff, etc.)'),
      params: z.record(z.string(), z.unknown()).optional().describe('Effect parameters as key-value pairs'),
    },
    annotations: CHANGES_SESSION,
  },

  // --- history ---
  {
    name: 'undo',
    description: 'Undo the last pattern change',
    input: {},
    annotations: CHANGES_SESSION,
  },
  {
    name: 'redo',
    description: 'Redo a previously undone pattern change',
    input: {},
    annotations: CHANGES_SESSION,
  },

  // --- storage ---
  // The texts of the generic MCP, whose saves are the session's crate plus the library (src/core/crate-store.ts).
  // ChatGPT still saves to its D1 table and keeps its own texts (CHATGPT_DESCRIPTIONS in src/chatgpt/tools.ts).
  {
    name: 'save',
    description: 'Save the current pattern under a name in this session\'s crate (saving a name again replaces it). The crate is private to this DJ Opus session, holds up to 50 patterns, and is deleted after 30 days without activity. To keep a pattern for good, also write its code to a file in the user\'s project.',
    input: {
      name: patternName('Pattern name'),
      tags: z.array(z.string().max(MAX_TAG_CHARS)).max(MAX_TAGS).optional().describe('Tags for categorization'),
    },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'load',
    description: 'Load a pattern by name into the editor, from this session\'s crate or else from the read-only library of curated patterns, and optionally play it',
    input: {
      name: patternName('Pattern name to load'),
      auto_play: z.boolean().optional().describe('Start playback after loading (default: false)'),
    },
    annotations: CHANGES_SESSION,
  },
  {
    name: 'list',
    description: 'List the patterns load can open, optionally filtered by tag: this session\'s crate (private, up to 50 patterns, deleted after 30 idle days) and the read-only library of curated patterns',
    input: { tag: z.string().max(MAX_TAG_CHARS).optional().describe('Filter by tag') },
    annotations: READ_ONLY,
  },
  {
    name: 'delete',
    description: 'Delete a pattern from this session\'s crate. Library patterns are read-only.',
    input: { name: patternName('Pattern name to delete') },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  },

  // --- generation ---
  {
    name: 'generate_pattern',
    description: 'Generate a complete multi-layer pattern for a given style',
    input: {
      style: z.string().describe('Style: techno, house, trance, dnb, ambient, trip_hop, boom_bap, intelligent_dnb, etc.'),
      bpm: z.number().optional().describe('Tempo in BPM'),
      key: z.string().optional().describe('Musical key (C, D, A, etc.)'),
    },
    annotations: READ_ONLY,
  },
  {
    name: 'generate_drums',
    description: 'Generate a drum pattern for a given style',
    input: {
      style: z.string().describe('Drum style'),
      complexity: z.number().optional().describe('Complexity 0-1 (default: 0.7)'),
    },
    annotations: READ_ONLY,
  },
  {
    name: 'generate_bassline',
    description: 'Generate a bassline for a given key and style',
    input: {
      key: z.string().describe('Musical key'),
      style: z.string().describe('Bass style'),
    },
    annotations: READ_ONLY,
  },

  // --- validation ---
  {
    name: 'validate',
    description: 'Validate a pattern for syntax errors and safety issues',
    input: { pattern: code('Pattern code to validate') },
    annotations: READ_ONLY,
  },

  // --- composite ---
  {
    name: 'compose',
    description: 'One-shot: generate a pattern and immediately play it. The fastest way to get music going.',
    input: {
      style: z.string().describe('Style: techno, house, trance, dnb, ambient, trip_hop, boom_bap, etc.'),
      bpm: z.number().optional().describe('Tempo in BPM'),
      key: z.string().optional().describe('Musical key'),
    },
    annotations: CHANGES_SESSION,
  },

  // --- session ---
  {
    name: 'connect',
    description: 'Bind this connection to a DJ Opus player that is already open, by its session id: the 26 characters after /s/ in the player URL (https://<host>/s/<id>). Use it when the user opened the player first, or when the open tab is on a different session than this connection, for example after a restart.',
    input: { session: z.string().describe('Session id: the 26 characters after /s/ in the player URL') },
    annotations: CHANGES_SESSION,
  },
];

/**
 * The tools with their input schemas as JSON Schema: the same schemas an MCP server built from TOOL_DEFS advertises
 * (the SDK converts a zod shape the same way), so a client that reads this list sees what the server checks.
 */
export function getTools(): Array<{ name: ToolName; description: string; inputSchema: Record<string, unknown> }> {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(z.object(def.input), { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
  }));
}
