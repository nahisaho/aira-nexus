import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { publicConfig, readConfig } from '../src/server/config.js';
import { ProjectPinsRepository } from '../src/server/project-pins.js';
import { ProjectRepository } from '../src/server/projects.js';
import type { ApiFailure, Principal } from '../src/shared/contracts.js';
import { testDatabase } from './helpers/database.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let identity: Awaited<ReturnType<typeof identityFixture>>;
let token: string;
let bobToken: string;
const owner: Principal = { tenantId: config.tenantId, objectId: alice };
const otherObject: Principal = { tenantId: config.tenantId, objectId: bob };
const otherTenant: Principal = { tenantId: bob, objectId: alice };
const headers = (bearer = token) => ({
  Authorization: `Bearer ${bearer}`,
  'Content-Type': 'application/json',
});

function application(
  enabled: boolean | null = true,
  repository: ProjectPinsRepository | null = new ProjectPinsRepository(database.pool),
) {
  const options = {
    config: { ...config, ...(enabled === null ? {} : { projectPinsEnabled: enabled }) },
    verifyToken: identity.verify,
    projects: new ProjectRepository(database.pool),
    ...(repository === null ? {} : { projectPins: repository }),
  };
  return createApp(options);
}

type App = ReturnType<typeof createApp>;
const get = (app: App, bearer = token) =>
  app.request('/api/project-pins', { headers: headers(bearer) });
const put = (app: App, id: string, pinned: boolean, bearer = token) =>
  app.request(`/api/projects/${id}/pin`, {
    method: 'PUT',
    headers: headers(bearer),
    body: JSON.stringify({ pinned }),
  });
async function pins(response: Response, expected: string[]) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ projectIds: expected });
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as ApiFailure;
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(response.headers.get('X-Request-ID'));
  expect(body.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
  return body.error;
}

beforeAll(async () => {
  database = await testDatabase();
  identity = await identityFixture();
  token = await identity.sign();
  bobToken = await identity.sign({ oid: bob });
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/** @id TEST-SID-001 @verifies REQ-SID-001 */
it('TEST-SID-001 persists serialized owner-scoped desired pin state without project changes', async () => {
  const app = application();
  // The missing route must be an assertion Red, before touching the future table.
  await pins(await get(app), []);
  const { pool } = database;
  const projects = new ProjectRepository(pool);
  const repository = new ProjectPinsRepository(pool);
  const first = await projects.create(owner, 'unchanged first');
  const second = await projects.create(owner, 'unchanged second');
  const foreign = await projects.create(otherObject, 'other object');
  const tenantForeign = await projects.create(otherTenant, 'other tenant');
  const missing = randomUUID();

  for (const [current, desired] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    expect(await repository.set(owner, first.id, current)).toBe(true);
    for (let repeat = 0; repeat < 2; repeat++) {
      await pins(await put(app, first.id, desired), desired ? [first.id] : []);
      expect(await new ProjectPinsRepository(pool).list(owner)).toEqual(desired ? [first.id] : []);
    }
  }

  const newSession = await identity.sign();
  await pins(await get(application(), newSession), [first.id]);
  expect(await repository.set(otherObject, foreign.id, true)).toBe(true);
  expect(await repository.set(otherTenant, tenantForeign.id, true)).toBe(true);
  expect(await repository.list(otherObject)).toEqual([foreign.id]);
  expect(await repository.list(otherTenant)).toEqual([tenantForeign.id]);
  await pins(await get(app, bobToken), [foreign.id]);
  await pins(await get(app), [first.id]);
  for (const principal of [otherObject, otherTenant]) {
    for (const desired of [false, true]) {
      expect(await repository.set(principal, first.id, desired)).toBe(false);
    }
  }
  for (const id of [foreign.id, tenantForeign.id, missing, 'not-a-uuid']) {
    for (const desired of [false, true]) {
      const error = await failure(await put(app, id, desired), 404, 'NOT_FOUND');
      expect(error.message).toBe('Project not found.');
    }
  }
  expect(await repository.set(owner, missing, true)).toBe(false);
  await pins(await get(app), [first.id]);
  expect(await repository.list(otherObject)).toEqual([foreign.id]);
  expect(await repository.list(otherTenant)).toEqual([tenantForeign.id]);

  await pins(await put(app, first.id, false), []);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => put(app, first.id, true)));
  for (const response of concurrent) await pins(response, [first.id]);
  expect(
    (
      await pool.query('SELECT count(*)::int AS count FROM project_pins WHERE project_id=$1', [
        first.id,
      ])
    ).rows,
  ).toEqual([{ count: 1 }]);
  const locker = await pool.connect();
  let removing: Promise<boolean> | undefined;
  try {
    await locker.query('BEGIN');
    const locked = await locker.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid FROM projects WHERE id=$1 FOR UPDATE',
      [first.id],
    );
    let settled = false;
    removing = repository.set(owner, first.id, false);
    void removing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!settled && !blocked && Date.now() < deadline) {
      const observed = await pool.query<{ blocked: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
        [locked.rows[0]!.pid],
      );
      blocked = observed.rows[0]!.blocked;
    }
    expect(blocked, 'unpin must wait for the owning project row lock').toBe(true);
    expect(settled).toBe(false);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    if (removing) await removing;
  }
  expect(await removing).toBe(true);
  expect(await repository.set(owner, first.id, true)).toBe(true);
  expect(await repository.set(owner, second.id, true)).toBe(true);
  await pool.query(
    `UPDATE project_pins SET pinned_at=CASE WHEN project_id=$1
      THEN '2026-01-01T00:00:00Z'::timestamptz ELSE '2026-01-02T00:00:00Z'::timestamptz END
      WHERE project_id=ANY($2::uuid[])`,
    [first.id, [first.id, second.id]],
  );
  await pins(await get(app), [second.id, first.id]);
  await pool.query(
    "UPDATE project_pins SET pinned_at='2026-01-03T00:00:00Z' WHERE project_id=ANY($1::uuid[])",
    [[first.id, second.id]],
  );
  const tieOrder = [first.id, second.id].sort();
  await pins(await get(app), tieOrder);
  const beforeRepeat = await pool.query(
    'SELECT project_id, pinned_at FROM project_pins WHERE project_id=ANY($1::uuid[]) ORDER BY project_id',
    [[first.id, second.id]],
  );
  await pins(await put(app, first.id, true), tieOrder);
  expect(
    (
      await pool.query(
        'SELECT project_id, pinned_at FROM project_pins WHERE project_id=ANY($1::uuid[]) ORDER BY project_id',
        [[first.id, second.id]],
      )
    ).rows,
  ).toEqual(beforeRepeat.rows);
  expect(await projects.get(owner, first.id)).toEqual(first);
  expect(await projects.get(owner, second.id)).toEqual(second);
  expect(await projects.get(otherObject, foreign.id)).toEqual(foreign);
  expect(await projects.get(otherTenant, tenantForeign.id)).toEqual(tenantForeign);
  expect(await repository.set(owner, first.id, false)).toBe(true);
  expect(await repository.set(owner, second.id, false)).toBe(true);
}, 60_000);

/** @id TEST-SID-002 @verifies REQ-SID-002 */
it('TEST-SID-002 authenticates, gates, validates bounded JSON and never disguises pin failures', async () => {
  const disabled = application(false);
  // This must fail on the current 404, not on absent-schema setup.
  await failure(await get(disabled), 503, 'PROJECT_PINS_UNAVAILABLE');
  const { pool } = database;
  const projects = new ProjectRepository(pool);
  const own = await projects.create(owner, 'input control');
  const foreign = await projects.create(otherObject, 'input foreign');
  const app = application();
  const env = {
    ENTRA_TENANT_ID: config.tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    PUBLIC_ORIGIN: config.publicOrigin,
    DATABASE_URL: config.databaseUrl,
  };
  const legacy = readConfig(env);
  expect(legacy).not.toHaveProperty('projectPinsEnabled');
  expect(readConfig({ ...env, PROJECT_PINS_ENABLED: 'false' })).toEqual(legacy);
  expect(readConfig({ ...env, PROJECT_PINS_ENABLED: 'true' })).toEqual({
    ...legacy,
    projectPinsEnabled: true,
  });
  for (const value of ['', 'TRUE', 'False', '1', '0', ' true', 'false ']) {
    expect(() => readConfig({ ...env, PROJECT_PINS_ENABLED: value })).toThrow();
  }
  for (const target of [disabled, application(null), application(true), application(true, null)]) {
    await failure(await target.request('/api/project-pins'), 401, 'UNAUTHENTICATED');
    await failure(
      await target.request(`/api/projects/${own.id}/pin`, { method: 'PUT', body: 'invalid' }),
      401,
      'UNAUTHENTICATED',
    );
    expect(await (await target.request('/api/config')).json()).toEqual(publicConfig(config));
  }

  const repository = new ProjectPinsRepository(pool);
  const list = vi.spyOn(repository, 'list');
  const set = vi.spyOn(repository, 'set');
  // A renamed table makes accidental queries fail even if their result is discarded.
  await pool.query('ALTER TABLE project_pins RENAME TO project_pins_unavailable');
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const target of [
      application(false, repository),
      application(null, repository),
      application(true, null),
    ]) {
      await failure(await get(target), 503, 'PROJECT_PINS_UNAVAILABLE');
      await failure(await put(target, own.id, true), 503, 'PROJECT_PINS_UNAVAILABLE');
    }
    expect(list).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    const error = await failure(await get(app), 500, 'INTERNAL_ERROR');
    expect(error.message).toBe('The request could not be completed.');
    expect(logs.mock.calls.flat().join(' ')).toContain(error.requestId);
    const writeError = await failure(await put(app, own.id, true), 500, 'INTERNAL_ERROR');
    expect(writeError.message).toBe('The request could not be completed.');
    expect(logs.mock.calls.flat().join(' ')).toContain(writeError.requestId);
    expect(logs.mock.calls.flat().join(' ')).not.toMatch(
      /SELECT|INSERT|DELETE|project_pins|postgresql:|password|token/i,
    );
  } finally {
    logs.mockRestore();
    list.mockRestore();
    set.mockRestore();
    await pool.query('ALTER TABLE project_pins_unavailable RENAME TO project_pins');
  }

  await pins(await get(app), []);
  for (const body of [
    '{}',
    '{"pinned":null}',
    '{"pinned":"true"}',
    '{"pinned":1}',
    '{"pinned":true,"owner":"other"}',
    '{"pinned":true,"projectIds":[]}',
    '[]',
    'null',
    'true',
    '{"pinned":',
  ]) {
    await failure(
      await app.request(`/api/projects/${own.id}/pin`, {
        method: 'PUT',
        headers: headers(),
        body,
      }),
      400,
      'INVALID_INPUT',
    );
  }
  for (const contentType of ['text/plain', '']) {
    await failure(
      await app.request(`/api/projects/${own.id}/pin`, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': contentType },
        body: '{"pinned":true}',
      }),
      400,
      'INVALID_INPUT',
    );
  }
  await failure(
    await app.request(`/api/projects/${own.id}/pin`, {
      method: 'PUT',
      headers: headers(),
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    }),
    400,
    'INVALID_INPUT',
  );
  for (const length of [undefined, '10']) {
    await failure(
      await app.request(`/api/projects/${own.id}/pin`, {
        method: 'PUT',
        headers: { ...headers(), ...(length === undefined ? {} : { 'Content-Length': length }) },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`{"pinned":true}${' '.repeat(16384)}`));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
      413,
      'BODY_TOO_LARGE',
    );
  }
  for (const id of [foreign.id, randomUUID(), 'invalid']) {
    for (const body of ['invalid', 'x'.repeat(17000)]) {
      const error = await failure(
        await app.request(`/api/projects/${id}/pin`, {
          method: 'PUT',
          headers: { ...headers(), 'Content-Type': 'text/plain' },
          body,
        }),
        404,
        'NOT_FOUND',
      );
      expect(error.message).toBe('Project not found.');
    }
  }
  await pins(await get(app), []);
  // Exact byte limit is accepted; only bytes beyond the limit are rejected.
  const valid = '{"pinned":true}';
  const accepted = await app.request(`/api/projects/${own.id}/pin`, {
    method: 'PUT',
    headers: headers(),
    body: valid.padEnd(16384, ' '),
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ projectIds: [own.id] });
  await pins(await get(app), [own.id]);
  await pins(await put(app, own.id, false), []);

  const marker = 'synthetic-secret SELECT project_pins postgresql://private/password';
  await pool.query(`CREATE FUNCTION reject_test_pin() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '${marker}'; END $$`);
  await pool.query(
    'CREATE TRIGGER reject_test_pin BEFORE INSERT ON project_pins FOR EACH ROW EXECUTE FUNCTION reject_test_pin()',
  );
  const writeLogs = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const error = await failure(await put(app, own.id, true), 500, 'INTERNAL_ERROR');
    expect(error.message).toBe('The request could not be completed.');
    expect(writeLogs.mock.calls.flat().join(' ')).toContain(error.requestId);
    expect(JSON.stringify(error) + writeLogs.mock.calls.flat().join(' ')).not.toMatch(
      /synthetic-secret|SELECT|project_pins|postgresql:|password/i,
    );
    expect(await new ProjectPinsRepository(pool).list(owner)).not.toContain(own.id);
    expect(await projects.get(owner, own.id)).toEqual(own);
  } finally {
    writeLogs.mockRestore();
    await pool.query('DROP TRIGGER reject_test_pin ON project_pins');
    await pool.query('DROP FUNCTION reject_test_pin()');
  }
}, 60_000);
