import { defineConfig } from 'vitest/config';

// Plain Node, no workerd: bridge.test.ts loads client/strudel-ws-bridge.js as a CommonJS module
// and drives it with a fake WebSocket and fake timers, check-static.test.ts runs
// scripts/check-static.mjs, and wrangler-config.test.ts reads the wrangler configs. test/unit is outside
// vitest.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
