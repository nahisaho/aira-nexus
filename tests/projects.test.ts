import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/server/app.js';
import { ProjectRepository } from '../src/server/projects.js';
import { ProjectPinsRepository } from '../src/server/project-pins.js';
import { FileRepository } from '../src/server/files/repository.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { readConfig } from '../src/server/config.js';
import type { Project } from '../src/shared/contracts.js';
import { migrate } from '../scripts/migrate.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';

let container: StartedTestContainer;
let pool: Pool;
let fixture: Awaited<ReturnType<typeof identityFixture>>;
let aliceToken: string;
let bobToken: string;
let app: ReturnType<typeof createApp>;
let managementApp: ReturnType<typeof createApp>;
interface ManagedDetails {
  project: Project;
  description: string;
  trashedAt: string | null;
}
const owner = { tenantId: config.tenantId, objectId: alice };
const headers = (token = aliceToken) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
const create = async (name: string) =>
  app.request('/api/projects', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name }),
  });
const manage = async (
  suffix: string,
  method = 'GET',
  body?: unknown,
  version?: number,
  token = aliceToken,
) =>
  managementApp.request(`/api/project-management${suffix}`, {
    method,
    headers: {
      ...headers(token),
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function createManaged(name: string, description = ''): Promise<ManagedDetails> {
  const response = await manage('/projects', 'POST', { name, description });
  expect(response.status).toBe(201);
  return response.json();
}

beforeAll(async () => {
  const password = randomUUID();
  const postgres = new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: password, POSTGRES_DB: 'test' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2));
  let host: string;
  let port: number;
  if (process.platform === 'linux') {
    // Keep Linux integration traffic on loopback; do not change shared-host bridge/firewall rules.
    const lease = createServer();
    await new Promise<void>((resolve, reject) => {
      lease.once('error', reject);
      lease.listen(0, '127.0.0.1', resolve);
    });
    const address = lease.address();
    if (!address || typeof address === 'string')
      throw new Error('No PostgreSQL test port available.');
    port = address.port;
    await new Promise<void>((resolve, reject) =>
      lease.close((error) => (error ? reject(error) : resolve())),
    );
    container = await postgres
      .withNetworkMode('host')
      .withCommand(['postgres', '-c', 'listen_addresses=127.0.0.1', '-c', `port=${port}`])
      .start();
    host = '127.0.0.1';
  } else {
    container = await postgres.withExposedPorts(5432).start();
    host = container.getHost();
    port = container.getMappedPort(5432);
  }
  pool = new Pool({
    host,
    port,
    user: 'test',
    password,
    database: 'test',
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await migrate(pool);
  fixture = await identityFixture();
  aliceToken = await fixture.sign();
  bobToken = await fixture.sign({ oid: bob });
  app = createApp({ config, verifyToken: fixture.verify, projects: new ProjectRepository(pool) });
  const managementConfig = { ...config, projectManagementEnabled: true };
  managementApp = createApp({
    config: managementConfig,
    verifyToken: fixture.verify,
    projects: new ProjectRepository(pool),
  });
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('private project persistence', () => {
  /** @id TEST-PMG-001 @verifies REQ-PMG-001 */
  it('TEST-PMG-001 persists bounded descriptions without changing legacy DTOs or accepting owner input', async () => {
    const saved = await createManaged('  metadata  ', 'first\r\nsecond');
    expect(saved.description).toBe('first\nsecond');
    expect(saved.trashedAt).toBeNull();
    expect(saved.project.name).toBe('metadata');
    expect(Object.keys(saved).sort()).toEqual(['description', 'project', 'trashedAt']);
    expect(Object.keys(saved.project).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'updatedAt',
      'version',
    ]);
    const freshConfig = { ...config, projectManagementEnabled: true };
    const fresh = createApp({
      config: freshConfig,
      verifyToken: fixture.verify,
      projects: new ProjectRepository(pool),
    });
    expect(
      await (
        await fresh.request(`/api/project-management/projects/${saved.project.id}`, {
          headers: headers(),
        })
      ).json(),
    ).toEqual(saved);
    const defaultDescription = await manage('/projects', 'POST', { name: 'empty description' });
    expect(defaultDescription.status).toBe(201);
    expect((await defaultDescription.json()).description).toBe('');
    expect((await createManaged('supplementary boundary', '🔬'.repeat(2000))).description).toBe(
      '🔬'.repeat(2000),
    );
    expect((await createManaged('normalised boundary', '\r\n'.repeat(1500))).description).toBe(
      '\n'.repeat(1500),
    );
    const patchTarget = await createManaged('patch boundaries');
    let patchVersion = patchTarget.project.version;
    for (const description of ['🔬'.repeat(2000), '\r\n'.repeat(1500)]) {
      const patched = await manage(
        `/projects/${patchTarget.project.id}`,
        'PATCH',
        { name: 'patch boundaries', description },
        patchVersion,
      );
      expect(patched.status).toBe(200);
      const details = (await patched.json()) as ManagedDetails;
      expect(details.description).toBe(description.replace(/\r\n/g, '\n'));
      expect(details.project.version).toBe(++patchVersion);
    }
    for (const description of [
      '🔬'.repeat(2001),
      '\u0000',
      '\ud800',
      '\udc00',
      null,
      1,
      undefined,
    ]) {
      expect(
        (
          await manage(
            `/projects/${patchTarget.project.id}`,
            'PATCH',
            { name: 'patch boundaries', description },
            patchVersion,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await manage(
          `/projects/${patchTarget.project.id}`,
          'PATCH',
          { name: 'patch boundaries', description: '', ownerOid: bob },
          patchVersion,
        )
      ).status,
    ).toBe(400);
    await expect(
      new ProjectRepository(pool).createManaged(owner, 'database boundary', '🔬'.repeat(2001)),
    ).rejects.toMatchObject({ code: '23514' });
    for (const body of [
      { name: 'bad', description: '🔬'.repeat(2001) },
      { name: 'bad', description: '\u0000' },
      { name: 'bad', description: '\ud800' },
      { name: 'bad', description: '\udc00' },
      { name: 'bad', description: null },
      { name: 'bad', description: 1 },
      { name: 'bad', description: '', tenantId: bob },
    ])
      expect((await manage('/projects', 'POST', body)).status).toBe(400);
    expect(
      (
        await app.request('/api/projects', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ name: 'legacy', description: '' }),
        })
      ).status,
    ).toBe(400);
    expect(
      await (await app.request(`/api/projects/${saved.project.id}`, { headers: headers() })).json(),
    ).toEqual(saved.project);
    for (const id of [saved.project.id, randomUUID()]) {
      expect((await manage(`/projects/${id}`, 'GET', undefined, undefined, bobToken)).status).toBe(
        404,
      );
    }
    expect(
      await new ProjectRepository(pool).get({ tenantId: bob, objectId: alice }, saved.project.id),
    ).toBeUndefined();
    const oversized = await manage('/projects', 'POST', {
      name: 'big',
      description: 'x'.repeat(17000),
    });
    expect(oversized.status).toBe(413);
  });

  /** @id TEST-PMG-002 @verifies REQ-PMG-002 */
  it('TEST-PMG-002 serializes settings and reversible versioned trash without purging data', async () => {
    const saved = await createManaged('lifecycle', 'retained');
    const id = saved.project.id;
    await pool.query('INSERT INTO project_pins(project_id) VALUES($1)', [id]);
    const settings = { name: 'edited', description: 'committed' };
    for (const [target, token] of [
      [id, bobToken],
      [randomUUID(), undefined],
    ] as const) {
      for (const suffix of ['', '/trash', '/restore']) {
        const route = `/projects/${target}${suffix}`;
        const method = suffix ? 'POST' : 'PATCH';
        const body = suffix ? {} : settings;
        expect((await manage(route, method, body, undefined, token)).status).toBe(428);
        expect(
          (
            await managementApp.request(`/api/project-management${route}`, {
              method,
              headers: { ...headers(token), 'If-Match': '*' },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(400);
        expect((await manage(route, method, { ...body, unexpected: true }, 1, token)).status).toBe(
          400,
        );
        expect((await manage(route, method, body, 1, token)).status).toBe(404);
      }
    }
    expect((await manage(`/projects/${id}`, 'PATCH', settings)).status).toBe(428);
    for (const version of ['1', '"0"', '"01"', '"2147483648"']) {
      expect(
        (
          await managementApp.request(`/api/project-management/projects/${id}`, {
            method: 'PATCH',
            headers: { ...headers(), 'If-Match': version },
            body: JSON.stringify(settings),
          })
        ).status,
      ).toBe(400);
    }
    const writers = await Promise.all([
      manage(`/projects/${id}`, 'PATCH', settings, 1),
      manage(`/projects/${id}`, 'PATCH', { name: 'other', description: 'other' }, 1),
    ]);
    expect(writers.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = (await writers
      .find((response) => response.status === 200)!
      .json()) as ManagedDetails;
    expect(winner.project.version).toBe(2);
    expect((await manage(`/projects/${id}/trash`, 'POST', {}, 1)).status).toBe(409);
    const trash = await manage(`/projects/${id}/trash`, 'POST', {}, 2);
    expect(trash.status).toBe(200);
    const trashed = (await trash.json()) as ManagedDetails;
    expect(trashed.project.version).toBe(3);
    expect(trashed.description).toBe(winner.description);
    expect(trashed.trashedAt).toEqual(expect.any(String));
    expect((await manage(`/projects/${id}/trash`, 'POST', {}, 3)).status).toBe(409);
    const list = await manage('/trash');
    expect((await list.json()).items).toContainEqual(trashed);
    expect((await manage('/trash', 'GET', undefined, undefined, bobToken)).status).toBe(200);
    expect(
      (await (await manage('/trash', 'GET', undefined, undefined, bobToken)).json()).items,
    ).not.toContainEqual(trashed);
    const restore = await manage(`/projects/${id}/restore`, 'POST', {}, 3);
    expect(restore.status).toBe(200);
    const restored = (await restore.json()) as ManagedDetails;
    expect(restored).toMatchObject({
      description: winner.description,
      trashedAt: null,
      project: { id, version: 4 },
    });
    expect(await new ProjectPinsRepository(pool).list(owner)).toContain(id);
    expect((await manage(`/projects/${id}/restore`, 'POST', {}, 4)).status).toBe(409);
    expect((await manage(`/projects/${id}/trash`, 'POST', { unexpected: true }, 4)).status).toBe(
      400,
    );
    await pool.query('UPDATE projects SET version=2147483647 WHERE id=$1', [id]);
    for (const action of ['settings', 'trash']) {
      expect(
        (
          await manage(
            `/projects/${id}${action === 'trash' ? '/trash' : ''}`,
            action === 'trash' ? 'POST' : 'PATCH',
            action === 'trash' ? {} : settings,
            2147483647,
          )
        ).status,
      ).toBe(409);
    }
    await pool.query('UPDATE projects SET trashed_at=clock_timestamp() WHERE id=$1', [id]);
    expect((await manage(`/projects/${id}/restore`, 'POST', {}, 2147483647)).status).toBe(409);
    expect(
      (await pool.query('SELECT trashed_at FROM projects WHERE id=$1', [id])).rows[0].trashed_at,
    ).not.toBeNull();
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM projects WHERE id=$1', [id])).rows[0].n,
    ).toBe(1);
  });

  /** @id TEST-PMG-003 @verifies REQ-PMG-003 */
  it('TEST-PMG-003 refuses every active job state and only unexpired pending uploads', async () => {
    for (const state of [
      'queued',
      'running',
      'cancel_requested',
      'succeeded',
      'failed',
      'cancelled',
    ]) {
      const { project } = await createManaged(`job state ${state}`);
      const active = ['queued', 'running', 'cancel_requested'].includes(state);
      const leased = ['running', 'cancel_requested'].includes(state);
      await pool.query(
        `INSERT INTO durable_jobs(id,tenant_id,owner_oid,project_id,idempotency_key,type,input,state,
        fence,lease_until,started_at,finished_at,cancel_requested_at,cancel_deadline,failure_code)
        VALUES($1,$2,$3,$4,$5,'metadata-test','{}',$6,$7,
          CASE WHEN $8::boolean THEN clock_timestamp()+interval '1 hour' END,
          CASE WHEN $8::boolean THEN clock_timestamp() END,
          CASE WHEN $9::boolean THEN clock_timestamp() END,
          CASE WHEN $6='cancel_requested' THEN clock_timestamp() END,
          CASE WHEN $6='cancel_requested' THEN clock_timestamp()+interval '1 hour' END,
          CASE WHEN $6='failed' THEN 'handler_failed' END)`,
        [
          randomUUID(),
          owner.tenantId,
          owner.objectId,
          project.id,
          randomUUID(),
          state,
          leased ? randomUUID() : null,
          leased,
          !active,
        ],
      );
      const response = await manage(`/projects/${project.id}/trash`, 'POST', {}, 1);
      expect(response.status).toBe(active ? 409 : 200);
      if (active) {
        expect((await response.json()).error.code).toBe('PROJECT_BUSY');
        expect((await (await manage(`/projects/${project.id}`)).json()).project.version).toBe(1);
      }
    }
    const { project } = await createManaged('pending upload');
    const upload = await new FileRepository(pool).reserve(owner, project.id, {
      name: 'pending.txt',
      size: 1,
    });
    expect((await manage(`/projects/${project.id}/trash`, 'POST', {}, 1)).status).toBe(409);
    await pool.query(
      "UPDATE project_files SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [upload],
    );
    expect((await manage(`/projects/${project.id}/trash`, 'POST', {}, 1)).status).toBe(200);
    expect(
      (await pool.query('SELECT state FROM project_files WHERE id=$1', [upload])).rows[0].state,
    ).toBe('uploading');
    for (const first of ['job', 'trash']) {
      const { project: raced } = await createManaged(`admission race ${first}`);
      const gate = await pool.connect();
      let released = false;
      let admission: Promise<{ ok: boolean; error?: unknown }> | undefined;
      let removal: Promise<Response> | undefined;
      const admit = () =>
        new JobRepository(pool).enqueue(owner, raced.id, randomUUID(), 'metadata-test', {}).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      const waiters = async (minimum: number) => {
        const deadline = Date.now() + 5000;
        let count = 0;
        do {
          const result =
            await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'
            AND objid=1747289124::oid AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
          count = result.rows[0].n;
          if (count >= minimum) return;
        } while (Date.now() < deadline);
        expect(
          count,
          'admission and trash must queue behind the same global lock',
        ).toBeGreaterThanOrEqual(minimum);
      };
      try {
        await gate.query('BEGIN');
        await gate.query('SELECT pg_advisory_xact_lock(1747289124)');
        if (first === 'job') admission = admit();
        else removal = manage(`/projects/${raced.id}/trash`, 'POST', {}, 1);
        await waiters(1);
        if (first === 'job') removal = manage(`/projects/${raced.id}/trash`, 'POST', {}, 1);
        else admission = admit();
        await waiters(2);
        await gate.query('COMMIT');
        released = true;
        const [deleted, admitted] = await Promise.all([removal!, admission!]);
        expect(deleted.status).toBe(first === 'job' ? 409 : 200);
        expect(admitted.ok).toBe(first === 'job');
        if (first === 'trash') expect(admitted.error).toMatchObject({ status: 404 });
        const queued = await pool.query(
          'SELECT count(*)::int AS n FROM durable_jobs WHERE project_id=$1',
          [raced.id],
        );
        expect(queued.rows[0].n).toBe(first === 'job' ? 1 : 0);
      } finally {
        try {
          if (!released) await gate.query('ROLLBACK');
        } finally {
          gate.release();
        }
        await Promise.allSettled([admission, removal]);
      }
    }
    for (const action of ['reserve', 'finalize'] as const) {
      for (const first of ['file', 'trash']) {
        const { project: raced } = await createManaged(`upload race ${action} ${first}`);
        const files = new FileRepository(pool);
        const uploadId =
          action === 'finalize'
            ? await files.reserve(owner, raced.id, { name: 'race.txt', size: 1 })
            : undefined;
        const gate = await pool.connect();
        let released = false;
        let operation: Promise<{ ok: boolean; error?: unknown }> | undefined;
        let removal: Promise<Response> | undefined;
        const operate = () =>
          (action === 'reserve'
            ? files.reserve(owner, raced.id, { name: 'race.txt', size: 1 })
            : files.finalize(owner, raced.id, uploadId!, 'b'.repeat(64), '"race-etag"')
          ).then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
        const waiters = async (minimum: number) => {
          const deadline = Date.now() + 5000;
          let count = 0;
          do {
            const result = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
                AND backend_type='client backend'`);
            count = result.rows[0].n;
            if (count >= minimum) return;
          } while (Date.now() < deadline);
          expect(
            count,
            'upload and trash must queue behind the owned project row',
          ).toBeGreaterThanOrEqual(minimum);
        };
        try {
          await gate.query('BEGIN');
          await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [raced.id]);
          if (first === 'file') operation = operate();
          else removal = manage(`/projects/${raced.id}/trash`, 'POST', {}, 1);
          await waiters(1);
          if (first === 'file') removal = manage(`/projects/${raced.id}/trash`, 'POST', {}, 1);
          else operation = operate();
          await waiters(2);
          await gate.query('COMMIT');
          released = true;
          const [deleted, operated] = await Promise.all([removal!, operation!]);
          expect(deleted.status).toBe(
            (action === 'reserve' && first === 'file') ||
              (action === 'finalize' && first === 'trash')
              ? 409
              : 200,
          );
          expect(operated.ok).toBe(action === 'finalize' || first === 'file');
          if (!operated.ok) expect(operated.error).toMatchObject({ status: 404 });
          const activeUploads = await pool.query(
            `SELECT count(*)::int AS n FROM project_files f
            JOIN projects p ON p.id=f.project_id WHERE p.id=$1 AND p.trashed_at IS NOT NULL
            AND f.state='uploading' AND f.expires_at>clock_timestamp()`,
            [raced.id],
          );
          expect(activeUploads.rows[0].n).toBe(0);
        } finally {
          try {
            if (!released) await gate.query('ROLLBACK');
          } finally {
            gate.release();
          }
          await Promise.allSettled([operation, removal]);
        }
      }
    }
  });

  /** @id TEST-PMG-004 @verifies REQ-PMG-004 */
  it('TEST-PMG-004 hides trash across legacy projects, pins, files and jobs even with the manager disabled', async () => {
    const { project } = await createManaged('always active guard');
    const pins = new ProjectPinsRepository(pool);
    const files = new FileRepository(pool);
    const jobs = new JobRepository(pool);
    expect(await pins.set(owner, project.id, true)).toBe(true);
    const fileId = await files.reserve(owner, project.id, { name: 'retained.txt', size: 1 });
    await files.finalize(owner, project.id, fileId, 'a'.repeat(64), 'test-etag');
    expect((await manage(`/projects/${project.id}/trash`, 'POST', {}, 1)).status).toBe(200);
    for (const instance of [app, managementApp]) {
      expect(
        (await instance.request(`/api/projects/${project.id}`, { headers: headers() })).status,
      ).toBe(404);
      expect(
        (
          await instance.request(`/api/projects/${project.id}`, {
            method: 'PATCH',
            headers: { ...headers(), 'If-Match': '"2"' },
            body: JSON.stringify({ name: 'should not rename' }),
          })
        ).status,
      ).toBe(404);
      const listed = (await (
        await instance.request('/api/projects', { headers: headers() })
      ).json()) as Project[];
      expect(listed.some((item) => item.id === project.id)).toBe(false);
    }
    expect((await manage(`/projects/${project.id}`)).status).toBe(404);
    expect(await pins.list(owner)).not.toContain(project.id);
    expect(await pins.set(owner, project.id, false)).toBe(false);
    await expect(files.list(owner, project.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      files.reserve(owner, project.id, { name: 'blocked.txt', size: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(files.get(owner, project.id, fileId)).rejects.toMatchObject({ status: 404 });
    await expect(jobs.authorize(owner, project.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      jobs.enqueue(owner, project.id, randomUUID(), 'metadata-test', {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await pool.query('SELECT id FROM project_files WHERE id=$1', [fileId])).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query('SELECT project_id FROM project_pins WHERE project_id=$1', [project.id]))
        .rows,
    ).toHaveLength(1);
    expect((await manage(`/projects/${project.id}/restore`, 'POST', {}, 2)).status).toBe(200);
    expect(await pins.list(owner)).toContain(project.id);
    expect((await files.list(owner, project.id)).items.some((item) => item.id === fileId)).toBe(
      true,
    );
    await expect(files.get(owner, project.id, fileId)).resolves.toMatchObject({ id: fileId });
    await expect(jobs.authorize(owner, project.id)).resolves.toBeUndefined();
  });

  /** @id TEST-PMG-005 @verifies REQ-PMG-005 */
  it('TEST-PMG-005 exposes disabled management without breaking legacy name-only projects', async () => {
    const legacy = await create('management-disabled control');
    expect(legacy.status).toBe(201);
    expect((await app.request('/api/projects')).status).toBe(401);
    const capabilities = await app.request('/api/project-management/capabilities', {
      headers: headers(),
    });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ enabled: false });
    expect((await app.request('/api/project-management/capabilities')).status).toBe(401);
    const project = (await legacy.json()) as Project;
    for (const [url, method, body] of [
      ['/api/project-management/projects', 'POST', { name: 'blocked', description: '' }],
      [`/api/project-management/projects/${project.id}`, 'GET', undefined],
      [
        `/api/project-management/projects/${project.id}`,
        'PATCH',
        { name: 'blocked', description: '' },
      ],
      [`/api/project-management/projects/${project.id}/trash`, 'POST', {}],
      [`/api/project-management/projects/${project.id}/restore`, 'POST', {}],
      ['/api/project-management/trash', 'GET', undefined],
    ] as const) {
      const response = await app.request(url, {
        method,
        headers: { ...headers(), 'If-Match': '"1"' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('PROJECT_MANAGEMENT_UNAVAILABLE');
    }
    const unchanged = await app.request(`/api/projects/${project.id}`, { headers: headers() });
    expect(await unchanged.json()).toEqual(project);
    const baseEnvironment = {
      ENTRA_TENANT_ID: config.tenantId,
      ENTRA_API_CLIENT_ID: config.apiClientId,
      ENTRA_SPA_CLIENT_ID: config.spaClientId,
      PUBLIC_ORIGIN: config.publicOrigin,
      DATABASE_URL: config.databaseUrl,
      PORT: String(config.port),
    };
    expect(readConfig(baseEnvironment)).not.toHaveProperty('projectManagementEnabled');
    expect(
      readConfig({ ...baseEnvironment, PROJECT_MANAGEMENT_ENABLED: 'false' }),
    ).not.toHaveProperty('projectManagementEnabled');
    expect(readConfig({ ...baseEnvironment, PROJECT_MANAGEMENT_ENABLED: 'true' })).toMatchObject({
      projectManagementEnabled: true,
    });
    for (const flag of ['', 'TRUE', 'yes', '1']) {
      expect(() => readConfig({ ...baseEnvironment, PROJECT_MANAGEMENT_ENABLED: flag })).toThrow();
    }
    expect(pool.options.database).toBe('test');
    const schema = `management_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new Pool({ ...pool.options, options: `-c search_path=${schema}` });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const migration of [
        '001_projects.sql',
        '002_copilot_connections.sql',
        '003_user_preferences.sql',
        '004_project_files.sql',
      ]) {
        await isolated.query(
          await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'),
        );
      }
      const legacy = createApp({
        config,
        verifyToken: fixture.verify,
        projects: new ProjectRepository(isolated),
      });
      expect(
        (
          await legacy.request('/api/projects', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ name: 'pre007 control' }),
          })
        ).status,
      ).toBe(201);
      const enabledConfig = { ...config, projectManagementEnabled: true };
      const enabled = createApp({
        config: enabledConfig,
        verifyToken: fixture.verify,
        projects: new ProjectRepository(isolated),
      });
      const notReady = await enabled.request('/api/project-management/capabilities', {
        headers: headers(),
      });
      expect(notReady.status).toBe(500);
      expect(await notReady.json()).toMatchObject({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed.',
        },
      });
      expect(errors).toHaveBeenCalled();
      await isolated.query(
        await readFile(
          new URL('../db/migrations/007_project_management.sql', import.meta.url),
          'utf8',
        ),
      );
      const capability = await enabled.request('/api/project-management/capabilities', {
        headers: headers(),
      });
      expect(capability.status).toBe(200);
      expect(await capability.json()).toEqual({ enabled: true });
      const created = await enabled.request('/api/project-management/projects', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: 'independent of005006', description: 'kept' }),
      });
      expect(created.status).toBe(201);
      const details = (await created.json()) as ManagedDetails;
      expect(
        (
          await enabled.request(`/api/project-management/projects/${details.project.id}/trash`, {
            method: 'POST',
            headers: { ...headers(), 'If-Match': '"1"' },
            body: '{}',
          })
        ).status,
      ).toBe(200);
    } finally {
      errors.mockRestore();
      await isolated.end();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  /** @id TEST-PROJ-001 @verifies REQ-PROJ-001 */
  it('TEST-PROJ-001 persists owner-scoped projects across repository instances', async () => {
    const response = await create('  分析A  ');
    expect(response.status).toBe(201);
    const project = (await response.json()) as Project;
    expect(project.name).toBe('分析A');
    expect(project.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(project.version).toBe(1);
    const fresh = new ProjectRepository(pool);
    expect(await fresh.get({ tenantId: config.tenantId, objectId: alice }, project.id)).toEqual(
      project,
    );
    expect(await fresh.list({ tenantId: config.tenantId, objectId: bob })).toEqual([]);
    expect(await fresh.list({ tenantId: bob, objectId: alice })).toEqual([]);
    await create('分析A');
    const list = await app.request('/api/projects', { headers: headers() });
    const projects = (await list.json()) as Project[];
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(
      projects.every((p, index) => !index || projects[index - 1]!.updatedAt >= p.updatedAt),
    ).toBe(true);
    expect((await app.request('/api/projects')).status).toBe(401);
    await migrate(pool);
    expect(await fresh.get({ tenantId: config.tenantId, objectId: alice }, project.id)).toEqual(
      project,
    );
  });

  /** @id TEST-PROJ-002 @verifies REQ-PROJ-002 */
  it('TEST-PROJ-002 returns indistinguishable 404 for foreign and missing projects', async () => {
    const response = await create('private');
    expect(response.status).toBe(201);
    const project = (await response.json()) as Project;
    const missing = '77777777-7777-4777-8777-777777777777';
    for (const method of ['GET', 'PATCH']) {
      for (const id of [project.id, missing, '../../etc/passwd', 'not-a-uuid']) {
        const request = await app.request(`/api/projects/${id}`, {
          method,
          headers: { ...headers(bobToken), 'If-Match': '"1"' },
          ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'stolen' }) } : {}),
        });
        expect(request.status).toBe(404);
        const error = (await request.json()) as { error: { code: string; message: string } };
        expect(error.error.code).toBe('NOT_FOUND');
        expect(error.error.message).toBe('Project not found.');
      }
    }
    const own = await app.request(`/api/projects/${project.id}`, { headers: headers() });
    expect(own.status).toBe(200);
    expect(((await own.json()) as Project).name).toBe('private');
  });

  /** @id TEST-PROJ-003 @verifies REQ-PROJ-003 */
  it('TEST-PROJ-003 validates Unicode names, strict input and streamed size limits', async () => {
    for (const body of [
      '{}',
      '{"name":"   "}',
      '{"name":2}',
      '{"name":"x","owner_oid":"other"}',
      JSON.stringify({ name: 'a'.repeat(101) }),
      JSON.stringify({ name: 'a\u0000b' }),
      JSON.stringify({ name: 'a\nb' }),
      '[{"name":"x"}]',
      '{"name":',
    ]) {
      expect(
        (await app.request('/api/projects', { method: 'POST', headers: headers(), body })).status,
      ).toBe(400);
    }
    expect((await create('🔬'.repeat(100))).status).toBe(201);
    const decomposed = 'e\u0301';
    expect(((await (await create(decomposed)).json()) as Project).name).toBe(decomposed);
    const oversized = JSON.stringify({ name: 'x'.repeat(17000) });
    for (const contentLength of [undefined, '10']) {
      const requestHeaders = headers();
      const response = await app.request('/api/projects', {
        method: 'POST',
        headers: contentLength
          ? { ...requestHeaders, 'Content-Length': contentLength }
          : requestHeaders,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(oversized));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(413);
    }
  });

  /** @id TEST-PROJ-004 @verifies REQ-PROJ-004 */
  it('TEST-PROJ-004 rejects missing/stale versions and allows exactly one racing rename', async () => {
    const response = await create('original');
    expect(response.status).toBe(201);
    const project = (await response.json()) as Project;
    const rename = (version: string | undefined, name: string) =>
      app.request(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { ...headers(), ...(version ? { 'If-Match': version } : {}) },
        body: JSON.stringify({ name }),
      });
    expect((await rename(undefined, 'x')).status).toBe(428);
    for (const version of ['1', '"0"', '"01"', '"-1"', '*', '"1", "2"', '"2147483648"']) {
      expect((await rename(version, 'x')).status).toBe(400);
    }
    const race = await Promise.all([rename('"1"', 'first'), rename('"1"', 'second')]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const committed = (await race.find((r) => r.status === 200)!.json()) as Project;
    expect(committed.version).toBe(2);
    const sameName = await rename('"2"', committed.name);
    expect(sameName.status).toBe(200);
    expect(((await sameName.json()) as Project).version).toBe(3);
    expect((await rename('"1"', 'stale')).status).toBe(409);
    const saved = await app.request(`/api/projects/${project.id}`, { headers: headers() });
    expect(((await saved.json()) as Project).name).toBe(committed.name);
  });
});
