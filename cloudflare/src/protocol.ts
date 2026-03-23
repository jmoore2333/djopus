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

export interface CodeResponse {
  type: 'code_response';
  request_id?: string;
  payload: { code: string };
}

// === DO -> Client messages ===

export interface SessionStateMessage {
  type: 'session_state';
  request_id?: string;
  payload: SessionState;
}

export interface AckMessage {
  type: 'ack';
  request_id?: string;
  status: string;
  payload?: Record<string, unknown>;
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

// === State ===

export interface SessionState {
  currentPattern: string;
  isPlaying: boolean;
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
  | UndoCommand
  | RedoCommand
  | GetStateCommand
  | StatusReport
  | PatternError
  | CodeResponse;
