import { GenericContainer, Wait } from 'testcontainers';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { migrate } from '../../scripts/migrate.js';

export async function testDatabase() {
  const password = randomUUID();
  const builder = new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: password, POSTGRES_DB: 'test' })
    .withResourcesQuota({ memory: 512 * 1024 * 1024, cpu: 1 })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2));
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No isolated database port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const container = await (
    process.platform === 'linux'
      ? builder
          .withNetworkMode('host')
          .withCommand(['postgres', '-c', 'listen_addresses=127.0.0.1', '-c', `port=${port}`])
      : builder.withExposedPorts(5432)
  ).start();
  const pool = new Pool({
    host: process.platform === 'linux' ? '127.0.0.1' : container.getHost(),
    port: process.platform === 'linux' ? port : container.getMappedPort(5432),
    user: 'test',
    password,
    database: 'test',
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const clients = new Set<PoolClient>();
  pool.on('connect', (client) => {
    clients.add(client);
    client.once('end', () => clients.delete(client));
  });
  const closePool = async () => {
    await pool.end();
    await Promise.all(
      [...clients].map((client) => new Promise<void>((resolve) => client.once('end', resolve))),
    );
  };
  try {
    await migrate(pool);
  } catch (error) {
    await closePool();
    await container.stop();
    throw error;
  }
  return {
    pool,
    close: async () => {
      await closePool();
      await container.stop();
    },
  };
}
