export type ChatErrorCode =
  | 'CHAT_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_CURSOR'
  | 'FUTURE_SEQUENCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CHAT_BUSY'
  | 'CONSENT_REQUIRED';

export class ChatError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 503,
    public readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const chatMissing = () => new ChatError(404, 'NOT_FOUND', 'Conversation or run not found.');
export const chatUnavailable = () =>
  new ChatError(503, 'CHAT_UNAVAILABLE', 'Chat is unavailable.');