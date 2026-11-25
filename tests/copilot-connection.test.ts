import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { readConfig, publicConfig } from '../src/server/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { CopilotService } from '../src/server/copilot/service.js';
import { TokenVault } from '../src/server/copilot/secrets.js';
import { GitHubDeviceProvider } from '../src/server/copilot/provider.js';
import type { DeviceProvider, DeviceResult } from '../src/server/copilot/provider.js';
import { CopilotError } from '../src/server/copilot/errors.js';
import { copilotTransition } from '../src/shared/copilot.js';
import type {
  CopilotAttempt,
  CopilotEvent,
  CopilotState,
  CopilotStatus,
} from '../src/shared/copilot.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';
import { testDatabase } from './helpers/database.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let identity: Awaited<ReturnType<typeof identityFixture>>;
beforeAll(async () => {
  db = await testDatabase();
  identity = await identityFixture();
});
afterAll(async () => {
  await db?.close();
});
const owner = { tenantId: config.tenantId, objectId: alice };
const key = randomBytes(32).toString('base64');
async function fixture() {
  let time = Date.now();
  const provider: DeviceProvider = {
    start: vi.fn(async () => ({
      deviceCode: 'synthetic-device-secret',
      userCode: 'TEST-CODE',
      expiresIn: 900,
      interval: 5,
    })),
    poll: vi.fn(async (): Promise<DeviceResult> => ({ type: 'pending' })),
  };
  const service = new CopilotService({
    pool: db.pool,
    provider,
    secrets: new TokenVault(key),
    now: () => time,
  });
  const options = {
    config,
    projects: new ProjectRepository(db.pool),
    verifyToken: identity.verify,
    copilot: service,
  };
  const app = createApp(options);
  const token = await identity.sign();
  const request = async (path = '', method = 'GET', bearer = token) =>
    app.request(`/api/settings/copilot${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
    });
  return {
    provider,
    service,
    app,
    request,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
async function attempt(response: Response): Promise<CopilotAttempt> {
  expect(response.status).toBe(201);
  return (await response.json()) as CopilotAttempt;
}

/** @id TEST-CON-002 @verifies REQ-CON-002 */
it('TEST-CON-002 exhausts transition cells and fences concurrent, terminal, stale and expired polls', async () => {
  const expected: Partial<Record<CopilotState, Partial<Record<CopilotEvent, CopilotState>>>> = {
    starting: {
      device_ready: 'pending',
      provider_error: 'failed',
      deadline: 'failed',
      cancel: 'cancelled',
      supersede: 'cancelled',
      disconnect: 'cancelled',
    },
    pending: {
      authorization_pending: 'pending',
      slow_down: 'pending',
      transport_error: 'pending',
      protocol_error: 'pending',
      access_token: 'approved',
      access_denied: 'denied',
      expired_token: 'expired',
      provider_error: 'failed',
      deadline: 'expired',
      cancel: 'cancelled',
      supersede: 'cancelled',
      disconnect: 'cancelled',
    },
  };
  const states: CopilotState[] = [
    'starting',
    'pending',
    'approved',
    'denied',
    'expired',
    'cancelled',
    'failed',
  ];
  const events: CopilotEvent[] = [
    'device_ready',
    'provider_error',
    'deadline',
    'authorization_pending',
    'slow_down',
    'transport_error',
    'protocol_error',
    'access_token',
    'access_denied',
    'expired_token',
    'cancel',
    'supersede',
    'disconnect',
  ];
  for (const state of states)
    for (const event of events)
      expect(copilotTransition(state, event), `${state}/${event}`).toBe(
        expected[state]?.[event] ?? null,
      );
  const f = await fixture();
  let a = await attempt(await f.request('/attempts', 'POST'));
  expect(a.state).toBe('pending');
  expect(a.userCode).toBe('TEST-CODE');
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    error: { code: 'COPILOT_RATE_LIMITED' },
  });
  expect(f.provider.poll).not.toHaveBeenCalled();
  f.advance(5000);
  let release!: (result: DeviceResult) => void;
  vi.mocked(f.provider.poll).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.request(`/attempts/${a.id}/poll`, 'POST');
  await vi.waitFor(() => expect(f.provider.poll).toHaveBeenCalledOnce());
  expect((await f.request(`/attempts/${a.id}/poll`, 'POST')).status).toBe(429);
  expect((await f.request('', 'DELETE')).status).toBe(204);
  release({ type: 'approved', token: 'late-secret-must-not-bind' });
  expect(await (await first).json()).toMatchObject({ state: 'cancelled' });
  await expect(f.service.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  f.advance(30000);
  a = await attempt(await f.request('/attempts', 'POST'));
  f.advance(5000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({ type: 'slow_down', interval: 11 });
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    state: 'pending',
  });
  f.advance(10000);
  const early = await f.request(`/attempts/${a.id}/poll`, 'POST');
  expect(early.status).toBe(429);
  expect(early.headers.get('Retry-After')).toBe('1');
  f.advance(1000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({ type: 'denied' });
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    state: 'denied',
  });
  const calls = vi.mocked(f.provider.poll).mock.calls.length;
  await f.request(`/attempts/${a.id}/poll`, 'POST');
  expect(f.provider.poll).toHaveBeenCalledTimes(calls);
  f.advance(30000);
  a = await attempt(await f.request('/attempts', 'POST'));
  f.advance(901000);
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    state: 'expired',
  });
  expect(f.provider.poll).toHaveBeenCalledTimes(calls);
  f.advance(30000);
  a = await attempt(await f.request('/attempts', 'POST'));
  f.advance(30000);
  const replacement = await attempt(await f.request('/attempts', 'POST'));
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    state: 'cancelled',
  });
  f.advance(5000);
  let stale!: (result: DeviceResult) => void;
  vi.mocked(f.provider.poll).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        stale = resolve;
      }),
  );
  const abandoned = f.request(`/attempts/${replacement.id}/poll`, 'POST');
  await vi.waitFor(() => expect(f.provider.poll).toHaveBeenCalledTimes(calls + 1));
  f.advance(16000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({ type: 'pending' });
  expect((await f.request(`/attempts/${replacement.id}/poll`, 'POST')).status).toBe(200);
  stale({ type: 'approved', token: 'stale-lease-secret' });
  expect(await (await abandoned).json()).toMatchObject({ state: 'pending' });
  await expect(f.service.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  f.advance(30000);
  let finishStart!: (grant: Awaited<ReturnType<DeviceProvider['start']>>) => void;
  const startCount = vi.mocked(f.provider.start).mock.calls.length;
  vi.mocked(f.provider.start).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const interrupted = f.request('/attempts', 'POST');
  await vi.waitFor(() => expect(f.provider.start).toHaveBeenCalledTimes(startCount + 1));
  f.advance(16000);
  expect(((await (await f.request()).json()) as CopilotStatus).attempt?.state).toBe('failed');
  finishStart({
    deviceCode: 'late-start-secret',
    userCode: 'LATE-CODE',
    expiresIn: 900,
    interval: 5,
  });
  expect(await (await interrupted).json()).toMatchObject({ state: 'failed' });
});

/** @id TEST-CON-003 @verifies REQ-CON-002 */
it('TEST-CON-003 sends fixed GitHub device requests, validates replies and recovers provider/lease failures', async () => {
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(
    Response.json({
      device_code: 'synthetic-device-secret',
      user_code: 'TEST-CODE',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }),
  );
  const provider = new GitHubDeviceProvider('synthetic-client', fetcher);
  await expect(provider.start()).resolves.toMatchObject({
    deviceCode: 'synthetic-device-secret',
    interval: 5,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: expect.objectContaining({ Accept: 'application/json' }),
  });
  const body = fetcher.mock.calls[0]?.[1]?.body;
  expect(body).toBeInstanceOf(URLSearchParams);
  expect(String(body)).toContain('scope=read%3Auser');
  for (const [error, type] of [
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
    ['incorrect_device_code', 'failed'],
  ] as const) {
    fetcher.mockResolvedValueOnce(Response.json({ error, interval: 10 }));
    await expect(provider.poll('synthetic-device-secret')).resolves.toMatchObject({ type });
  }
  expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain(
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
  );
  for (const response of [
    Response.json({ access_token: '' }),
    Response.json({ error: 'unknown-error' }),
    Response.json({ error: 'authorization_pending' }, { status: 401 }),
    Response.json(
      { access_token: 'synthetic-access-secret', token_type: 'bearer' },
      { headers: { 'Retry-After': String(Number.MAX_SAFE_INTEGER) } },
    ),
    new Response('bad json'),
    new Response('x'.repeat(16385)),
  ]) {
    fetcher.mockResolvedValueOnce(response);
    await expect(provider.poll('synthetic-device-secret')).rejects.toMatchObject({ status: 502 });
  }
  for (const response of [
    Response.json({
      device_code: 'code',
      user_code: 'TEST-CODE',
      verification_uri: 'https://attacker.invalid',
      expires_in: 900,
      interval: 5,
    }),
    Response.json({
      device_code: 'code',
      user_code: 'TEST-CODE',
      verification_uri: 'https://github.com/login/device',
      expires_in: -1,
      interval: 5,
    }),
  ]) {
    fetcher.mockResolvedValueOnce(response);
    await expect(provider.start()).rejects.toMatchObject({ status: 502 });
  }
  const f = await fixture();
  f.advance(2000000);
  const a = await attempt(await f.request('/attempts', 'POST'));
  f.advance(5000);
  vi.mocked(f.provider.poll).mockRejectedValueOnce(
    new CopilotError(502, 'COPILOT_PROVIDER_ERROR', 'Provider unavailable.'),
  );
  expect((await f.request(`/attempts/${a.id}/poll`, 'POST')).status).toBe(502);
  expect(((await (await f.request()).json()) as CopilotStatus).attempt?.state).toBe('pending');
  expect((await f.request(`/attempts/${a.id}/poll`, 'POST')).status).toBe(429);
  f.advance(10000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({
    type: 'approved',
    token: 'synthetic-access-secret',
    expiresIn: 60,
  });
  expect(await (await f.request(`/attempts/${a.id}/poll`, 'POST')).json()).toMatchObject({
    state: 'approved',
  });
  expect(await f.service.credential(owner)).toBe('synthetic-access-secret');
  const revived = new CopilotService({
    pool: db.pool,
    provider: f.provider,
    secrets: new TokenVault(key),
    now: () => Date.now() + 2020000,
  });
  expect(await revived.credential(owner)).toBe('synthetic-access-secret');
  const fresh = new CopilotService({
    pool: db.pool,
    provider: f.provider,
    secrets: new TokenVault(key),
    now: () => Date.now() + 2100000,
  });
  await expect(fresh.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  f.advance(30000);
  const delayed = await attempt(await f.request('/attempts', 'POST'));
  f.advance(5000);
  vi.mocked(f.provider.poll).mockImplementationOnce(async () => {
    f.advance(10000);
    return { type: 'approved', token: 'short-lived-secret', expiresIn: 1 };
  });
  await f.request(`/attempts/${delayed.id}/poll`, 'POST');
  await expect(f.service.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
});

/** @id TEST-CON-004 @verifies REQ-CON-003 */
it('TEST-CON-004 isolates tenant/object identities, unknown IDs, and never uses ambient credentials', async () => {
  const f = await fixture();
  f.advance(4000000);
  const a = await attempt(await f.request('/attempts', 'POST'));
  const foreign = await identity.sign({ oid: bob });
  for (const method of ['POST', 'DELETE']) {
    const suffix = method === 'POST' ? '/poll' : '';
    const responses = [];
    for (const id of [a.id, randomUUID(), 'invalid-id']) {
      const response = await f.request(`/attempts/${id}${suffix}`, method, foreign);
      expect(response.status).toBe(404);
      const json = (await response.json()) as { error: { code: string; message: string } };
      responses.push({ code: json.error.code, message: json.error.message });
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
  }
  expect((await f.app.request('/api/settings/copilot')).status).toBe(401);
  await expect(f.service.credential({ tenantId: bob, objectId: alice })).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-ambient-token');
  try {
    await expect(
      f.service.credential({ tenantId: config.tenantId, objectId: bob }),
    ).rejects.toMatchObject({ code: 'COPILOT_CONNECTION_REQUIRED' });
  } finally {
    vi.unstubAllEnvs();
  }
});

/** @id TEST-CON-005 @verifies REQ-CON-004 */
it('TEST-CON-005 fails closed on config/tampering, hides secrets, and disconnects atomically', async () => {
  const env = {
    ENTRA_TENANT_ID: config.tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    PUBLIC_ORIGIN: config.publicOrigin,
    DATABASE_URL: config.databaseUrl,
  };
  expect(() => readConfig({ ...env, GITHUB_OAUTH_CLIENT_ID: 'synthetic-client' })).toThrow();
  expect(() => readConfig({ ...env, COPILOT_TOKEN_ENCRYPTION_KEY: key })).toThrow();
  expect(() =>
    readConfig({
      ...env,
      GITHUB_OAUTH_CLIENT_ID: 'synthetic-client',
      COPILOT_TOKEN_ENCRYPTION_KEY: 'invalid',
    }),
  ).toThrow();
  const valid = readConfig({
    ...env,
    GITHUB_OAUTH_CLIENT_ID: 'synthetic-client',
    COPILOT_TOKEN_ENCRYPTION_KEY: key,
  });
  expect(Object.keys(publicConfig(valid))).toHaveLength(5);
  expect(JSON.stringify(publicConfig(valid))).not.toContain(key);
  const vault = new TokenVault(key);
  const id = randomUUID();
  const sealed = vault.seal(owner, id, 'access-token', 'synthetic-access-secret');
  expect(sealed).not.toContain('synthetic-access-secret');
  expect(vault.open(owner, id, 'access-token', sealed)).toBe('synthetic-access-secret');
  for (const [principal, record, purpose, cipher] of [
    [{ ...owner, objectId: bob }, id, 'access-token', sealed],
    [owner, randomUUID(), 'access-token', sealed],
    [owner, id, 'device-code', sealed],
    [owner, id, 'access-token', sealed.slice(0, -4) + 'AAAA'],
  ] as const)
    expect(() => vault.open(principal, record, purpose, cipher)).toThrow(CopilotError);
  const f = await fixture();
  f.advance(6000000);
  const a = await attempt(await f.request('/attempts', 'POST'));
  f.advance(5000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({
    type: 'approved',
    token: 'synthetic-access-secret',
  });
  await f.request(`/attempts/${a.id}/poll`, 'POST');
  const status = await f.request();
  expect(status.headers.get('Cache-Control')).toBe('no-store');
  const text = await status.text();
  expect(text).toContain('"connected"');
  for (const secret of ['synthetic-device-secret', 'synthetic-access-secret', key])
    expect(text).not.toContain(secret);
  await expect(f.service.revoke(owner, 'synthetic-access-secret')).resolves.toBe(true);
  expect(await (await f.request()).json()).toMatchObject({ status: 'reconnect_required' });
  await expect(f.service.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  f.advance(30000);
  const replacement = await attempt(await f.request('/attempts', 'POST'));
  f.advance(5000);
  vi.mocked(f.provider.poll).mockResolvedValueOnce({
    type: 'approved',
    token: 'replacement-access-secret',
  });
  await f.request(`/attempts/${replacement.id}/poll`, 'POST');
  await expect(f.service.revoke(owner, 'synthetic-access-secret')).resolves.toBe(false);
  expect(await f.service.credential(owner)).toBe('replacement-access-secret');
  const rows = await db.pool.query(
    'SELECT access_token FROM copilot_owners WHERE tenant_id=$1 AND object_id=$2',
    [owner.tenantId, owner.objectId],
  );
  expect(JSON.stringify(rows.rows)).not.toContain('synthetic-access-secret');
  expect((await f.request('', 'DELETE')).status).toBe(204);
  await expect(f.service.credential(owner)).rejects.toMatchObject({
    code: 'COPILOT_CONNECTION_REQUIRED',
  });
  const disabled = createApp({
    config,
    projects: new ProjectRepository(db.pool),
    verifyToken: identity.verify,
  });
  expect(
    await (
      await disabled.request('/api/settings/copilot', {
        headers: { Authorization: `Bearer ${await identity.sign()}` },
      })
    ).json(),
  ).toMatchObject({ configured: false });
});
