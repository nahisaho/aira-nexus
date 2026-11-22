import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { publicConfig, readConfig } from '../src/server/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { JobService, canonicalJobInput } from '../src/server/jobs/service.js';
import type { JobHandlers } from '../src/server/jobs/service.js';
import { JobWorker, jobsEnabled, productionJobHandlers } from '../src/server/jobs/worker.js';
import { jobStates, jobEvents, jobTransition } from '../src/shared/jobs.js';
import type { Job, JobClaim } from '../src/shared/jobs.js';
import { testDatabase } from './helpers/database.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';

const owner = { tenantId: config.tenantId, objectId: alice };
const other = { ...owner, objectId: bob };
const alien = { ...owner, tenantId: randomUUID() };
const schema = z.strictObject({ value: z.string().max(1000) });
const handlers: JobHandlers = new Map([['test', { input: schema, run: async () => {} }]]);
let db: Awaited<ReturnType<typeof testDatabase>>;
let projects: ProjectRepository;
let repository: JobRepository;
let service: JobService;
let identity: Awaited<ReturnType<typeof identityFixture>>;
let token: string;
let otherToken: string;
let app: ReturnType<typeof createApp>;
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });
const payload = { type: 'test', input: { value: 'synthetic' } };
const fields = [
  'id',
  'projectId',
  'type',
  'state',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'cancelRequestedAt',
  'failureCode',
].sort();
beforeAll(async () => {
  db = await testDatabase();
  projects = new ProjectRepository(db.pool);
  repository = new JobRepository(db.pool);
  service = new JobService(repository, handlers);
  identity = await identityFixture();
  token = await identity.sign();
  otherToken = await identity.sign({ oid: bob });
  const options = { config, projects, verifyToken: identity.verify, jobs: service };
  app = createApp(options);
});
beforeEach(async () => {
  const found = await db.pool.query("SELECT to_regclass('durable_jobs') AS relation");
  if (found.rows[0].relation)
    await db.pool.query(
      'TRUNCATE chat_previews,chat_events,chat_runs,chat_turns,chat_conversations,durable_jobs',
    );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});
async function post(
  project: string,
  body: unknown = payload,
  key: string = randomUUID(),
  bearer = token,
) {
  return app.request(`/api/projects/${project}/jobs`, {
    method: 'POST',
    headers: { ...auth(bearer), 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}
async function enqueue(project: string, key: string = randomUUID(), who = owner) {
  return (await service.enqueue(who, project, key, payload)).job;
}
async function claimed(project: string): Promise<JobClaim> {
  await enqueue(project);
  const claim = await repository.claim(['test']);
  expect(claim).not.toBeNull();
  if (!claim) throw new Error('Expected claimed job.');
  return claim;
}

/** @id TEST-SVC-008 @verifies REQ-SVC-010 */
it('TEST-SVC-008 authenticates every job route and fences tenant, owner, project and public metadata', async () => {
  const p = await projects.create(owner, 'Private jobs');
  const response = await post(p.id);
  expect(response.status).toBe(201);
  const job = (await response.json()) as Job;
  expect(Object.keys(job).sort()).toEqual(fields);
  expect(job.state).toBe('queued');
  const q = await projects.create(owner, 'Other project');
  const foreign = await projects.create(other, 'Other owner');
  const root = `/api/projects/${p.id}/jobs`;
  for (const [path, method] of [
    [root, 'GET'],
    [root, 'POST'],
    [`${root}/${job.id}`, 'GET'],
    [`${root}/${job.id}/cancel`, 'POST'],
  ] as const) {
    expect((await app.request(path, { method })).status).toBe(401);
    expect((await app.request(path, { method, headers: auth(otherToken) })).status).toBe(404);
  }
  for (const id of [randomUUID(), 'bad-id']) {
    expect((await app.request(`${root}/${id}`, { headers: auth() })).status).toBe(404);
    expect(
      (
        await app.request(`${root}/${id}/cancel`, {
          method: 'POST',
          headers: auth(),
          body: 'invalid',
        })
      ).status,
    ).toBe(404);
  }
  for (const who of [other, alien])
    await expect(repository.get(who, p.id, job.id)).rejects.toMatchObject({ status: 404 });
  await expect(repository.get(owner, q.id, job.id)).rejects.toMatchObject({ status: 404 });
  await expect(repository.enqueue(other, p.id, 'x', 'test', null)).rejects.toMatchObject({
    status: 404,
  });
  expect((await post(foreign.id, { bad: 'input' })).status).toBe(404);
  expect((await post('invalid', { bad: 'input' })).status).toBe(404);
  expect((await repository.get(owner, p.id, job.id)).id).toBe(job.id);
  const detail = await app.request(`${root}/${job.id}`, { headers: auth() });
  expect(detail.status).toBe(200);
  expect(detail.headers.get('Cache-Control')).toBe('no-store');
  expect(Object.keys(await detail.json()).sort()).toEqual(fields);
});

/** @id TEST-SVC-009 @verifies REQ-SVC-011 */
it('TEST-SVC-009 validates bounded JSON, canonical idempotency, schemas and precise paginated history', async () => {
  expect(canonicalJobInput({ b: [1, 0], a: 'x' })).toBe('{"a":"x","b":[1,0]}');
  expect(canonicalJobInput(JSON.parse('{"a":1,"a":2}'))).toBe('{"a":2}');
  expect(canonicalJobInput([-0, 1.0, 1.5, null, true])).toBe('[0,1,1.5,null,true]');
  for (const bad of [
    NaN,
    Infinity,
    9007199254740992,
    JSON.parse('{"__proto__":{}}'),
    { a: { constructor: 1 } },
    { a: [{ prototype: 1 }] },
  ]) {
    expect(() => canonicalJobInput(bad)).toThrow();
  }
  const p = await projects.create(owner, 'Idempotency');
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 6 }, () => post(p.id, payload, key)));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
  const jobs = await Promise.all(responses.map((r) => r.json() as Promise<Job>));
  expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
  expect((await post(p.id, { type: 'test', input: { value: 'different' } }, key)).status).toBe(409);
  for (const body of [
    null,
    [],
    {},
    { type: 'unknown', input: {} },
    { ...payload, owner: alice },
    { type: 'test', input: { value: 1 } },
    { type: 'test', input: { value: 'ok', extra: true } },
  ]) {
    expect((await post(p.id, body)).status).toBe(400);
  }
  for (const keyValue of ['', 'a b', 'x'.repeat(129), 'a/b'])
    expect((await post(p.id, payload, keyValue)).status).toBe(400);
  expect(
    (
      await app.request(`/api/projects/${p.id}/jobs`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    ).status,
  ).toBe(400);
  expect((await post(p.id, { type: 'test', input: { value: 'x'.repeat(17000) } })).status).toBe(
    413,
  );
  const jsonError = await app.request(`/api/projects/${p.id}/jobs`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json', 'Idempotency-Key': 'malformed' },
    body: '{',
  });
  expect(jsonError.status).toBe(400);
  await repository.cancel(owner, p.id, jobs[0]!.id);
  expect((await post(p.id, payload, key)).status).toBe(200);
  expect(((await post(p.id, payload, key).then((r) => r.json())) as Job).state).toBe('cancelled');
  const same = canonicalJobInput({ value: 'synthetic' });
  const ids: string[] = Array.from({ length: 102 }, () => randomUUID()).sort();
  for (let i = 0; i < ids.length; i++) {
    await db.pool.query(
      `INSERT INTO durable_jobs(id,tenant_id,owner_oid,project_id,idempotency_key,type,input,state,created_at,updated_at,finished_at)
      VALUES($1,$2,$3,$4,$5,'test',$6::jsonb,'succeeded',$7,$7,$7)`,
      [
        ids[i],
        owner.tenantId,
        owner.objectId,
        p.id,
        `page-${i}`,
        same,
        i < 101 ? '2026-01-01T00:00:00.001Z' : '2026-01-01T00:00:00.000Z',
      ],
    );
  }
  const first = await repository.list(owner, p.id);
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).not.toBeNull();
  const second = await repository.list(owner, p.id, first.nextCursor!);
  const all = [...first.items, ...second.items];
  expect(all).toHaveLength(103);
  expect(new Set(all.map((j) => j.id)).size).toBe(103);
  expect(all.filter((j) => ids.includes(j.id)).map((j) => j.id)).toEqual(ids);
  expect(second.nextCursor).toBeNull();
  const root = `/api/projects/${p.id}/jobs`;
  for (const suffix of [
    '?cursor=!',
    `?cursor=${'a'.repeat(257)}`,
    '?limit=1',
    '?unknown=1',
    '?cursor=&cursor=x',
  ]) {
    expect((await app.request(root + suffix, { headers: auth() })).status).toBe(400);
  }
});

/** @id TEST-SVC-010 @verifies REQ-SVC-003 */
it('TEST-SVC-010 pins all 42 state/event cells and confirms cancellation only after settlement', async () => {
  const expected = [
    ['running', 'cancelled', null, null, null, null, null],
    [null, 'cancel_requested', 'succeeded', 'failed', 'failed', 'running', null],
    [null, 'cancel_requested', 'cancelled', 'cancelled', 'failed', 'cancel_requested', 'cancelled'],
    [null, 'succeeded', null, null, null, null, null],
    [null, 'failed', null, null, null, null, null],
    [null, 'cancelled', null, null, null, null, null],
  ];
  jobStates.forEach((state, i) =>
    jobEvents.forEach((event, j) => expect(jobTransition(state, event)).toBe(expected[i]![j])),
  );
  const p = await projects.create(owner, 'Cancellation');
  const queued = await enqueue(p.id);
  const cancelled = await repository.cancel(owner, p.id, queued.id);
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.finishedAt).not.toBeNull();
  expect(await repository.claim(['test'])).toBeNull();
  const claim = await claimed(p.id);
  expect((await repository.cancel(owner, p.id, claim.job.id)).state).toBe('cancel_requested');
  expect((await repository.get(owner, p.id, claim.job.id)).finishedAt).toBeNull();
  const deadline = (
    await db.pool.query('SELECT cancel_deadline FROM durable_jobs WHERE id=$1', [claim.job.id])
  ).rows[0].cancel_deadline;
  await repository.cancel(owner, p.id, claim.job.id);
  await repository.heartbeat(claim);
  expect(
    (await db.pool.query('SELECT cancel_deadline FROM durable_jobs WHERE id=$1', [claim.job.id]))
      .rows[0].cancel_deadline,
  ).toEqual(deadline);
  expect((await repository.finish(claim, 'success'))?.state).toBe('cancelled');
  expect(await repository.finish(claim, 'error')).toBeNull();
  const terminal = await repository.get(owner, p.id, claim.job.id);
  expect(await repository.cancel(owner, p.id, claim.job.id)).toEqual(terminal);
  const root = `/api/projects/${p.id}/jobs/${queued.id}/cancel`;
  expect((await app.request(root, { method: 'POST', headers: auth(), body: 'x' })).status).toBe(
    400,
  );
  expect((await app.request(root, { method: 'POST', headers: auth() })).status).toBe(200);
  const emptyBody = {
    method: 'POST',
    headers: auth(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    duplex: 'half' as const,
  };
  expect((await app.request(root, emptyBody)).status).toBe(200);
  const failure = await claimed(p.id);
  expect((await repository.finish(failure, 'error'))?.failureCode).toBe('handler_failed');
  expect(await repository.finish(failure, 'success')).toBeNull();
  const success = await claimed(p.id);
  expect((await repository.finish(success, 'success'))?.state).toBe('succeeded');
  expect((await repository.cancel(owner, p.id, success.job.id)).state).toBe('succeeded');
});

/** @id TEST-SVC-011 @verifies REQ-SVC-012 */
it('TEST-SVC-011 serializes global/owner admission and execution caps across repository instances', async () => {
  const p = await projects.create(owner, 'Queue caps');
  const admissions = await Promise.allSettled(
    Array.from({ length: 21 }, (_, i) => enqueue(p.id, `cap-${i}`)),
  );
  expect(admissions.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
  const rejected = admissions.find((r) => r.status === 'rejected');
  expect(rejected && rejected.status === 'rejected' && rejected.reason).toMatchObject({
    status: 429,
  });
  const stored = await repository.list(owner, p.id);
  const replayKey = (
    await db.pool.query('SELECT idempotency_key FROM durable_jobs WHERE project_id=$1 LIMIT 1', [
      p.id,
    ])
  ).rows[0].idempotency_key as string;
  const replay = await service.enqueue(owner, p.id, replayKey, payload);
  expect(replay.created).toBe(false);
  const peer = new JobRepository(db.pool);
  const claims = (await Promise.all([repository.claim(['test']), peer.claim(['test'])])).filter(
    (c) => c !== null,
  );
  expect(claims).toHaveLength(1);
  const firstClaim = claims[0];
  if (!firstClaim) throw new Error('Expected first claim.');
  const q = await projects.create(owner, 'Same owner another project');
  await db.pool.query(
    "UPDATE durable_jobs SET state='cancelled',finished_at=clock_timestamp(),cancel_requested_at=clock_timestamp() WHERE state='queued'",
  );
  await enqueue(q.id);
  expect(await peer.claim(['test'])).toBeNull();
  await repository.cancel(owner, p.id, firstClaim.job.id);
  expect(await peer.claim(['test'])).toBeNull();
  const otherProject = await projects.create(other, 'Other owner capacity');
  await enqueue(otherProject.id, randomUUID(), other);
  expect(await peer.claim(['test'])).not.toBeNull();
  const third = { tenantId: config.tenantId, objectId: randomUUID() };
  const thirdProject = await projects.create(third, 'Global cap');
  await enqueue(thirdProject.id, randomUUID(), third);
  expect(await peer.claim(['test'])).toBeNull();
  await repository.finish(firstClaim, 'stop_ack');
  expect((await peer.claim(['test']))?.job.projectId).toBe(q.id);
  await db.pool.query(
    'TRUNCATE chat_previews,chat_events,chat_runs,chat_turns,chat_conversations,durable_jobs',
  );
  for (let n = 0; n < 10; n++) {
    const who = { tenantId: randomUUID(), objectId: owner.objectId };
    const project = await projects.create(who, 'Tenant-independent quota');
    for (let j = 0; j < 20; j++) await enqueue(project.id, `${n}-${j}`, who);
  }
  await expect(enqueue(p.id, 'global-overflow')).rejects.toMatchObject({ status: 429 });
  expect(stored.items).toHaveLength(20);
  await db.pool.query(
    'TRUNCATE chat_previews,chat_events,chat_runs,chat_turns,chat_conversations,durable_jobs',
  );
  const unknown = await enqueue(p.id);
  await db.pool.query("UPDATE durable_jobs SET type='future-type' WHERE id=$1", [unknown.id]);
  expect(await peer.claim(['test'])).toBeNull();
  expect((await peer.get(owner, p.id, unknown.id)).state).toBe('queued');
  expect((await peer.cancel(owner, p.id, unknown.id)).state).toBe('cancelled');
}, 120000);

/** @id TEST-SVC-012 @verifies REQ-SVC-013 */
it('TEST-SVC-012 rejects expired and foreign fences before reconciliation and preserves queued work after restart', async () => {
  const p = await projects.create(owner, 'Lease recovery');
  const claim = await claimed(p.id);
  const forged = { ...claim, fence: randomUUID() };
  expect(await repository.heartbeat(forged)).toBeNull();
  expect(await repository.finish(forged, 'success')).toBeNull();
  expect(await repository.heartbeat({ ...claim, owner: other })).toBeNull();
  const before = (
    await db.pool.query('SELECT lease_until FROM durable_jobs WHERE id=$1', [claim.job.id])
  ).rows[0].lease_until;
  expect(await repository.heartbeat(claim)).toBe('running');
  const after = (
    await db.pool.query('SELECT lease_until FROM durable_jobs WHERE id=$1', [claim.job.id])
  ).rows[0].lease_until;
  expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  const queued = await enqueue(p.id);
  await db.pool.query(
    "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claim.job.id],
  );
  for (const event of ['success', 'error', 'stop_ack'] as const)
    expect(await repository.finish(claim, event)).toBeNull();
  expect(await repository.heartbeat(claim)).toBeNull();
  const fresh = new JobRepository(db.pool);
  expect((await fresh.get(owner, p.id, claim.job.id)).failureCode).toBe('interrupted');
  const next = await fresh.claim(['test']);
  expect(next?.job.id).toBe(queued.id);
  expect((await fresh.get(owner, p.id, claim.job.id)).state).toBe('failed');
  if (!next) throw new Error('Expected preserved queued job.');
  await fresh.cancel(owner, p.id, next.job.id);
  await db.pool.query(
    "UPDATE durable_jobs SET cancel_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
    [next.job.id],
  );
  expect(await fresh.heartbeat(next)).toBeNull();
  for (const event of ['success', 'error', 'stop_ack'] as const)
    expect(await fresh.finish(next, event)).toBeNull();
  expect((await fresh.get(owner, p.id, next.job.id)).failureCode).toBe('cancellation_unconfirmed');
  expect(await fresh.claim(['test'])).toBeNull();
});

/** @id TEST-SVC-013 @verifies REQ-SVC-014 */
it('TEST-SVC-013 defaults disabled without job-table access and runs only injected cooperative synthetic handlers', async () => {
  expect(jobsEnabled({ JOBS_ENABLED: 'true' })).toBe(true);
  expect(jobsEnabled({})).toBe(false);
  expect(jobsEnabled({ JOBS_ENABLED: 'false' })).toBe(false);
  const env = {
    ENTRA_TENANT_ID: config.tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    PUBLIC_ORIGIN: config.publicOrigin,
    DATABASE_URL: config.databaseUrl,
  };
  expect(readConfig(env)).toEqual(config);
  expect(readConfig({ ...env, JOBS_ENABLED: 'false' })).toEqual(config);
  const enabled = readConfig({ ...env, JOBS_ENABLED: 'true' });
  expect(enabled.jobsEnabled).toBe(true);
  expect(publicConfig(enabled)).toEqual(publicConfig(config));
  for (const value of ['', '1', 'TRUE', 'false '])
    expect(() => jobsEnabled({ JOBS_ENABLED: value })).toThrow();
  expect(productionJobHandlers.size).toBe(0);
  const p = await projects.create(owner, 'Worker lifecycle');
  const disabled = createApp({ config, projects, verifyToken: identity.verify });
  await db.pool.query('ALTER TABLE durable_jobs RENAME TO isolated_unapplied_jobs');
  try {
    const root = `/api/projects/${p.id}/jobs`;
    for (const [path, method] of [
      [root, 'GET'],
      [root, 'POST'],
      [`${root}/${randomUUID()}`, 'GET'],
      [`${root}/${randomUUID()}/cancel`, 'POST'],
    ] as const) {
      expect((await disabled.request(path, { method, headers: auth() })).status).toBe(503);
    }
    for (const [path, method] of [
      [`${root}/bad`, 'GET'],
      [`${root}/bad/cancel`, 'POST'],
    ] as const) {
      expect((await disabled.request(path, { method, headers: auth() })).status).toBe(404);
    }
    expect(
      (await disabled.request(`/api/projects/${randomUUID()}/jobs`, { headers: auth() })).status,
    ).toBe(404);
  } finally {
    await db.pool.query('ALTER TABLE isolated_unapplied_jobs RENAME TO durable_jobs');
  }
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cooperative: JobHandlers = new Map([
    [
      'test',
      {
        input: schema,
        run: async ({ signal }) => {
          started();
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
        },
      },
    ],
  ]);
  const worker = new JobWorker(repository, cooperative, { heartbeatMs: 5, pollMs: 5 });
  const job = await enqueue(p.id);
  const running = worker.runOne();
  await start;
  expect((await repository.get(owner, p.id, job.id)).state).toBe('running');
  await repository.cancel(owner, p.id, job.id);
  await running;
  expect((await repository.get(owner, p.id, job.id)).state).toBe('cancelled');
  const shutdown = new AbortController();
  const stopJob = await enqueue(p.id);
  let shutdownStarted!: () => void;
  const entered = new Promise<void>((resolve) => {
    shutdownStarted = resolve;
  });
  const stopping = new JobWorker(
    repository,
    new Map([
      [
        'test',
        {
          input: schema,
          run: async ({ signal }) => {
            shutdownStarted();
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );
          },
        },
      ],
    ]),
    { heartbeatMs: 5 },
  );
  const pending = stopping.runOne(shutdown.signal);
  await entered;
  shutdown.abort();
  await pending;
  expect((await repository.get(owner, p.id, stopJob.id)).failureCode).toBe('interrupted');
  const cancelledShutdown = new AbortController();
  const cancelledJob = await enqueue(p.id);
  let cancellationStarted!: () => void;
  const cancellationEntered = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  let releaseCancellation!: () => void;
  const cancellationSettlement = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationSignal: AbortSignal | undefined;
  const cancelledPending = new JobWorker(
    repository,
    new Map([
      [
        'test',
        {
          input: schema,
          run: async ({ signal }) => {
            cancellationSignal = signal;
            cancellationStarted();
            await cancellationSettlement;
          },
        },
      ],
    ]),
    { heartbeatMs: 5 },
  ).runOne(cancelledShutdown.signal);
  await cancellationEntered;
  try {
    await repository.cancel(owner, p.id, cancelledJob.id);
    cancelledShutdown.abort();
    expect(cancellationSignal?.aborted).toBe(true);
    expect((await repository.get(owner, p.id, cancelledJob.id)).state).toBe('cancel_requested');
  } finally {
    releaseCancellation();
    await cancelledPending;
  }
  const acknowledged = await repository.get(owner, p.id, cancelledJob.id);
  expect(acknowledged.state).toBe('cancelled');
  expect(acknowledged.failureCode).toBeNull();
  const normal = await enqueue(p.id);
  expect(await new JobWorker(repository, handlers).runOne()).toBe(true);
  expect((await repository.get(owner, p.id, normal.id)).state).toBe('succeeded');
  const failing: JobHandlers = new Map([
    [
      'test',
      {
        input: schema,
        run: async () => {
          throw new Error('PRIVATE_HANDLER_SECRET');
        },
      },
    ],
  ]);
  const failed = await enqueue(p.id);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await new JobWorker(repository, failing).runOne();
  expect((await repository.get(owner, p.id, failed.id)).failureCode).toBe('handler_failed');
  expect(JSON.stringify(await repository.get(owner, p.id, failed.id))).not.toContain(
    'PRIVATE_HANDLER_SECRET',
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_HANDLER_SECRET');
  expect(log).toHaveBeenCalled();
  log.mockRestore();
  const interrupted = await enqueue(p.id);
  const heartbeatFailure = vi
    .spyOn(repository, 'heartbeat')
    .mockRejectedValueOnce(new Error('PRIVATE_DATABASE_SECRET'));
  const heartbeatLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  await new JobWorker(repository, cooperative, { heartbeatMs: 5 }).runOne();
  expect((await repository.get(owner, p.id, interrupted.id)).failureCode).toBe('interrupted');
  expect(JSON.stringify(heartbeatLog.mock.calls)).not.toContain('PRIVATE_DATABASE_SECRET');
  heartbeatFailure.mockRestore();
  heartbeatLog.mockRestore();
  const aborted = new AbortController();
  aborted.abort();
  const remains = await enqueue(p.id);
  expect(await worker.runOne(aborted.signal)).toBe(false);
  expect((await repository.get(owner, p.id, remains.id)).state).toBe('queued');
});
