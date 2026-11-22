export type ChatRunState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ChatFailureCode =
  | 'handler_failed'
  | 'interrupted'
  | 'cancellation_unconfirmed'
  | 'invalid_input';
export type ChatTurnRole = 'user' | 'assistant';

export interface ChatConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  historyRevision: number;
  preview: string;
  latestRunId: string | null;
  activeRunId: string | null;
}

export interface ChatTurn {
  id: string;
  conversationId: string;
  sequence: number;
  role: ChatTurnRole;
  text: string;
  createdAt: string;
}

export interface ChatRun {
  id: string;
  conversationId: string;
  state: ChatRunState;
  modelId: string;
  answer: string;
  failureCode: ChatFailureCode | null;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
}

export interface ChatEvent {
  sequence: number;
  eventKey: string;
  type: 'delta' | 'status';
  text: string;
  state: ChatRunState | null;
  reason: ChatFailureCode | null;
  createdAt: string;
}

export interface ChatPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ChatRunEventPage extends ChatPage<ChatEvent> {
  run: ChatRun;
  lastSequence: number;
}

export interface ChatAdmission {
  idempotencyKey: string;
  modelId: string;
  snapshot: string;
  snapshotHash: string;
}

export interface ChatPreviewAdmission {
  idempotencyKey: string;
  previewId: string;
  snapshotHash: string;
  connectionId: string;
  connectionGeneration: string;
}

export interface ChatDelta {
  eventKey: string;
  type: 'delta';
  text: string;
}
