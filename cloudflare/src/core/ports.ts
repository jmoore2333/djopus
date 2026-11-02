// The two ports of the executor core (src/core/executor.ts): how it reaches the session, and where saved patterns
// live. Each MCP surface passes its own: the ChatGPT one a D1 store, the generic one the session's crate and the
// library.

/** A message from the session's Durable Object: its own answers, and what a browser sent through it. */
export interface DOMessage {
  type: string;
  request_id?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

/**
 * What SendCommand rejects with when the session had no browser to give the command to (a `no_browser` ack). The
 * message is the session's own warning, which is written for ChatGPT: the executor answers this error with the
 * surface's noBrowserMessage instead, so each surface says how its own player is opened.
 */
export class NoBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoBrowserError';
  }
}

/**
 * Sends one command to the session and resolves with the message that settles it: the ack with the command's
 * request_id, or, with `waitForType`, the message of that type with it (session_state for get_state, code_response
 * for get_code). What it does beyond that, in src/core/do-command.ts:
 *
 * - It rejects when the session turns the command away: a `no_browser` ack (no browser to give it to, a
 *   NoBrowserError), a `rejected` ack (its code is over the limit), or a `pattern_error` (the browser could not play
 *   it). get_code is the exception: with no browser, or a browser that stays silent, it resolves with the session's
 *   own pattern.
 * - An evaluate resolves with the browser's ack only once the time in which the browser can still report an
 *   error for that code has passed.
 * - An undo or a redo resolves with the `nothing_to_undo` / `nothing_to_redo` ack when the history did not move.
 *   Otherwise it is settled like an evaluate, by the browser's ack of the code the history moved to, and resolves
 *   with the Durable Object's `undo_result`, whose status is the browser's ack status and whose payload holds that
 *   ack's payload next to `code`, `historyIndex` and `direction`.
 */
export type SendCommand = (
  command: { type: string; payload?: Record<string, unknown> },
  waitForType?: string,
) => Promise<DOMessage>;

export interface PatternEntry {
  name: string;
  content: string;
  tags: string[];
  source: 'crate' | 'library' | 'd1';
}

/**
 * Saved patterns. A store rejects, with a message for the agent, what it will not do: a name or content over the
 * limits, a pattern another session owns. `load` resolves with null for a name it does not have.
 */
export interface PatternStore {
  save(entry: { name: string; content: string; tags: string[] }): Promise<{ saved: string }>;
  load(name: string): Promise<PatternEntry | null>;
  list(tag?: string): Promise<Array<Omit<PatternEntry, 'content'>>>;
  delete(name: string): Promise<{ deleted: string }>;
}
