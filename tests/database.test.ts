import { GenericContainer } from 'testcontainers';
import { expect, it, vi } from 'vitest';
import { testDatabase } from './helpers/database.js';

it('closes all PostgreSQL clients before stopping the test database', async () => {
  let ended = 0;
  let endedAtStop = -1;
  const start = GenericContainer.prototype.start;
  const startSpy = vi.spyOn(GenericContainer.prototype, 'start').mockImplementation(async function (
    this: GenericContainer,
  ) {
    const container = await start.call(this);
    const stop = container.stop.bind(container);
    vi.spyOn(container, 'stop').mockImplementation((...args) => {
      endedAtStop = ended;
      return stop(...args);
    });
    return container;
  });
  try {
    const db = await testDatabase();
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.pool.connect()));
    for (const client of clients) {
      client.once('end', () => ended++);
      client.release();
    }
    await db.close();
    expect(endedAtStop).toBe(clients.length);
  } finally {
    startSpy.mockRestore();
  }
}, 120000);
