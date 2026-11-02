import { vi } from 'vitest';
import { sessionHash } from '../../../src/log';

type Json = Record<string, unknown>;

export interface CapturedLogs {
  /** Every console.log call so far, one string per call. */
  lines(): string[];
  /** The lines that are JSON objects, parsed. */
  events(): Json[];
}

/**
 * Collects (and silences) what the Worker and the Durable Object write with
 * console.log. They run in this isolate, so a spy here sees their output. The
 * calling file restores it with vi.restoreAllMocks().
 */
export function captureLogs(): CapturedLogs {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const lines = () => spy.mock.calls.map((args) => args.map(String).join(' '));
  return {
    lines,
    events: () =>
      lines().flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return typeof value === 'object' && value !== null ? [value as Json] : [];
        } catch {
          return [];
        }
      }),
  };
}

/** The LOG_HASH_KEY binding that vitest.config.ts and vitest.chatgpt.config.ts give the Durable Object. */
export const TEST_LOG_HASH_KEY = 'test-log-hash-key';

/** The sessionHash the Durable Object logs for `session`. */
export function hashOf(session: string): Promise<string> {
  return sessionHash(session, TEST_LOG_HASH_KEY);
}
