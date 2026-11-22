export class JobError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
