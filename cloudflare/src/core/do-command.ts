import { type DOMessage, NoBrowserError, type SendCommand } from './ports';

// How long a command waits for the message that settles it.
const DEFAULT_TIMEOUT_MS = 10_000;

// How long a command that made the browser play code waits after the browser's ack for an error. The bridge
// (client/strudel-ws-bridge.js) attributes a page error to the evaluate it is playing for 1,500 ms, so an error can
// arrive that long after the ack.
const DEFAULT_LATE_ERROR_MS = 1_500;

const NO_BROWSER = 'No DJ Opus browser session is connected.';

/**
 * The SendCommand of the Worker. Each command opens a short-lived controller socket to the session's SessionBridge
 * (the stub's internal path, not the public /ws), sends the command with a fresh request_id, and closes once the
 * message that settles it is in: see SendCommand in ports.ts for what settles what.
 */
export function createDoCommandSender<T extends Rpc.DurableObjectBranded | undefined>(
  ns: DurableObjectNamespace<T>,
  sessionId: string,
  opts: { timeoutMs?: number; lateErrorMs?: number } = {},
): SendCommand {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lateErrorMs = opts.lateErrorMs ?? DEFAULT_LATE_ERROR_MS;

  return async function sendCommand(command, waitForType) {
    const stub = ns.get(ns.idFromName(sessionId));
    // No session id in the URL: the object knows its name (idFromName above), and the id stays out of anything that
    // records the request.
    const resp = await stub.fetch('https://internal/ws?role=controller', { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new Error('Failed to establish WebSocket to SessionBridge');
    ws.accept();

    const requestId = crypto.randomUUID();
    // On connect the Durable Object sends its session_state. Its currentPattern is the answer to a get_code that
    // no browser gives.
    let cachedPattern: string | null = null;
    // Where an undo or redo moved the history, until the browser's ack of that code settles the command.
    let undoResult: DOMessage | null = null;

    return new Promise<DOMessage>((resolve, reject) => {
      let settled = false;
      let lateErrorTimer: ReturnType<typeof setTimeout> | null = null;

      // For get_code, the pattern cached from session_state stands in for the browser's answer when the browser
      // is silent or not there.
      function cachedCodeResponse(): DOMessage | null {
        if (waitForType !== 'code_response' || cachedPattern === null) return null;
        return { type: 'code_response', request_id: requestId, payload: { code: cachedPattern } };
      }

      function cleanup(): void {
        settled = true;
        clearTimeout(timeout);
        if (lateErrorTimer) clearTimeout(lateErrorTimer);
        try {
          ws!.close();
        } catch {
          // already closed
        }
      }

      function succeed(message: DOMessage): void {
        if (settled) return;
        cleanup();
        resolve(message);
      }

      function fail(error: Error): void {
        if (settled) return;
        cleanup();
        reject(error);
      }

      const timeout = setTimeout(() => {
        const cached = cachedCodeResponse();
        if (cached) succeed(cached);
        else fail(new Error(`Timeout waiting for response to ${command.type}`));
      }, timeoutMs);

      ws.addEventListener('message', (event: MessageEvent) => {
        if (settled) return;
        let msg: DOMessage;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }

        if (msg.type === 'session_state' && msg.payload) {
          cachedPattern = (msg.payload as { currentPattern?: string }).currentPattern ?? null;
        }
        if (msg.request_id !== requestId) return;

        // An error fails the command, also inside the window after the ack.
        if (msg.type === 'pattern_error') {
          fail(new Error((msg.payload as { message?: string } | undefined)?.message ?? 'DJ Opus REPL error'));
          return;
        }
        // The ack is in and the window is open: only an error can still change the outcome.
        if (lateErrorTimer) return;

        // The bridge turned the command away (its code is over the limit): fail with the reason it gave.
        if (msg.type === 'ack' && msg.status === 'rejected') {
          const reason = (msg.payload as { reason?: string } | undefined)?.reason ?? 'no reason given';
          fail(new Error(`DJ Opus rejected the command: ${reason}`));
          return;
        }

        if (msg.type === 'ack' && msg.status === 'no_browser') {
          const cached = cachedCodeResponse();
          if (cached) succeed(cached);
          else fail(new NoBrowserError((msg.payload as { warning?: string } | undefined)?.warning ?? NO_BROWSER));
          return;
        }

        // An undo or redo moved the history. That settles nothing: the browser's ack of the code it moved to does.
        if (msg.type === 'undo_result') {
          undoResult = msg;
          return;
        }

        if (waitForType && msg.type !== waitForType) return;

        // A browser has played code (an evaluate, or the code an undo or redo moved to) and can still report an error
        // for it. The command timeout no longer applies: this timer ends the command.
        if (msg.type === 'ack' && (command.type === 'evaluate' || undoResult)) {
          const answer = undoResult ? withPlayback(undoResult, msg) : msg;
          clearTimeout(timeout);
          lateErrorTimer = setTimeout(() => succeed(answer), lateErrorMs);
          return;
        }

        succeed(msg);
      });

      ws.addEventListener('error', () => fail(new Error('WebSocket error communicating with SessionBridge')));
      ws.addEventListener('close', () => fail(new Error('WebSocket closed unexpectedly')));

      ws.send(JSON.stringify({ ...command, request_id: requestId }));
    });
  };
}

/** The undo_result of an undo or redo, with the status and payload of the browser's ack of the code it moved to. */
function withPlayback(undoResult: DOMessage, ack: DOMessage): DOMessage {
  return { ...undoResult, status: ack.status, payload: { ...ack.payload, ...undoResult.payload } };
}
