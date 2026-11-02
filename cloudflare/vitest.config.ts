import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig, type Plugin } from 'vitest/config';

// The tests load packages whose source maps point at sources the package does not ship, and Vite warns once per file
// about it: the MCP SDK (test/worker/core/tools.test.ts, and the app's /mcp), and cron-schedule, which the agents SDK
// of /mcp imports. Only those warnings, for those packages, are dropped; every other one still prints. The logger is
// wrapped once the config is resolved, because vitest supplies its own.
const SOURCE_MAPLESS_PACKAGES = ['/node_modules/@modelcontextprotocol/sdk/', '/node_modules/cron-schedule/'];

const quietSdkSourceMaps: Plugin = {
  name: 'quiet-mcp-sdk-source-maps',
  configResolved(config) {
    const warnOnce = config.logger.warnOnce.bind(config.logger);
    config.logger.warnOnce = (message, options) => {
      const known = SOURCE_MAPLESS_PACKAGES.some((path) => message.includes(path));
      if (known && message.includes('points to missing source files')) return;
      warnOnce(message, options);
    };
  },
};

// The app Worker (wrangler.toml), with the tests of test/worker. vitest.chatgpt.config.ts runs the ChatGPT Worker. The
// app has no D1 database, so unlike that config this one applies no migrations (test/setup.ts is theirs).
export default defineConfig({
  plugins: [
    quietSdkSourceMaps,
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          // Keeps the Durable Object tests on the keyed session hash. test/worker/helpers/logs.ts holds the same value.
          LOG_HASH_KEY: 'test-log-hash-key',
        },
        // The limiters of wrangler.toml, with limits no test reaches. Requests through exports.default carry no CF-Connecting-IP,
        // so every test counts under the one key `unknown`, and the suite opens more than 30 sockets a minute through
        // /ws. test/worker/rate-limit.test.ts tries the limits with limiters of its own.
        ratelimits: {
          MCP_RATE_LIMITER: { namespace_id: '2611011', simple: { limit: 1_000_000, period: 60 } },
          WS_RATE_LIMITER: { namespace_id: '2611012', simple: { limit: 1_000_000, period: 60 } },
        },
      },
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
  },
});
