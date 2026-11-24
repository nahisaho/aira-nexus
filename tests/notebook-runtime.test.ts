import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readConfig, publicConfig } from '../src/server/config.js';
import { notebookFixture } from './helpers/notebook.js';

let fixture: Awaited<ReturnType<typeof notebookFixture>>;
beforeAll(async () => {
  fixture = await notebookFixture();
});
afterAll(async () => {
  await fixture?.db.close();
});
async function cell(project: string, language = 'python', code = 'x = 40') {
  const response = await fixture.request(project, '/cells', 'POST', { language, code });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; version: number; code: string }>;
}
async function run(project: string, id: string, version: number) {
  const response = await fixture.request(project, `/cells/${id}/execute`, 'POST', { version });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ output: string; stateLost: boolean; executedBy: string }>;
}

/** @id TEST-NB-001 @verifies REQ-NB-001 */
it('TEST-NB-001 retains per-project/language state and serializes concurrent cells across service instances', async () => {
  const p = await fixture.projects.create(fixture.owner, 'Notebook isolation');
  const q = await fixture.projects.create(fixture.owner, 'Independent notebook');
  const python = await cell(p.id);
  const r = await cell(p.id, 'r', 'x <- 12');
  expect((await run(p.id, python.id, 1)).output).toBe('40');
  expect((await run(p.id, r.id, 1)).output).toBe('12');
  const readPython = await cell(p.id, 'python', 'print(x)');
  expect((await run(p.id, readPython.id, 1)).output).toBe('40');
  const other = await cell(q.id, 'python', 'print(x)');
  expect((await run(q.id, other.id, 1)).output).toBe('undefined');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixture.runtime.execute.mockImplementationOnce(async () => {
    entered();
    await gate;
    return 'first';
  });
  const first = fixture.request(p.id, `/cells/${python.id}/execute`, 'POST', { version: 1 });
  await start;
  const before = fixture.runtime.execute.mock.calls.length;
  const second = fixture.request(p.id, `/cells/${readPython.id}/execute`, 'POST', { version: 1 });
  try {
    expect(fixture.runtime.execute.mock.calls.length).toBe(before);
  } finally {
    release();
  }
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
});

/** @id TEST-NB-002 @verifies REQ-NB-002 */
it('TEST-NB-002 persists exact Unicode code/output and executor while fencing every route by tenant/owner', async () => {
  const p = await fixture.projects.create(fixture.owner, 'Persistent notebook');
  const saved = await cell(p.id, 'python', 'x = 42\n# 日本語');
  const output = await run(p.id, saved.id, saved.version);
  expect(output.executedBy).toBe(fixture.owner.objectId);
  for (const [path, method, body] of [
    ['', 'GET', undefined],
    ['/cells', 'POST', { language: 'r', code: 'x <- 1' }],
    [`/cells/${saved.id}`, 'PUT', { version: 1, code: 'changed' }],
    [`/cells/${saved.id}/execute`, 'POST', { version: 1 }],
    ['/restart', 'POST', { language: 'python' }],
  ] as const) {
    expect((await fixture.request(p.id, path, method, body, fixture.foreignToken)).status).toBe(
      404,
    );
    expect((await fixture.request(randomUUID(), path, method, body)).status).toBe(404);
  }
  const view = await fixture.request(p.id);
  expect(view.status).toBe(200);
  const text = await view.text();
  expect(text).toContain('日本語');
  expect(text).not.toContain('token');
  expect(text).not.toContain('generation');
  const stored = await fixture.db.pool.query(
    'SELECT code,output,executed_by FROM notebook_cells WHERE id=$1',
    [saved.id],
  );
  expect(stored.rows[0]).toMatchObject({
    code: saved.code,
    output: '42',
    executed_by: fixture.owner.objectId,
  });
});

/** @id TEST-NB-003 @verifies REQ-NB-003 */
it('TEST-NB-003 rejects stale writes and restart preserves saved cells while reporting lost variables', async () => {
  const p = await fixture.projects.create(fixture.owner, 'Notebook lifecycle');
  const saved = await cell(p.id);
  await run(p.id, saved.id, 1);
  const changed = await fixture.request(p.id, `/cells/${saved.id}`, 'PUT', {
    version: 1,
    code: 'print(x)',
  });
  expect(changed.status).toBe(200);
  expect(
    (await fixture.request(p.id, `/cells/${saved.id}`, 'PUT', { version: 1, code: 'stale' }))
      .status,
  ).toBe(409);
  expect(
    (await fixture.request(p.id, `/cells/${saved.id}/execute`, 'POST', { version: 1 })).status,
  ).toBe(409);
  expect((await fixture.request(p.id, '/restart', 'POST', { language: 'python' })).status).toBe(
    200,
  );
  expect(fixture.runtime.stop).toHaveBeenCalled();
  const after = await run(p.id, saved.id, 2);
  expect(after.output).toBe('undefined');
  expect(after.stateLost).toBe(true);
});

/** @id TEST-NB-004 @verifies REQ-NB-004 */
it('TEST-NB-004 defaults disabled without touching execution/schema and fails closed on unverified isolation', async () => {
  const disabled = await notebookFixture(false);
  try {
    const p = await disabled.projects.create(disabled.owner, 'Disabled notebook');
    const capabilities = await disabled.request(p.id, '/capabilities');
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ enabled: false });
    await disabled.db.pool.query('ALTER TABLE notebook_cells RENAME TO notebook_cells_unapplied');
    expect(
      (await disabled.request(p.id, '/cells', 'POST', { language: 'python', code: '1' })).status,
    ).toBe(503);
    expect(disabled.runtime.ready).not.toHaveBeenCalled();
    expect(disabled.runtime.start).not.toHaveBeenCalled();
  } finally {
    await disabled.db.close();
  }
  const env = {
    ENTRA_TENANT_ID: fixture.owner.tenantId,
    ENTRA_API_CLIENT_ID: randomUUID(),
    ENTRA_SPA_CLIENT_ID: randomUUID(),
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
  };
  for (const value of ['', '1', 'TRUE', 'false '])
    expect(() => readConfig({ ...env, NOTEBOOK_ENABLED: value })).toThrow();
  expect(publicConfig(readConfig({ ...env, NOTEBOOK_ENABLED: 'false' }))).toEqual(
    publicConfig(readConfig(env)),
  );
  const p = await fixture.projects.create(fixture.owner, 'Unverified isolation');
  const saved = await cell(p.id);
  fixture.runtime.ready.mockRejectedValueOnce(new Error('NetworkPolicy not enforced'));
  const before = fixture.runtime.start.mock.calls.length;
  expect(
    (await fixture.request(p.id, `/cells/${saved.id}/execute`, 'POST', { version: 1 })).status,
  ).toBe(503);
  expect(fixture.runtime.start.mock.calls).toHaveLength(before);
});

/** @id TEST-NB-005 @verifies REQ-NB-005 */
it('TEST-NB-005 enforces UTF-8 code/output limits and kills timed-out kernels before reuse', async () => {
  const p = await fixture.projects.create(fixture.owner, 'Notebook bounds');
  const atLimit = await cell(p.id, 'python', 'é'.repeat(131072));
  expect(
    (
      await fixture.request(p.id, '/cells', 'POST', {
        language: 'python',
        code: 'é'.repeat(131073),
      })
    ).status,
  ).toBe(413);
  fixture.runtime.execute.mockResolvedValueOnce('a'.repeat(8388609));
  const output = await run(p.id, atLimit.id, 1);
  expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(8388608);
  const stopBefore = fixture.runtime.stop.mock.calls.length;
  fixture.runtime.execute.mockRejectedValueOnce(
    new DOMException('Execution timed out', 'TimeoutError'),
  );
  expect(
    (await fixture.request(p.id, `/cells/${atLimit.id}/execute`, 'POST', { version: 1 })).status,
  ).toBe(200);
  expect(fixture.runtime.stop.mock.calls.length).toBeGreaterThan(stopBefore);
});

/** @id TEST-NB-007 @verifies REQ-NB-002 */
it('TEST-NB-007 rejects caller paths, foreign file IDs and unsafe artifact names before runtime access', async () => {
  const p = await fixture.projects.create(fixture.owner, 'Notebook files');
  const saved = await cell(p.id);
  for (const body of [
    { version: 1, path: '/etc/passwd' },
    { version: 1, files: ['../escape'] },
    { version: 1, files: [randomUUID()] },
    { version: 1, files: [{ id: randomUUID(), path: '../escape' }] },
  ])
    expect((await fixture.request(p.id, `/cells/${saved.id}/execute`, 'POST', body)).status).toBe(
      400,
    );
  for (const name of ['../escape.txt', '/etc/passwd', 'a\\\\b.txt', 'a\\u0000.txt', '.', '..']) {
    expect(
      (await fixture.request(p.id, '/artifacts', 'POST', { language: 'python', name })).status,
    ).toBe(400);
  }
  expect(fixture.runtime.artifact).not.toHaveBeenCalled();
});

/** @id TEST-NB-008 @verifies REQ-NB-005 */
it('TEST-NB-008 enforces global eight-kernel admission atomically across independent database connections', async () => {
  const ids = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => {
      const p = await fixture.projects.create(fixture.owner, `Kernel admission ${i}`);
      return { project: p.id, cell: await cell(p.id) };
    }),
  );
  await fixture.db.pool.query('DELETE FROM notebook_kernels');
  const before = fixture.runtime.start.mock.calls.length;
  const responses = await Promise.all(
    ids.map(({ project, cell: saved }) =>
      fixture.request(project, `/cells/${saved.id}/execute`, 'POST', { version: 1 }),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(8);
  expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
  expect(fixture.runtime.start.mock.calls.length - before).toBe(8);
  expect(
    (await fixture.db.pool.query('SELECT count(*)::int AS count FROM notebook_kernels')).rows[0]
      .count,
  ).toBe(8);
});
