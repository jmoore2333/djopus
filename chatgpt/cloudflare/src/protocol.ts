// DJ Opus WebSocket Protocol
// All commands carry optional request_id for correlation

export type ClientRole = 'browser' | 'controller';

// === Controller -> Browser commands ===

export interface EvaluateCommand {
  type: 'evaluate';
  request_id?: string;
  payload: { code: string };
}

export interface StopCommand {
  type: 'stop';
  request_id?: string;
}

export interface SetCodeCommand {
  type: 'set_code';
  request_id?: string;
  payload: { code: string };
}

export interface SetTempoCommand {
  type: 'set_tempo';
  request_id?: string;
  payload: { bpm: number };
}

export interface GetCodeCommand {
  type: 'get_code';
  request_id?: string;
}

export interface AppendCodeCommand {
  type: 'append_code';
  request_id?: string;
  payload: { code: string };
}

export interface ReplaceCodeCommand {
  type: 'replace_code';
  request_id?: string;
  payload: { search: string; replace: string };
}

export interface AddEffectCommand {
  type: 'add_effect';
  request_id?: string;
  payload: { effect: string; params?: Record<string, number> };
}

export interface RecoverAudioCommand {
  type: 'recover_audio';
  request_id?: string;
}

export interface ResetSessionCommand {
  type: 'reset_session';
  request_id?: string;
}

// === Controller -> DO commands ===

export interface UndoCommand {
  type: 'undo';
  request_id?: string;
}

export interface RedoCommand {
  type: 'redo';
  request_id?: string;
}

export interface GetStateCommand {
  type: 'get_state';
  request_id?: string;
}

// === Browser -> Controller responses ===

export interface StatusReport {
  type: 'status_report';
  payload: {
    isPlaying: boolean;
    codeLength: number;
    hasErrors: boolean;
    bpm: number | null;
    errorMessage: string | null;
  };
}

export interface PatternError {
  type: 'error';
  request_id?: string;
  payload: {
    message: string;
    code?: string;
  };
}

/**
 * A browser's answer to a get_code: the editor's text. It is passed on to the controllers whatever it is. The session
 * adopts the text only as the answer to a get_code it is still waiting for, by the request_id: one nobody asked for, or
 * that an evaluate, set_code, undo, redo or reset_session has passed, is not adopted.
 */
export interface CodeResponse {
  type: 'code_response';
  request_id?: string;
  payload: { code: string };
}

/**
 * Browser -> session, unasked: the user played the editor's text by hand (Ctrl+Enter, the play button) and it ran
 * without an error. The session takes the text for its code, so that currentPattern, rev and the undo history are what
 * is playing and not what an agent last sent, and counts the session as playing. A text the session already holds
 * changes nothing. Only a browser sends one: from a controller it is dropped.
 */
export interface CodeUpdateMessage {
  type: 'code_update';
  payload: { code: string };
}

// === DO -> Client messages ===

export interface SessionStateMessage {
  type: 'session_state';
  request_id?: string;
  payload: SessionState;
}

export interface AckPayload {
  /**
   * The editor's full text after the browser appended to it, replaced in it or
   * added an effect (acks with status appended, replaced or effect_added). The
   * session adopts it, if it is still waiting for the ack of that edit (an
   * evaluate, set_code, undo, redo or reset_session since then has replaced
   * the text), so currentPattern and the undo history follow edits the
   * controller only sent as fragments. Acks from an older bridge do not carry it.
   */
  code?: string;
  [key: string]: unknown;
}

export interface AckMessage {
  type: 'ack';
  request_id?: string;
  status: string;
  payload?: AckPayload;
}

export interface ClientStatusMessage {
  type: 'client_status';
  payload: StatusReport['payload'];
}

export interface PatternErrorMessage {
  type: 'pattern_error';
  request_id?: string;
  payload: PatternError['payload'];
}

/**
 * What the controller that sent an undo or a redo is told when the history moved: the code it moved to, which the
 * browsers are sent as an evaluate carrying the same request_id. It is not an ack, so it settles nothing: the
 * browser's ack of that evaluate, or its pattern_error, settles the command. Nothing to undo or redo, and no browser
 * to play the code, are acks (nothing_to_undo, nothing_to_redo, no_browser), and then the history did not move.
 */
export interface UndoResultMessage {
  type: 'undo_result';
  request_id?: string;
  payload: { code: string; historyIndex: number; direction: 'undo' | 'redo' };
}

// === State ===

export interface SessionState {
  currentPattern: string;
  isPlaying: boolean;
  /**
   * Counts changes to the session's code, from 0 for a new session. It never
   * goes down, so a client can tell a newer session_state from an older one.
   */
  rev: number;
  createdAt: string;
  lastActivity: string;
  connectedClients: number;
  connectedControllers: number;
  historySize: number;
  historyIndex: number;
}

// === Union types ===

export type IncomingMessage =
  | EvaluateCommand
  | StopCommand
  | SetCodeCommand
  | SetTempoCommand
  | GetCodeCommand
  | AppendCodeCommand
  | ReplaceCodeCommand
  | AddEffectCommand
  | RecoverAudioCommand
  | ResetSessionCommand
  | UndoCommand
  | RedoCommand
  | GetStateCommand
  | StatusReport
  | PatternError
  | CodeResponse
  | CodeUpdateMessage
  | AckMessage;
