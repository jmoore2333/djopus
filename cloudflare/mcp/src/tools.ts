export function getTools() {
  return [
    // Core Playback
    {
      name: 'write',
      description: 'Write a Strudel pattern to the editor and optionally start playback',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'Strudel pattern code' },
          auto_play: { type: 'boolean', description: 'Start playback immediately (default: false)' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'play',
      description: 'Evaluate and play the current editor code',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'stop',
      description: 'Stop playback',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_tempo',
      description: 'Change BPM without rewriting the pattern. Changes tempo in real-time.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          bpm: { type: 'number', description: 'Tempo in beats per minute' },
        },
        required: ['bpm'],
      },
    },
    {
      name: 'get_state',
      description: 'Get current session state: playing status, connected clients, pattern history info',
      inputSchema: { type: 'object' as const, properties: {} },
    },

    // Pattern Editing
    {
      name: 'get_code',
      description: 'Read the current editor content from the browser',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'append_code',
      description: 'Append code to the current pattern in the editor',
      inputSchema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Code to append' },
        },
        required: ['code'],
      },
    },
    {
      name: 'replace_code',
      description: 'Search and replace text in the current pattern',
      inputSchema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Text to find' },
          replace: { type: 'string', description: 'Replacement text' },
        },
        required: ['search', 'replace'],
      },
    },
    {
      name: 'add_effect',
      description: 'Append an effect chain to the current pattern (e.g., room, delay, cutoff)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          effect: { type: 'string', description: 'Effect name (room, delay, cutoff, etc.)' },
          params: { type: 'object', description: 'Effect parameters as key-value pairs' },
        },
        required: ['effect'],
      },
    },

    // History
    {
      name: 'undo',
      description: 'Undo the last pattern change',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'redo',
      description: 'Redo a previously undone pattern change',
      inputSchema: { type: 'object' as const, properties: {} },
    },

    // Storage
    {
      name: 'save',
      description: 'Save the current pattern to the database',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Pattern name' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        },
        required: ['name'],
      },
    },
    {
      name: 'load',
      description: 'Load a saved pattern from the database and write it to the editor',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Pattern name to load' },
          auto_play: { type: 'boolean', description: 'Start playback after loading (default: false)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'list',
      description: 'List saved patterns, optionally filtered by tag',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tag: { type: 'string', description: 'Filter by tag' },
        },
      },
    },

    // Generation
    {
      name: 'generate_pattern',
      description: 'Generate a complete multi-layer pattern for a given style',
      inputSchema: {
        type: 'object' as const,
        properties: {
          style: { type: 'string', description: 'Style: techno, house, trance, dnb, ambient, trip_hop, boom_bap, intelligent_dnb, etc.' },
          bpm: { type: 'number', description: 'Tempo in BPM' },
          key: { type: 'string', description: 'Musical key (C, D, A, etc.)' },
        },
        required: ['style'],
      },
    },
    {
      name: 'generate_drums',
      description: 'Generate a drum pattern for a given style',
      inputSchema: {
        type: 'object' as const,
        properties: {
          style: { type: 'string', description: 'Drum style' },
          complexity: { type: 'number', description: 'Complexity 0-1 (default: 0.7)' },
        },
        required: ['style'],
      },
    },
    {
      name: 'generate_bassline',
      description: 'Generate a bassline for a given key and style',
      inputSchema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Musical key' },
          style: { type: 'string', description: 'Bass style' },
        },
        required: ['key', 'style'],
      },
    },

    // Validation
    {
      name: 'validate',
      description: 'Validate a pattern for syntax errors and safety issues',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'Pattern code to validate' },
        },
        required: ['pattern'],
      },
    },

    // Delete
    {
      name: 'delete',
      description: 'Delete a saved pattern from the database',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Pattern name to delete' },
        },
        required: ['name'],
      },
    },

    // Composite
    {
      name: 'compose',
      description: 'One-shot: generate a pattern and immediately play it. The fastest way to get music going.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          style: { type: 'string', description: 'Style: techno, house, trance, dnb, ambient, trip_hop, boom_bap, etc.' },
          bpm: { type: 'number', description: 'Tempo in BPM' },
          key: { type: 'string', description: 'Musical key' },
        },
        required: ['style'],
      },
    },

    // Session
    {
      name: 'connect',
      description: 'Connect to a specific browser session by its code. Use when the browser is already open on a different session than the MCP.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session: { type: 'string', description: 'Session code from the browser URL (e.g., opus-7f3k)' },
        },
        required: ['session'],
      },
    },
  ];
}
