import { Readable } from 'node:stream';
import type { FileStorageConfig } from './config.js';
import { validateFileStorageConfig } from './config.js';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import { ManagedIdentityCredential } from '@azure/identity';
export interface BlobStore {
  put(key: string, input: Readable, signal: AbortSignal): Promise<string>;
  read(key: string, etag: string, signal?: AbortSignal): Promise<Readable>;
  remove(key: string, etag: string, signal?: AbortSignal): Promise<void>;
}
export class AzureBlobStore implements BlobStore {
  private readonly container: ContainerClient;
  constructor(options: FileStorageConfig) {
    const config = validateFileStorageConfig(options);
    const credential =
      config.mode === 'azurite'
        ? new StorageSharedKeyCredential(config.account, config.key)
        : new ManagedIdentityCredential(config.clientId ? { clientId: config.clientId } : {});
    this.container = new BlobServiceClient(config.endpoint, credential, {
      retryOptions: { maxTries: 1 },
    }).getContainerClient(config.container);
  }
  private async privateContainer(signal?: AbortSignal, create = false) {
    if (create) await this.container.createIfNotExists({ abortSignal: signal });
    const properties = await this.container.getProperties({ abortSignal: signal });
    if (properties.blobPublicAccess !== undefined)
      throw new Error('File storage container must be private.');
  }
  async put(key: string, input: Readable, signal: AbortSignal): Promise<string> {
    await this.privateContainer(signal, true);
    const result = await this.container.getBlockBlobClient(key).uploadStream(input, 256 * 1024, 2, {
      abortSignal: signal,
      conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    });
    if (!result.etag) throw new Error('File storage returned no ETag.');
    return result.etag;
  }
  async read(key: string, etag: string, signal?: AbortSignal): Promise<Readable> {
    await this.privateContainer(signal);
    const response = await this.container.getBlobClient(key).download(0, undefined, {
      abortSignal: signal,
      conditions: { ifMatch: etag },
    });
    if (!response.readableStreamBody) throw new Error('File storage returned no stream.');
    return Readable.from(response.readableStreamBody);
  }
  /** @id CODE-FTP-002 @implements REQ-FTP-002 REQ-FTP-003 */
  async remove(key: string, etag: string, signal?: AbortSignal): Promise<void> {
    await this.privateContainer(signal);
    const blob = this.container.getBlobClient(key);
    try {
      await blob.deleteIfExists({ abortSignal: signal, conditions: { ifMatch: etag } });
    } catch (error) {
      // Azurite can report a failed If-Match for an already-removed immutable key.
      if (
        !(error instanceof Error) ||
        !('statusCode' in error) ||
        error.statusCode !== 412 ||
        (await blob.exists({ abortSignal: signal }))
      )
        throw error;
    }
  }
}
