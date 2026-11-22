import type { Principal } from '../../shared/contracts.js';
import type { FilePage, ProjectFile, UploadMetadata } from '../../shared/files.js';
import type { FileRepository } from './repository.js';
import type { BlobStore } from './store.js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileKind, MAX_FILE_BYTES, uploadMetadataSchema } from '../../shared/files.js';
let activeUploads = 0;
const unavailable = () =>
  new FileError(503, 'FILES_UNAVAILABLE', 'File storage is unavailable. Retry later.');
export class FileError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 415 | 429 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateUpload(input: UploadMetadata) {
  if (typeof input.size === 'number' && input.size > MAX_FILE_BYTES)
    throw new FileError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit.');
  const parsed = uploadMetadataSchema.safeParse(input);
  if (!parsed.success)
    throw new FileError(400, 'INVALID_FILE', 'Invalid file name or declared byte size.');
  const kind = fileKind(parsed.data.name);
  if (!kind) throw new FileError(415, 'UNSUPPORTED_FILE', 'Unsupported file extension.');
  return { ...parsed.data, kind };
}
/** @id CODE-SVC-002 @implements REQ-SVC-001 REQ-SVC-004 REQ-SVC-005 REQ-SVC-006 */
export class FileService {
  constructor(
    private readonly repository: FileRepository,
    private readonly store: BlobStore,
  ) {}
  async upload(
    owner: Principal,
    projectId: string,
    metadata: UploadMetadata,
    body: ReadableStream<Uint8Array> | null,
    signal?: AbortSignal,
  ): Promise<ProjectFile> {
    const upload = validateUpload(metadata);
    if (activeUploads >= 4)
      throw new FileError(429, 'UPLOAD_BUSY', 'Four file uploads are already active. Retry later.');
    activeUploads++;
    const controller = new AbortController();
    const interrupt = () =>
      controller.abort(
        new FileError(
          503,
          'UPLOAD_INTERRUPTED',
          'Upload interrupted; refresh to check whether it was saved.',
        ),
      );
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const timer = setTimeout(
      () =>
        controller.abort(
          new FileError(503, 'UPLOAD_TIMEOUT', 'Upload timed out; refresh to check its status.'),
        ),
      300000,
    );
    timer.unref();
    let id: string | undefined, input: Readable | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      if (reader)
        void reader
          .cancel(controller.signal.reason)
          .catch(() => console.error(JSON.stringify({ event: 'file_input_cancel_failed' })));
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let actual = 0;
    const hash = createHash('sha256');
    try {
      reader = body?.getReader();
      controller.signal.throwIfAborted();
      id = await this.repository.reserve(owner, projectId, {
        name: upload.name,
        size: upload.size,
      });
      controller.signal.throwIfAborted();
      const sourceReader = reader;
      input = Readable.from(
        (async function* () {
          if (!sourceReader) return;
          while (true) {
            const next = await sourceReader.read();
            controller.signal.throwIfAborted();
            if (next.done) return;
            actual += next.value.byteLength;
            if (actual > upload.size || actual > MAX_FILE_BYTES) {
              const failure = new FileError(
                413,
                'FILE_TOO_LARGE',
                'File exceeds its declared byte size.',
              );
              controller.abort(failure);
              throw failure;
            }
            hash.update(next.value);
            yield Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
          }
        })(),
        { objectMode: false, highWaterMark: 64 * 1024 },
      );
      const etag = await this.store.put(
        `${projectId.toLowerCase()}/${id}`,
        input,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (actual !== upload.size)
        throw new FileError(400, 'INCOMPLETE_FILE', 'File is shorter than its declared byte size.');
      const ready = await this.repository.finalize(owner, projectId, id, hash.digest('hex'), etag);
      controller.signal.throwIfAborted();
      return ready;
    } catch (error) {
      if (id) {
        try {
          await this.repository.fail(owner, projectId, id);
        } catch {
          throw unavailable();
        }
      }
      if (controller.signal.reason instanceof FileError) throw controller.signal.reason;
      if (error instanceof FileError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      controller.signal.removeEventListener('abort', cancel);
      input?.destroy();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          console.error(JSON.stringify({ event: 'file_input_cleanup_failed' }));
        }
        reader.releaseLock();
      }
      activeUploads--;
    }
  }
  async list(
    owner: Principal,
    projectId: string,
    cursor?: string,
    trashed = false,
  ): Promise<FilePage> {
    try {
      return await this.repository.list(owner, projectId, cursor, trashed);
    } catch (error) {
      if (error instanceof FileError) throw error;
      throw unavailable();
    }
  }
  /** @id CODE-FEX-003 @implements REQ-FEX-002 */
  async setTrashed(
    owner: Principal,
    projectId: string,
    id: string,
    trashed: boolean,
  ): Promise<void> {
    try {
      await this.repository.setTrashed(owner, projectId, id, trashed);
    } catch (error) {
      if (error instanceof FileError) throw error;
      throw unavailable();
    }
  }
  /** @id CODE-FTP-003 @implements REQ-FTP-002 REQ-FTP-003 */
  async emptyTrash(owner: Principal, projectId: string, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(300000);
    const operation = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      operation.throwIfAborted();
      await this.repository.beginPurge(owner, projectId);
      while (true) {
        operation.throwIfAborted();
        const batch = await this.repository.purgeBatch(owner, projectId);
        if (!batch.length) return;
        for (const file of batch) {
          operation.throwIfAborted();
          await this.store.remove(file.key, file.etag, operation);
          operation.throwIfAborted();
          await this.repository.finishPurge(owner, projectId, file.id);
        }
      }
    } catch (error) {
      if (error instanceof FileError) throw error;
      console.error(JSON.stringify({ event: 'file_purge_interrupted' }));
      throw new FileError(
        503,
        'FILE_PURGE_INTERRUPTED',
        'Permanent deletion may be partial. Reload trash and retry emptying it.',
      );
    }
  }
  async open(
    owner: Principal,
    projectId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ file: ProjectFile; body: ReadableStream<Uint8Array> }> {
    try {
      const stored = await this.repository.get(owner, projectId, id);
      const { key, etag, ...file } = stored;
      const source = await this.store.read(key, etag, signal);
      const abort = () => source.destroy();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const iterator = source[Symbol.asyncIterator]();
      const detach = () => signal?.removeEventListener('abort', abort);
      let first: IteratorResult<unknown>;
      try {
        first = await iterator.next();
        if (first.done && file.size !== 0) throw unavailable();
      } catch (error) {
        detach();
        source.destroy();
        throw error;
      }
      let initial = true;
      const bytes = (value: unknown) => {
        if (!(value instanceof Uint8Array)) throw unavailable();
        return value;
      };
      return {
        file,
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = initial ? first : await iterator.next();
              initial = false;
              if (next.done) {
                detach();
                controller.close();
              } else controller.enqueue(bytes(next.value));
            } catch {
              detach();
              source.destroy();
              console.error(JSON.stringify({ event: 'file_content_interrupted' }));
              controller.error(unavailable());
            }
          },
          cancel() {
            detach();
            source.destroy();
          },
        }),
      };
    } catch (error) {
      if (error instanceof FileError) throw error;
      throw unavailable();
    }
  }
}
