import { checkCode } from '../limits';
import type { SessionState } from '../protocol';
import { PatternGenerator } from '../services/PatternGenerator';
import { PatternValidator, type ValidationResult } from '../services/PatternValidator';
import { type DOMessage, NoBrowserError, type PatternStore, type SendCommand } from './ports';
import type { ToolName } from './tools';

const generator = new PatternGenerator();
const validator = new PatternValidator();

// How often a tool that needs a browser looks for one while it waits.
const BROWSER_POLL_MS = 250;

const COLLABORATION_HINT = 'Music is already live in the REPL. Keep the chat reply short, and offer a quick handoff such as whether DJ Opus should keep driving or let the user take over. Do not paste the pattern unless the user asked to see the code.';

export interface ExecutorDeps {
  /** The DJ Opus session the tools drive. */
  sessionId: string;
  sendCommand: SendCommand;
  store: PatternStore;
  /** How long a tool that needs a browser waits for one to connect. */
  browserWaitMs: number;
  /**
   * What a tool fails with when the session has no browser: how the user gets one, for `action`. That is when none
   * connected in time, and when the session turned a command away for want of one (a NoBrowserError).
   */
  noBrowserMessage(action: string): string;
  /** Fields get_state adds to the session state, such as the URL of the player. */
  describeSession?(): Record<string, unknown>;
}

/**
 * The one implementation of the DJ Opus tools (all but connect, which binds a session and belongs to the surface).
 * A result says only what the session confirmed: a pattern that cannot be played is refused before it is sent, a
 * command that needs a browser waits for one, and anything that plays code reports what the browser answered.
 * Whatever the session or the store turns away fails the call with their reason.
 */
export function createExecutor(deps: ExecutorDeps): {
  executeTool(name: Exclude<ToolName, 'connect'>, args: Record<string, unknown>): Promise<unknown>;
} {
  const { sendCommand, store } = deps;

  async function ensureBrowserConnected(action: string): Promise<void> {
    const deadline = Date.now() + deps.browserWaitMs;
    for (;;) {
      if ((await getSessionState()).connectedClients > 0) return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, BROWSER_POLL_MS));
    }
    throw new Error(deps.noBrowserMessage(action));
  }

  async function getSessionState(): Promise<SessionState> {
    const stateMsg = await sendCommand({ type: 'get_state' }, 'session_state');
    return stateMsg.payload as unknown as SessionState;
  }

  async function getCurrentCode(): Promise<string> {
    const codeMsg = await sendCommand({ type: 'get_code' }, 'code_response');
    return (codeMsg.payload as { code: string }).code;
  }

  // What POST /api/validate does with a pattern: it is required, it is within the code limit in bytes, and then the
  // validator reads it.
  function validateCode(pattern: unknown): ValidationResult {
    if (!pattern) throw new Error('pattern is required');
    return validator.validate(checkCode(pattern, 'pattern'));
  }

  // A call to a name the REPL does not have is refused here too, not only a syntax error: Strudel turns it into an
  // evaluation error that leaves the player silent, and the browser could still ack the evaluation. The names come
  // from the pinned Strudel build (src/core/strudel-names.generated.json), so only a truly unknown name is refused.
  function validatePlayablePattern(pattern: string, action: string): void {
    const result = validateCode(pattern);
    const executableWarnings = result.warnings.filter((warning) => warning.startsWith('Unknown function:'));
    const issues = [...result.errors, ...executableWarnings];

    if (issues.length === 0) return;

    const suggestion = result.suggestions[0] ? ` Suggestion: ${result.suggestions[0]}` : '';
    throw new Error(`DJ Opus ${action} rejected the pattern before playback: ${issues.join('; ')}.${suggestion}`);
  }

  function interpretPlaybackResult(result: DOMessage, code: string): {
    status: string;
    length: number;
    needsUserGesture?: boolean;
    audioContextState?: string | null;
    message?: string;
  } {
    const payload = (result.payload ?? {}) as {
      audioContextState?: string | null;
      message?: string;
    };

    if (result.status === 'needs_user_gesture') {
      return {
        status: 'needs_user_gesture',
        length: code.length,
        needsUserGesture: true,
        audioContextState: payload.audioContextState ?? null,
        message: payload.message
          ?? 'DJ Opus queued the pattern, but the browser still needs a tap inside the widget to unlock audio.',
      };
    }

    return {
      status: 'playing',
      length: code.length,
      audioContextState: payload.audioContextState ?? null,
      message: payload.message,
    };
  }

  async function applyEditorMutation(
    action: 'append_code' | 'replace_code' | 'add_effect',
    transform: (currentCode: string) => string,
  ): Promise<{ code: string; liveUpdated: boolean; changed: boolean }> {
    await ensureBrowserConnected(action);
    const currentCode = await getCurrentCode();
    const updatedCode = transform(currentCode);
    const changed = updatedCode !== currentCode;

    if (!changed) {
      return { code: currentCode, liveUpdated: false, changed: false };
    }

    validatePlayablePattern(updatedCode, action);

    const state = await getSessionState();
    if (state.isPlaying) {
      await sendCommand({ type: 'evaluate', payload: { code: updatedCode } });
      return { code: updatedCode, liveUpdated: true, changed: true };
    }

    await sendCommand({ type: 'set_code', payload: { code: updatedCode } });
    return { code: updatedCode, liveUpdated: false, changed: true };
  }

  function generatePattern(args: Record<string, unknown>): string {
    // The defaults of POST /api/generate/pattern.
    return generator.generateCompletePattern(
      (args.style as string | undefined) || 'techno',
      (args.key as string | undefined) || 'C',
      (args.bpm as number | undefined) || 130,
    );
  }

  // The session had no browser for a command: the one the tool found has gone since, or the tool does not look for
  // one first. The session's warning is written for ChatGPT, so the surface's own message takes its place.
  async function executeTool(name: Exclude<ToolName, 'connect'>, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await runTool(name, args);
    } catch (error) {
      if (error instanceof NoBrowserError) throw new Error(deps.noBrowserMessage(name));
      throw error;
    }
  }

  async function runTool(name: Exclude<ToolName, 'connect'>, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      // ── Core Playback ──────────────────────────────────────────────

      case 'write': {
        // Before anything is sent: the schema counts characters, and code is limited in bytes.
        const code = checkCode(args.pattern, 'pattern');
        await ensureBrowserConnected('write');
        validatePlayablePattern(code, 'write');
        if (args.auto_play) {
          const result = await sendCommand({ type: 'evaluate', payload: { code } });
          return interpretPlaybackResult(result, code);
        } else {
          await sendCommand({ type: 'set_code', payload: { code } });
          return { status: 'written', length: code.length };
        }
      }

      case 'play': {
        await ensureBrowserConnected('play');
        const code = await getCurrentCode();
        validatePlayablePattern(code, 'play');
        const result = await sendCommand({ type: 'evaluate', payload: { code } });
        return interpretPlaybackResult(result, code);
      }

      // Like play: with no browser there is nothing to stop, and the answer names how to open the player. The browser's
      // ack, which the session relays, is what settles the command.
      case 'stop':
        await ensureBrowserConnected('stop');
        await sendCommand({ type: 'stop' });
        return { status: 'stopped' };

      case 'set_tempo':
        await ensureBrowserConnected('set_tempo');
        await sendCommand({ type: 'set_tempo', payload: { bpm: args.bpm as number } });
        return { status: 'tempo_set', bpm: args.bpm };

      case 'get_state':
        return { ...(await getSessionState()), ...deps.describeSession?.() };

      case 'recover_audio': {
        await ensureBrowserConnected('recover_audio');
        const result = await sendCommand({ type: 'recover_audio' });
        return {
          status: result.status ?? 'checked',
          ...(result.payload ?? {}),
        };
      }

      case 'reset_session': {
        const result = await sendCommand({ type: 'reset_session' });
        return {
          status: result.status ?? 'session_reset',
          sessionId: deps.sessionId,
          ...(result.payload ?? {}),
        };
      }

      // ── Pattern Editing ────────────────────────────────────────────

      case 'get_code':
        return { code: await getCurrentCode() };

      case 'append_code': {
        const result = await applyEditorMutation('append_code', (currentCode) => {
          if (!currentCode.trim()) return args.code as string;
          return `${currentCode}\n\n${args.code as string}`;
        });
        return {
          status: 'appended',
          changed: result.changed,
          liveUpdated: result.liveUpdated,
          length: result.code.length,
        };
      }

      case 'replace_code': {
        const search = args.search as string;
        const replace = args.replace as string;
        const result = await applyEditorMutation('replace_code', (currentCode) =>
          currentCode.split(search).join(replace),
        );
        return {
          status: 'replaced',
          changed: result.changed,
          liveUpdated: result.liveUpdated,
          length: result.code.length,
        };
      }

      case 'add_effect': {
        const effect = args.effect as string;
        const params = args.params as Record<string, number> | undefined;
        const effectArgs = params ? Object.values(params).join(', ') : '';
        const effectSuffix = `.${effect}(${effectArgs})`;
        const result = await applyEditorMutation('add_effect', (currentCode) => `${currentCode}${effectSuffix}`);
        return {
          status: 'effect_added',
          effect,
          changed: result.changed,
          liveUpdated: result.liveUpdated,
          length: result.code.length,
        };
      }

      // ── History ────────────────────────────────────────────────────

      // The history moves in the session, but only the browser that plays the code it lands on can confirm the
      // undo, so these wait for a browser and report what it answered, as the other playback tools do. The session
      // answers with where the history went (undo_result) or that it could not move; anything else is no answer to
      // report as one.
      case 'undo':
      case 'redo': {
        await ensureBrowserConnected(name);
        const result = await sendCommand({ type: name });
        const nothing = name === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo';
        if (result.type === 'ack' && result.status === nothing) return { status: nothing };
        if (result.type !== 'undo_result') {
          const answer = result.status === undefined ? result.type : `${result.type} ${result.status}`;
          throw new Error(`DJ Opus could not ${name}: the session answered ${answer} instead of where the history moved.`);
        }
        const code = (result.payload as { code: string }).code;
        const playback = interpretPlaybackResult(result, code);
        return {
          status: name === 'undo' ? 'undone' : 'redone',
          code,
          playback: playback.status,
          ...(playback.message === undefined ? {} : { message: playback.message }),
        };
      }

      // ── Storage ────────────────────────────────────────────────────

      case 'save': {
        const code = await getCurrentCode();
        return await store.save({
          name: args.name as string,
          content: code,
          tags: (args.tags as string[] | undefined) || [],
        });
      }

      case 'load': {
        await ensureBrowserConnected('load');
        const name = args.name as string;
        const pattern = await store.load(name);
        if (!pattern) throw new Error(`Pattern "${name}" not found`);
        if (args.auto_play) {
          const result = await sendCommand({ type: 'evaluate', payload: { code: pattern.content } });
          return {
            loaded: args.name,
            ...interpretPlaybackResult(result, pattern.content),
          };
        } else {
          await sendCommand({ type: 'set_code', payload: { code: pattern.content } });
          return { loaded: args.name, length: pattern.content.length };
        }
      }

      case 'list':
        // An empty tag filters nothing, as in GET /api/patterns?tag=.
        return { patterns: await store.list((args.tag as string | undefined) || undefined) };

      case 'delete':
        return await store.delete(args.name as string);

      // ── Generation ─────────────────────────────────────────────────
      // A root MusicTheory does not know fails the call with MusicTheory's reason (MusicInputError).

      case 'generate_pattern':
        return { pattern: generatePattern(args) };

      case 'generate_drums':
        return {
          pattern: generator.generateDrumPattern(
            (args.style as string | undefined) || 'techno',
            (args.complexity as number | undefined) ?? 0.7,
          ),
        };

      case 'generate_bassline':
        return {
          pattern: generator.generateBassline(
            (args.key as string | undefined) || 'C',
            (args.style as string | undefined) || 'techno',
          ),
        };

      // ── Validation ─────────────────────────────────────────────────

      case 'validate':
        return validateCode(args.pattern);

      // ── Composite ──────────────────────────────────────────────────

      case 'compose': {
        await ensureBrowserConnected('compose');
        const pattern = generatePattern(args);
        validatePlayablePattern(pattern, 'compose');
        const result = await sendCommand({ type: 'evaluate', payload: { code: pattern } });
        return {
          ...interpretPlaybackResult(result, pattern),
          pattern,
          collaborationHint: COLLABORATION_HINT,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name as string}`);
    }
  }

  return { executeTool };
}
