import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { CopilotService } from '../src/server/copilot/service.js';
import { TokenVault } from '../src/server/copilot/secrets.js';
import type { DeviceGrant, DeviceResult } from '../src/server/copilot/provider.js';
import { testDatabase } from './helpers/database.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(async () => {
  await db?.close();
});
const vault = new TokenVault(randomBytes(32).toString('base64'));
function fixture() {
  let time = Date.now();
  const owner = { tenantId: randomUUID(), objectId: randomUUID() };
  const provider = {
    start: vi.fn(async (): Promise<DeviceGrant> => ({
      deviceCode: 'synthetic-device-secret',
      userCode: 'TEST-CODE',
      expiresIn: 900,
      interval: 5,
    })),
    poll: vi.fn(async (): Promise<DeviceResult> => ({ type: 'pending' })),
  };
  const service = new CopilotService({ pool: db.pool, secrets: vault, provider, now: () => time });
  return {
    owner,
    service,
    provider,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
async function cleared(id: string, state: string) {
  const result = await db.pool.query(
    'SELECT state,device_code,user_code,lease_id,lease_until FROM copilot_attempts WHERE id=$1',
    [id],
  );
  expect(result.rows).toEqual([
    {
      state,
      device_code: null,
      user_code: null,
      lease_id: null,
      lease_until: null,
    },
  ]);
}
async function connection(owner: { tenantId: string; objectId: string }) {
  const result = await db.pool.query<{
    connection_id: string | null;
    access_token: string | null;
    token_expires_at: Date | null;
  }>(
    'SELECT connection_id,access_token,token_expires_at FROM copilot_owners WHERE tenant_id=$1 AND object_id=$2',
    [owner.tenantId, owner.objectId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

it('characterizes terminal secret deletion, fresh replacement binding and fail-closed status reads', async () => {
  for (const action of [
    'cancel',
    'disconnect',
    'denied',
    'expired',
    'approved',
    'supersede',
  ] as const) {
    const f = fixture();
    const attempt = await f.service.start(f.owner);
    if (action === 'cancel') await f.service.cancel(f.owner, attempt.id);
    else if (action === 'disconnect') await f.service.disconnect(f.owner);
    else if (action === 'expired') {
      f.advance(900000);
      await f.service.status(f.owner);
    } else if (action === 'supersede') {
      f.advance(30000);
      await f.service.start(f.owner);
    } else {
      f.advance(5000);
      f.provider.poll.mockResolvedValueOnce(
        action === 'approved' ? { type: 'approved', token: 'first-token' } : { type: 'denied' },
      );
      await f.service.poll(f.owner, attempt.id);
    }
    await cleared(
      attempt.id,
      ['cancel', 'disconnect', 'supersede'].includes(action) ? 'cancelled' : action,
    );
    if (action === 'disconnect') {
      expect(await connection(f.owner)).toEqual({
        connection_id: null,
        access_token: null,
        token_expires_at: null,
      });
    }
    if (action !== 'approved') continue;
    const first = await connection(f.owner);
    f.advance(30000);
    const secondAttempt = await f.service.start(f.owner);
    expect(await f.service.credential(f.owner)).toBe('first-token');
    f.advance(5000);
    f.provider.poll.mockResolvedValueOnce({ type: 'approved', token: 'second-token' });
    await f.service.poll(f.owner, secondAttempt.id);
    const second = await connection(f.owner);
    expect(second.connection_id).not.toBe(first.connection_id);
    expect(second.access_token).not.toBe(first.access_token);
    expect(await f.service.credential(f.owner)).toBe('second-token');
    expect(() =>
      vault.open(f.owner, second.connection_id!, 'access-token', first.access_token!),
    ).toThrow();
    await db.pool.query(
      'UPDATE copilot_owners SET access_token=$3 WHERE tenant_id=$1 AND object_id=$2',
      [f.owner.tenantId, f.owner.objectId, first.access_token],
    );
    await expect(f.service.status(f.owner)).rejects.toMatchObject({ status: 503 });
    expect((await connection(f.owner)).access_token).toBe(first.access_token);
  }
});

it('characterizes simultaneous starts, disconnect during start and expiry during a leased poll', async () => {
  const f = fixture();
  let finish!: (grant: DeviceGrant) => void;
  f.provider.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const starting = f.service.start(f.owner);
  await vi.waitFor(() => expect(f.provider.start).toHaveBeenCalledOnce());
  await expect(f.service.start(f.owner)).rejects.toMatchObject({ status: 429 });
  expect(f.provider.start).toHaveBeenCalledOnce();
  await f.service.disconnect(f.owner);
  finish({ deviceCode: 'late-start-secret', userCode: 'LATE-CODE', expiresIn: 900, interval: 5 });
  const cancelled = await starting;
  expect(cancelled.state).toBe('cancelled');
  await cleared(cancelled.id, 'cancelled');
  await expect(f.service.credential(f.owner)).rejects.toMatchObject({ status: 409 });
  f.advance(30000);
  f.provider.start.mockResolvedValueOnce({
    deviceCode: 'short-grant',
    userCode: 'TEST-CODE',
    expiresIn: 6,
    interval: 5,
  });
  const attempt = await f.service.start(f.owner);
  f.advance(5000);
  let complete!: (result: DeviceResult) => void;
  f.provider.poll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const poll = f.service.poll(f.owner, attempt.id);
  await vi.waitFor(() => expect(f.provider.poll).toHaveBeenCalledOnce());
  f.advance(1000);
  complete({ type: 'approved', token: 'late-expired-token' });
  await expect(poll).resolves.toMatchObject({ state: 'expired' });
  await cleared(attempt.id, 'expired');
  await expect(f.service.credential(f.owner)).rejects.toMatchObject({ status: 409 });
});
