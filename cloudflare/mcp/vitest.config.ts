import { defineConfig } from 'vitest/config';

// Plain Node: the proxy under test is an MCP client over HTTP, and the tests run it against an MCP server in the same
// process (test/helpers/remote-mcp.ts) on a random local port. test/stdio.test.ts also runs it as a process.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
