export class InputError extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}
/** @id CODE-PREF-002 @implements REQ-PREF-002 REQ-PROJ-003 */
export async function readJson(
  request: Request,
  contentTypeError = 'A JSON object is required.',
): Promise<unknown> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new InputError(400, contentTypeError);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 16384) {
          await reader.cancel();
          throw new InputError(413, 'Request body exceeds 16384 bytes.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new InputError(400, 'Invalid JSON body.');
    throw error;
  }
}
