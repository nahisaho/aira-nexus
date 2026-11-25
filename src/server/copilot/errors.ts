export class CopilotError extends Error {
  constructor(
    public readonly status: 404 | 409 | 429 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly retryAfter = 0,
  ) {
    super(message);
  }
}
