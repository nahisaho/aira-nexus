import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { publicConfig, readConfig } from '../src/server/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { ProjectPinsRepository } from '../src/server/project-pins.js';
import { ProjectOrderRepository } from '../src/server/project-order.js';
import type { Principal } from '../src/shared/contracts.js';
import { testDatabase } from './helpers/database.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let identity: Awaited<ReturnType<typeof identityFixture>>;
let token: string;
const owner: Principal = { tenantId: config.tenantId, objectId: alice };
const headers = (bearer = token) => ({
  Authorization: `Bearer ${bearer}`,
  'Content-Type': 'application/json',
});
function application(enabled: boolean | null = true) {
  const options = {
    config: { ...config, ...(enabled === null ? {} : { projectOrderEnabled: enabled }) },
    verifyToken: identity.verify,
    projects: new ProjectRepository(database.pool),
    projectPins: new ProjectPinsRepository(database.pool),
    projectOrder: new ProjectOrderRepository(database.pool),
  };
  return createApp(options);
}
type App = ReturnType<typeof application>;
const get = (app: App, bearer = token) =>
  app.request('/api/project-order', { headers: headers(bearer) });
const move = (
  app: App,
  group: 'pinned' | 'recent',
  projectId: string,
  beforeId: string | null,
  version: number | null,
  bearer = token,
) =>
  app.request('/api/project-order', {
    method: 'PATCH',
    headers: { ...headers(bearer), ...(version === null ? {} : { 'If-Match': `"${version}"` }) },
    body: JSON.stringify({ group, projectId, beforeId }),
  });
async function failure(response: Response, status: number, code: string | null) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    error: {
      code: code ?? expect.any(String),
      message: expect.any(String),
      requestId: response.headers.get('X-Request-ID'),
    },
  });
}
beforeAll(async () => {
  database = await testDatabase();
  identity = await identityFixture();
  token = await identity.sign();
}, 120_000);
afterAll(async () => {
  await database?.close();
});

/** @id TEST-SID-006 @verifies REQ-SID-006 */
it('TEST-SID-006 persists independent group order across connections without altering metadata or legacy pins', async () => {
  const app = application();
  expect((await get(app)).status).toBe(200);
  const projects = new ProjectRepository(database.pool);
  const pins = new ProjectPinsRepository(database.pool);
  const first = await projects.create(owner, 'rank first');
  const second = await projects.create(owner, 'rank second');
  const third = await projects.create(owner, 'rank recent');
  await pins.set(owner, first.id, true);
  await pins.set(owner, second.id, true);
  const legacy = await pins.list(owner);
  const initial = await new ProjectOrderRepository(database.pool).get(owner);
  expect(initial).toEqual({ version: 1, pinned: legacy, recent: [third.id] });
  const changed = await move(app, 'pinned', first.id, second.id, 1);
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({
    version: 2,
    pinned: [first.id, second.id],
    recent: [third.id],
  });
  expect(await (await get(application(), await identity.sign())).json()).toEqual(
    await new ProjectOrderRepository(database.pool).get(owner),
  );
  const invalid = await move(app, 'recent', first.id, third.id, 2);
  await failure(invalid, 409, null);
  expect(await pins.list(owner)).toEqual(legacy);
  for (const project of [first, second, third])
    expect(await projects.get(owner, project.id)).toEqual(project);
  expect(
    await new ProjectOrderRepository(database.pool).get({
      tenantId: bob,
      objectId: alice,
    }),
  ).toEqual({ version: 1, pinned: [], recent: [] });
});

/** @id TEST-SID-007 @verifies REQ-SID-007 */
it('TEST-SID-007 enforces manual CAS, strict anchors, owner membership and retained ranks', async () => {
  const app = application();
  expect((await get(app)).status).toBe(200);
  const projects = new ProjectRepository(database.pool);
  const pins = new ProjectPinsRepository(database.pool);
  const local: Principal = { tenantId: config.tenantId, objectId: randomUUID() };
  const localToken = await identity.sign({ oid: local.objectId });
  const a = await projects.create(local, 'A');
  const b = await projects.create(local, 'B');
  // Independent timestamps keep the default updatedAt/id total order deterministic.
  await database.pool.query(
    "UPDATE projects SET updated_at=CASE id WHEN $1::uuid THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END WHERE id=ANY($2::uuid[])",
    [a.id, [a.id, b.id]],
  );
  const foreign = await projects.create({ ...local, objectId: bob }, 'foreign OID');
  const foreignTenant = await projects.create({ ...local, tenantId: bob }, 'foreign tenant');
  const initial = await (await get(app, localToken)).json();
  expect(initial).toEqual({ version: 1, pinned: [], recent: [b.id, a.id] });
  await failure(await move(app, 'recent', a.id, b.id, null, localToken), 428, 'VERSION_REQUIRED');
  await failure(await move(app, 'recent', a.id, a.id, 99, localToken), 400, 'INVALID_INPUT');
  for (const id of [foreign.id, foreignTenant.id, randomUUID()]) {
    await failure(await move(app, 'recent', id, null, 1, localToken), 404, 'NOT_FOUND');
    await failure(await move(app, 'recent', a.id, id, 1, localToken), 404, 'NOT_FOUND');
  }
  expect(
    (
      await database.pool.query(
        'SELECT version FROM project_order_states WHERE tenant_id=$1 AND owner_oid=$2',
        [local.tenantId, local.objectId],
      )
    ).rowCount,
  ).toBe(0);
  const concurrent = await Promise.all([
    move(app, 'recent', a.id, b.id, 1, localToken),
    move(app, 'recent', b.id, a.id, 1, localToken),
  ]);
  expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
  const order = new ProjectOrderRepository(database.pool);
  const committed = await order.get(local);
  expect(committed.version).toBe(2);
  expect(await concurrent.find((response) => response.status === 200)!.json()).toEqual(committed);
  const extra = await projects.create(local, 'unrecorded anchor');
  expect((await order.get(local)).recent).toEqual([extra.id, ...committed.recent]);
  const reordered = await move(app, 'recent', a.id, extra.id, 2, localToken);
  expect(reordered.status).toBe(200);
  const beforeMembership = await order.get(local);
  await pins.set(local, a.id, true);
  expect((await order.get(local)).version).toBe(3);
  await failure(await move(app, 'recent', a.id, b.id, 3, localToken), 409, null);
  await pins.set(local, a.id, false);
  expect((await order.get(local)).recent).toEqual(beforeMembership.recent);
  await database.pool.query('UPDATE projects SET trashed_at=clock_timestamp() WHERE id=$1', [a.id]);
  await failure(await move(app, 'recent', a.id, null, 3, localToken), 404, 'NOT_FOUND');
  await database.pool.query('UPDATE projects SET trashed_at=NULL WHERE id=$1', [a.id]);
  expect((await order.get(local)).recent).toEqual(beforeMembership.recent);
  for (const body of [
    {},
    { group: 'other', projectId: a.id, beforeId: null },
    { group: 'recent', projectId: a.id, beforeId: b.id, tenantId: bob },
    { group: 'recent', projectId: 'invalid', beforeId: null },
  ]) {
    await failure(
      await app.request('/api/project-order', {
        method: 'PATCH',
        headers: { ...headers(localToken), 'If-Match': '"3"' },
        body: JSON.stringify(body),
      }),
      400,
      'INVALID_INPUT',
    );
  }
  await failure(
    await app.request('/api/project-order', {
      method: 'PATCH',
      headers: { ...headers(localToken), 'If-Match': '"3"' },
      body: JSON.stringify({ payload: 'x'.repeat(16385) }),
    }),
    413,
    'BODY_TOO_LARGE',
  );
  expect(await order.get(local)).toEqual(beforeMembership);
  for (const match of ['1', '"0"', '"2147483648"', 'W/"3"', '*']) {
    await failure(
      await app.request('/api/project-order', {
        method: 'PATCH',
        headers: { ...headers(localToken), 'If-Match': match },
        body: JSON.stringify({ group: 'recent', projectId: a.id, beforeId: b.id }),
      }),
      400,
      'INVALID_VERSION',
    );
  }
  const blocker = await database.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [a.id]);
    const queued = move(app, 'recent', a.id, b.id, 3, localToken);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const { rows } = await database.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM projects WHERE tenant_id=%'",
      );
      if (rows.length) {
        waiting = true;
        break;
      }
    }
    expect(waiting, 'order writer must be waiting behind the involved project lock').toBe(true);
    await blocker.query('INSERT INTO project_pins(project_id) VALUES($1)', [a.id]);
    await blocker.query('COMMIT');
    await failure(await queued, 409, 'VERSION_CONFLICT');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  await pins.set(local, a.id, false);
  expect(await order.get(local)).toEqual(beforeMembership);
  await pins.set(local, extra.id, true);
  expect((await move(app, 'recent', b.id, a.id, 3, localToken)).status).toBe(200);
  await pins.set(local, extra.id, false);
  expect((await order.get(local)).recent).toEqual([b.id, a.id, extra.id]);
  await database.pool.query('UPDATE projects SET trashed_at=clock_timestamp() WHERE id=$1', [a.id]);
  expect((await move(app, 'recent', extra.id, b.id, 4, localToken)).status).toBe(200);
  await database.pool.query('UPDATE projects SET trashed_at=NULL WHERE id=$1', [a.id]);
  expect((await order.get(local)).recent).toEqual([extra.id, b.id, a.id]);
  const beforeExhaustion = await order.get(local);
  await database.pool.query(
    'UPDATE project_order_states SET version=2147483647 WHERE tenant_id=$1 AND owner_oid=$2',
    [local.tenantId, local.objectId],
  );
  await failure(
    await move(app, 'recent', a.id, null, 2147483647, localToken),
    409,
    'VERSION_CONFLICT',
  );
  expect(await order.get(local)).toEqual({ ...beforeExhaustion, version: 2147483647 });
});

/** @id TEST-SID-009 @verifies REQ-SID-009 */
it('TEST-SID-009 authenticates disabled capability and fails closed for invalid flags or missing order schema', async () => {
  const enabledCapability = await application().request('/api/project-order/capabilities', {
    headers: headers(),
  });
  expect(enabledCapability.status).toBe(200);
  expect(await enabledCapability.json()).toEqual({ enabled: true });
  const disabled = application(false);
  const capability = await disabled.request('/api/project-order/capabilities', {
    headers: headers(),
  });
  expect(capability.status).toBe(200);
  expect(await capability.json()).toEqual({ enabled: false });
  for (const enabled of [false, null] as const) {
    await failure(await get(application(enabled)), 503, 'PROJECT_ORDER_UNAVAILABLE');
    const noAuth = await application(enabled).request('/api/project-order/capabilities');
    expect(noAuth.status).toBe(401);
  }
  const environment = {
    ENTRA_TENANT_ID: config.tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    DATABASE_URL: 'postgresql://test@127.0.0.1/test',
    PUBLIC_ORIGIN: config.publicOrigin,
  };
  for (const flag of [undefined, 'false']) {
    const parsed = readConfig({
      ...environment,
      ...(flag === undefined ? {} : { PROJECT_ORDER_ENABLED: flag }),
    });
    expect(Object.hasOwn(parsed, 'projectOrderEnabled')).toBe(false);
    expect(Object.hasOwn(publicConfig(parsed), 'projectOrderEnabled')).toBe(false);
  }
  const parsed = readConfig({ ...environment, PROJECT_ORDER_ENABLED: 'true' });
  expect(parsed).toHaveProperty('projectOrderEnabled', true);
  for (const flag of ['', 'TRUE', '1', 'on']) {
    expect(() => readConfig({ ...environment, PROJECT_ORDER_ENABLED: flag })).toThrow();
  }
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await database.pool.query('ALTER TABLE project_order_states RENAME TO absent_order_fixture');
    try {
      expect(
        await (
          await disabled.request('/api/project-order/capabilities', {
            headers: headers(),
          })
        ).json(),
      ).toEqual({ enabled: false });
      await failure(await get(disabled), 503, 'PROJECT_ORDER_UNAVAILABLE');
      expect(logger).not.toHaveBeenCalled();
      const broken = await application().request('/api/project-order/capabilities', {
        headers: headers(),
      });
      await failure(broken, 500, 'INTERNAL_ERROR');
      expect(logger).toHaveBeenCalled();
      const body = JSON.stringify(await (await get(application())).json());
      expect(body).not.toMatch(/relation|project_order_states|SELECT|password/i);
    } finally {
      await database.pool.query('ALTER TABLE absent_order_fixture RENAME TO project_order_states');
    }
    await database.pool.query('ALTER TABLE project_pins RENAME TO absent_pins_fixture');
    try {
      await failure(
        await application().request('/api/project-order/capabilities', {
          headers: headers(),
        }),
        500,
        'INTERNAL_ERROR',
      );
    } finally {
      await database.pool.query('ALTER TABLE absent_pins_fixture RENAME TO project_pins');
    }
  } finally {
    logger.mockRestore();
  }
});
