import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { BlobStore } from '../files/store.js';
import { FileError } from '../files/service.js';
import { JobExecutionUnconfirmed } from '../jobs/service.js';
import type { JobCompletion, JobHandlers } from '../jobs/service.js';
import { ConversionRuntimeError } from './runtime.js';
import type { DocumentConverter } from './runtime.js';
import type { ConversionPublication, ConversionRepository } from './repository.js';
import protocol from '../../shared/conversion-protocol.json' with { type: 'json' };
import { conversionJobInputSchema } from './service.js';

/** @id CODE-DCV-004 @implements REQ-DCV-004 */
export function conversionHandlers(
  repository: ConversionRepository,
  store: BlobStore,
  converter: DocumentConverter,
): JobHandlers {
  return new Map([
    [
      'document.convert',
      {
        input: conversionJobInputSchema,
        async run({ claim, input, signal }): Promise<JobCompletion> {
          const parsed = conversionJobInputSchema.parse(input);
          let publication: ConversionPublication | undefined;
          let reason: string | undefined;
          try {
            const request = await repository.get(
              claim.owner,
              claim.job.projectId,
              parsed.conversionId,
            );
            if (request.jobId !== claim.job.id)
              throw new FileError(409, 'CONVERSION_FENCED', 'Conversion claim is unavailable.');
            const source = await repository.sourceForClaim(claim);
            signal.throwIfAborted();
            const stream = await store.read(source.key, source.etag, signal);
            const chunks: Buffer[] = [];
            let size = 0;
            try {
              for await (const chunk of stream) {
                signal.throwIfAborted();
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.byteLength;
                if (size > protocol.limits.inputBytes || size > source.size)
                  throw new ConversionRuntimeError('source_changed', true);
                chunks.push(bytes);
              }
            } finally {
              stream.destroy();
            }
            signal.throwIfAborted();
            const output = await converter.convert(
              {
                name: source.name,
                bytes: Buffer.concat(chunks),
                size: source.size,
                sha256: source.sha256,
                // Blob reads fence the provider version; runtime input identifies stored content.
                etag: `"${source.sha256}"`,
                jobId: claim.job.id,
                fence: claim.fence,
              },
              signal,
            );
            signal.throwIfAborted();
            const pair = await repository.reserveOutputs(claim, {
              markdown: output.markdown.byteLength,
              json: output.documentJson.byteLength,
            });
            const artifact = async (id: string, bytes: Uint8Array) => {
              signal.throwIfAborted();
              const etag = await store.put(
                `${claim.job.projectId}/${id}`,
                Readable.from([bytes]),
                signal,
              );
              return { id, etag, sha256: createHash('sha256').update(bytes).digest('hex') };
            };
            const markdown = await artifact(pair.markdown, output.markdown);
            const json = await artifact(pair.json, output.documentJson);
            signal.throwIfAborted();
            publication = { markdown, json };
          } catch (error) {
            if (error instanceof ConversionRuntimeError && !error.settled)
              throw new JobExecutionUnconfirmed();
            reason =
              error instanceof ConversionRuntimeError
                ? error.code
                : signal.aborted
                  ? 'interrupted'
                  : error instanceof FileError && error.code === 'FILE_QUOTA_EXCEEDED'
                    ? 'quota_exceeded'
                    : error instanceof FileError &&
                        ['NOT_FOUND', 'CONVERSION_SOURCE_CHANGED'].includes(error.code)
                      ? 'source_unavailable'
                      : 'handler_failed';
            console.error(
              JSON.stringify({
                event: 'conversion_attempt_failed',
                jobId: claim.job.id,
                code: reason,
              }),
            );
          }
          return {
            settle: ({ event, interrupted }) =>
              repository.settle(
                claim,
                event === 'success' && publication && !interrupted ? 'success' : 'error',
                interrupted
                  ? { reason: 'interrupted' }
                  : publication
                    ? { publication }
                    : { reason: reason ?? 'handler_failed' },
              ),
          };
        },
      },
    ],
  ]);
}
