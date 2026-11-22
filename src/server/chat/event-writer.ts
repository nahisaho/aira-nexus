/** @id CODE-CHR-007 @implements REQ-CHR-004 */
export class ChatEventWriter {
  private queue = Promise.resolve();
  private text = '';
  private bytes = 0;
  private count = 0;
  private failure: Error | undefined;
  private writeFailed = false;

  constructor(
    private readonly append: (key: string, text: string) => Promise<void>,
    private readonly interrupt: (error: Error) => void,
  ) {}

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.interrupt(error);
  }

  push(text: string): void {
    if (this.failure || text === '') return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (
      text.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(text) ||
      bytes > 16_384 ||
      this.bytes + bytes > 1_000_000 ||
      this.count >= 4096
    ) {
      this.fail(new Error('Invalid or oversized chat delta.'));
      return;
    }
    this.bytes += bytes;
    this.text += text;
    const key = `assistant-delta:${++this.count}`;
    this.queue = this.queue.then(async () => {
      if (this.writeFailed) return;
      try {
        await this.append(key, text);
      } catch {
        this.writeFailed = true;
        this.fail(new Error('Chat delta could not be persisted.'));
      }
    });
  }

  async finish(answer?: string): Promise<void> {
    if (answer !== undefined && !this.failure) {
      if (this.count === 0) this.push(answer);
      else if (answer !== this.text)
        this.fail(new Error('Chat final text conflicts with its deltas.'));
    }
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
