import { GenericContainer, Wait } from 'testcontainers';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobStore } from '../../src/server/files/store.js';

export async function testBlobStorage() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No private Blob test port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const account = 'testaccount';
  const key = randomBytes(64).toString('base64');
  const runtime = await new GenericContainer(
    'mcr.microsoft.com/azure-storage/azurite@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5',
  )
    .withEnvironment({ AZURITE_ACCOUNTS: `${account}:${key}` })
    .withNetworkMode('host')
    .withResourcesQuota({ memory: 512 * 1024 * 1024, cpu: 1 })
    .withCommand([
      'azurite-blob',
      '--blobHost',
      '127.0.0.1',
      '--blobPort',
      String(port),
      '--location',
      '/tmp/files-test',
      '--silent',
      '--disableTelemetry',
    ])
    .withWaitStrategy(Wait.forLogMessage(/Azurite Blob service successfully listens/))
    .start();
  const endpoint = `http://127.0.0.1:${port}/${account}`;
  const containerName = `test-${randomUUID()}`;
  const client = new BlobServiceClient(endpoint, new StorageSharedKeyCredential(account, key), {
    retryOptions: { maxTries: 1 },
  });
  const container = client.getContainerClient(containerName);
  try {
    await container.create();
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  return {
    store: new AzureBlobStore({
      mode: 'azurite',
      endpoint,
      account,
      key,
      container: containerName,
    }),
    container,
    close: async () => {
      try {
        await container.delete();
      } finally {
        await runtime.stop();
      }
    },
  };
}
