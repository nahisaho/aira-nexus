import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { ChatRepository } from '../src/server/chat/repository.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { JobService } from '../src/server/jobs/service.js';
import { JobWorker } from '../src/server/jobs/worker.js';
import { ChatService } from '../src/server/chat/service.js';
import { testDatabase } from './helpers/database.js';
import { alice, config, identityFixture } from './helpers/identity.js';
import { z } from 'zod';

const owner = { tenantId: config.tenantId, objectId: alice };
const other = { tenantId: config.tenantId, objectId: '22222222-2222-4222-8222-222222222222' };
const alien = { tenantId: '33333333-3333-4333-8333-333333333333', objectId: alice };
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const snapshot = (text: string) => `{"modelId":"gpt-6.1-sol","prompt":${JSON.stringify(text)}}`;
const enabledConfig = {
  ...config,
  jobsEnabled: true,
  chatEnabled: true as const,
  copilot: { clientId: 'test-client', encryptionKey: Buffer.alloc(32).toString('base64') },
};
let db: Awaited<ReturnType<typeof testDatabase>>;
let projects: ProjectRepository;
let chat: ChatRepository;
let token: string;
let app: ReturnType<typeof createApp>;
let readyApp: ReturnType<typeof createApp>;
let unreadyApp: ReturnType<typeof createApp>;
let genericJobsApp: ReturnType<typeof createApp>;
let unregisteredJobsApp: ReturnType<typeof createApp>;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  db = await testDatabase();
  projects = new ProjectRepository(db.pool);
  chat = new ChatRepository(db.pool);
  const identity = await identityFixture();
  token = await identity.sign();
  app = createApp({ config, projects, verifyToken: identity.verify });
  readyApp = createApp({
    config: enabledConfig,
    projects,
    chat: new ChatService(chat, enabledConfig, true),
    verifyToken: identity.verify,
  });
  unreadyApp = createApp({
    config: enabledConfig,
    projects,
    chat: new ChatService(chat, enabledConfig),
    verifyToken: identity.verify,
  });
  genericJobsApp = createApp({
    config: { ...config, jobsEnabled: true },
    projects,
    jobs: new JobService(
      new JobRepository(db.pool),
      new Map([
        ['chat.generate', { input: z.strictObject({ runId: z.uuid() }), run: async () => {} }],
      ]),
    ),
    verifyToken: identity.verify,
  });
  unregisteredJobsApp = createApp({
    config: { ...config, jobsEnabled: true },
    projects,
    jobs: new JobService(new JobRepository(db.pool), new Map()),
    verifyToken: identity.verify,
  });
  env = {
    ENTRA_TENANT_ID: config.tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    PUBLIC_ORIGIN: config.publicOrigin,
    DATABASE_URL: config.databaseUrl,
  };
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

/** @id TEST-CHH-001 @verifies REQ-CHH-001 */
it('TEST-CHH-001 isolates and paginates conversation history', async () => {
  const project = await projects.create(owner, 'Conversation history');
  const conversationsPath = `/api/projects/${project.id}/chat/conversations`;
  const routeHeaders = {
    ...headers(token),
    'Content-Type': 'application/json',
  };
  expect(
    (
      await readyApp.request(conversationsPath, {
        method: 'POST',
        headers: routeHeaders,
        body: JSON.stringify({ unexpected: true }),
      })
    ).status,
  ).toBe(400);
  const createdResponse = await readyApp.request(conversationsPath, {
    method: 'POST',
    headers: routeHeaders,
    body: '{}',
  });
  expect(createdResponse.status).toBe(201);
  const conversation = (await createdResponse.json()) as { id: string; createdAt: string };
  await expect(
    new ChatRepository(db.pool).getConversation(owner, project.id, conversation.id),
  ).resolves.toMatchObject({ id: conversation.id });
  const created = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      chat.createConversation(owner, project.id).then((value) => ({ index, value })),
    ),
  );
  const first = await chat.listConversations(owner, project.id);
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toBeTruthy();
  const second = await chat.listConversations(owner, project.id, first.nextCursor ?? undefined);
  expect(second.items).toHaveLength(1);
  const expected = [conversation, ...created.map(({ value }) => value)]
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
    .map((item) => item.id);
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(expected);
  expect(created).toHaveLength(100);
  const missingConversation = await readyApp.request(`${conversationsPath}/${randomUUID()}`, {
    headers: routeHeaders,
  });
  expect(missingConversation.status).toBe(404);
  await db.pool.query(
    `INSERT INTO chat_turns(id,tenant_id,owner_oid,project_id,conversation_id,sequence,role,text)
     SELECT gen_random_uuid(),$1,$2,$3,$4,sequence,'user','turn-'||sequence
     FROM generate_series(1,101) AS generated(sequence)`,
    [owner.tenantId, owner.objectId, project.id, conversation.id],
  );
  const firstTurns = await chat.listTurns(owner, project.id, conversation.id);
  expect(firstTurns.items).toHaveLength(100);
  expect(firstTurns.items[0]?.sequence).toBe(1);
  expect(firstTurns.items.map(({ sequence }) => sequence)).toEqual(
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  expect(firstTurns.nextCursor).toBeTruthy();
  const lastTurns = await chat.listTurns(
    owner,
    project.id,
    conversation.id,
    firstTurns.nextCursor ?? undefined,
  );
  expect(lastTurns.items.map(({ sequence }) => sequence)).toEqual([101]);
  expect(lastTurns.nextCursor).toBeNull();
  await expect(chat.getConversation(other, project.id, conversation.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(chat.getConversation(alien, project.id, conversation.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(chat.getConversation(owner, project.id, 'not-a-uuid')).rejects.toMatchObject({
    status: 404,
  });
  await expect(chat.listConversations(owner, project.id, 'not-a-cursor')).rejects.toMatchObject({
    status: 400,
  });
  await expect(chat.listConversations(owner, project.id, 'a'.repeat(257))).rejects.toMatchObject({
    status: 400,
  });
  const tamperedCursor = Buffer.from(
    JSON.stringify(['2026-01-01T00:00:00.000Z', 'not-a-uuid']),
  ).toString('base64url');
  await expect(chat.listConversations(owner, project.id, tamperedCursor)).rejects.toMatchObject({
    status: 400,
  });
  await db.pool.query('UPDATE projects SET trashed_at=clock_timestamp() WHERE id=$1', [project.id]);
  await expect(chat.getConversation(owner, project.id, conversation.id)).rejects.toMatchObject({
    status: 404,
  });
});

/** @id TEST-CHH-002 @verifies REQ-CHH-002 */
it('TEST-CHH-002 atomically admits immutable turns and replays only the same owner key and input', async () => {
  const project = await projects.create(owner, 'Atomic chat admission');
  const conversation = await chat.createConversation(owner, project.id);
  const initialSnapshot = snapshot('hello');
  const input = {
    idempotencyKey: 'chat-test-key',
    modelId: 'gpt-6.1-sol',
    snapshot: initialSnapshot,
    snapshotHash: hash(initialSnapshot),
  };
  const jobs = new JobRepository(db.pool);
  const run = await chat.admitConfirmed(owner, project.id, conversation.id, input);
  expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const replay = await chat.admitConfirmed(owner, project.id, conversation.id, input);
  expect(replay.id).toBe(run.id);
  const secondConversation = await chat.createConversation(owner, project.id);
  const capacityJobs = await Promise.all(
    Array.from({ length: 19 }, (_, index) =>
      jobs.enqueue(owner, project.id, `chat-cap-${index}`, 'test', {}),
    ),
  );
  expect(capacityJobs).toHaveLength(19);
  const busyInput = {
    ...input,
    idempotencyKey: 'while-owner-busy',
  };
  await expect(
    chat.admitConfirmed(owner, project.id, secondConversation.id, busyInput),
  ).rejects.toMatchObject({ status: 409, code: 'CHAT_BUSY' });
  await Promise.all(capacityJobs.map(({ job }) => jobs.cancel(owner, project.id, job.id)));
  const turns = await chat.listTurns(owner, project.id, conversation.id);
  expect(turns.items.map((turn) => [turn.role, turn.text])).toEqual([
    ['user', 'hello'],
    ['assistant', ''],
  ]);
  const changedSnapshot = snapshot('changed');
  await expect(
    chat.admitConfirmed(owner, project.id, conversation.id, {
      ...input,
      snapshot: changedSnapshot,
      snapshotHash: hash(changedSnapshot),
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    chat.admitConfirmed(other, project.id, conversation.id, {
      ...input,
      idempotencyKey: 'foreign-key',
    }),
  ).rejects.toMatchObject({ status: 404 });
  const counts = await db.pool.query<{ jobs: number; turns: number }>(
    `SELECT
       (SELECT count(*)::int FROM durable_jobs WHERE type='chat.generate' AND project_id=$1) AS jobs,
       (SELECT count(*)::int FROM chat_turns WHERE conversation_id=$2) AS turns`,
    [project.id, conversation.id],
  );
  expect(counts.rows[0]).toEqual({ jobs: 1, turns: 2 });
  const generic = await genericJobsApp.request(`/api/projects/${project.id}/jobs`, {
    method: 'POST',
    headers: {
      ...headers(token),
      'Content-Type': 'application/json',
      'Idempotency-Key': 'unconfirmed-chat',
    },
    body: JSON.stringify({ type: 'chat.generate', input: { runId: run.id } }),
  });
  expect(generic.status).toBe(400);
  expect(
    (
      await db.pool.query(
        "SELECT count(*)::int AS jobs FROM durable_jobs WHERE type='chat.generate'",
      )
    ).rows[0].jobs,
  ).toBe(1);
  const claim = await jobs.claim(['chat.generate']);
  if (!claim) throw new Error('Expected admitted chat job.');
  await jobs.finish(claim, 'success');
  expect((await chat.getRun(owner, project.id, run.id)).state).toBe('succeeded');

  const crossConversation = await chat.admitConfirmed(
    owner,
    project.id,
    secondConversation.id,
    input,
  );
  expect(crossConversation.id).not.toBe(run.id);
  const crossClaim = await jobs.claim(['chat.generate']);
  if (!crossClaim) throw new Error('Expected cross-conversation chat job.');
  await jobs.finish(crossClaim, 'success');

  const parallelConversation = await chat.createConversation(owner, project.id);
  const parallelInput = { ...input, idempotencyKey: 'parallel-key' };
  const parallel = await Promise.all(
    Array.from({ length: 6 }, () =>
      chat.admitConfirmed(owner, project.id, parallelConversation.id, parallelInput),
    ),
  );
  expect(new Set(parallel.map(({ id }) => id)).size).toBe(1);
  const parallelClaim = await jobs.claim(['chat.generate']);
  if (!parallelClaim) throw new Error('Expected concurrent replay job.');
  await jobs.finish(parallelClaim, 'success');

  const faultConversation = await chat.createConversation(owner, project.id);
  const jobsBeforeFault = (
    await db.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM durable_jobs WHERE project_id=$1 AND type='chat.generate'",
      [project.id],
    )
  ).rows[0]?.count;
  await db.pool.query(`
    CREATE FUNCTION test_skip_chat_assistant_turn() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.role='assistant' THEN RETURN NULL; END IF;
      RETURN NEW;
    END;
    $$`);
  await db.pool.query(`
    CREATE TRIGGER test_skip_chat_assistant_turn
    BEFORE INSERT ON chat_turns
    FOR EACH ROW EXECUTE FUNCTION test_skip_chat_assistant_turn()`);
  try {
    await expect(
      chat.admitConfirmed(owner, project.id, faultConversation.id, {
        ...input,
        idempotencyKey: 'fault-admission',
      }),
    ).rejects.toThrow('Chat turn admission was incomplete.');
  } finally {
    await db.pool.query('DROP TRIGGER test_skip_chat_assistant_turn ON chat_turns');
    await db.pool.query('DROP FUNCTION test_skip_chat_assistant_turn()');
  }
  const afterFault = await db.pool.query<{ runs: number; turns: number; jobs: number }>(
    `SELECT
       (SELECT count(*)::int FROM chat_runs WHERE conversation_id=$1) AS runs,
       (SELECT count(*)::int FROM chat_turns WHERE conversation_id=$1) AS turns,
       (SELECT count(*)::int FROM durable_jobs WHERE project_id=$2 AND type='chat.generate') AS jobs`,
    [faultConversation.id, project.id],
  );
  expect(afterFault.rows[0]).toEqual({ runs: 0, turns: 0, jobs: jobsBeforeFault });

  const capture = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const waiters = async (minimum: number) => {
    const deadline = Date.now() + 5000;
    let count = 0;
    do {
      count =
        (
          await db.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'
           AND objid=1747289124::oid AND NOT granted
           AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
          )
        ).rows[0]?.count ?? 0;
      if (count >= minimum) return;
    } while (Date.now() < deadline);
    expect(
      count,
      'chat admission and project trash must share the global lock',
    ).toBeGreaterThanOrEqual(minimum);
  };
  for (const first of ['admission', 'trash'] as const) {
    const racedProject = await projects.create(owner, `Chat admission race ${first}`);
    const racedConversation = await chat.createConversation(owner, racedProject.id);
    const gate = await db.pool.connect();
    let released = false;
    let admission:
      ReturnType<typeof capture<Awaited<ReturnType<ChatRepository['admitConfirmed']>>>> | undefined;
    let trash:
      ReturnType<typeof capture<Awaited<ReturnType<ProjectRepository['trash']>>>> | undefined;
    const admit = () =>
      capture(
        chat.admitConfirmed(owner, racedProject.id, racedConversation.id, {
          ...input,
          idempotencyKey: `race-${first}`,
        }),
      );
    const remove = () => capture(projects.trash(owner, racedProject.id, 1));
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT pg_advisory_xact_lock(1747289124)');
      if (first === 'admission') admission = admit();
      else trash = remove();
      await waiters(1);
      if (first === 'admission') trash = remove();
      else admission = admit();
      await waiters(2);
      await gate.query('COMMIT');
      released = true;
      const admissionResult = await admission!;
      const trashResult = await trash!;
      expect(admissionResult.ok).toBe(first === 'admission');
      expect(trashResult.ok).toBe(first === 'trash');
      if (first === 'admission')
        expect(trashResult).toMatchObject({ ok: false, error: { status: 409 } });
      else expect(admissionResult).toMatchObject({ ok: false, error: { status: 404 } });
      if (first === 'admission' && admissionResult.ok) {
        const job = await db.pool.query<{ job_id: string }>(
          'SELECT job_id FROM chat_runs WHERE id=$1',
          [admissionResult.value.id],
        );
        await jobs.cancel(owner, racedProject.id, job.rows[0]!.job_id);
      }
    } finally {
      try {
        if (!released) await gate.query('ROLLBACK');
      } finally {
        gate.release();
      }
      await Promise.allSettled([admission, trash]);
    }
  }
});

/** @id TEST-CHH-003 @verifies REQ-CHH-003 */
it('TEST-CHH-003 commits deduplicated contiguous events before exposing the run snapshot', async () => {
  const project = await projects.create(owner, 'Durable chat events');
  const conversation = await chat.createConversation(owner, project.id);
  const prompt = snapshot('hello');
  const run = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'event-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const claim = await new JobRepository(db.pool).claim(['chat.generate']);
  expect(claim?.input).toEqual({ runId: run.id });
  if (!claim) throw new Error('Expected chat job claim.');
  const first = await chat.appendEvent(claim, {
    eventKey: 'delta-1',
    type: 'delta',
    text: 'hello ',
  });
  const visibleBeforeNextDelta = await chat.listEvents(owner, project.id, run.id, 0);
  expect(visibleBeforeNextDelta.items.map(({ sequence }) => sequence)).toEqual([1]);
  const duplicate = await chat.appendEvent(claim, {
    eventKey: 'delta-1',
    type: 'delta',
    text: 'hello ',
  });
  await expect(
    chat.appendEvent(claim, { eventKey: 'delta-1', type: 'delta', text: 'changed' }),
  ).rejects.toMatchObject({ status: 409 });
  const second = await chat.appendEvent(claim, {
    eventKey: 'delta-2',
    type: 'delta',
    text: 'world',
  });
  if (!first || !duplicate || !second) throw new Error('Expected current chat events.');
  expect(first.sequence).toBe(1);
  expect(duplicate.sequence).toBe(1);
  expect(second.sequence).toBe(2);
  await db.pool.query(`
    CREATE FUNCTION test_skip_chat_revision_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.history_revision > OLD.history_revision THEN RETURN NULL; END IF;
      RETURN NEW;
    END;
    $$`);
  await db.pool.query(`
    CREATE TRIGGER test_skip_chat_revision_update
    BEFORE UPDATE ON chat_conversations
    FOR EACH ROW EXECUTE FUNCTION test_skip_chat_revision_update()`);
  try {
    await expect(
      chat.appendEvent(claim, {
        eventKey: 'fault-event',
        type: 'delta',
        text: 'not committed',
      }),
    ).rejects.toThrow('Chat conversation update returned no row.');
  } finally {
    await db.pool.query('DROP TRIGGER test_skip_chat_revision_update ON chat_conversations');
    await db.pool.query('DROP FUNCTION test_skip_chat_revision_update()');
  }
  const rolledBack = await chat.getRun(owner, project.id, run.id);
  expect([rolledBack.answer, rolledBack.lastSequence]).toEqual(['hello world', 2]);
  expect((await chat.listEvents(owner, project.id, run.id, 0)).items).toHaveLength(2);
  for (let sequence = 3; sequence <= 101; sequence++)
    await chat.appendEvent(claim, {
      eventKey: `delta-${sequence}`,
      type: 'delta',
      text: `${sequence},`,
    });
  const page = await chat.listEvents(owner, project.id, run.id, 0);
  expect(page.items).toHaveLength(100);
  expect(page.items.map(({ sequence }) => sequence)).toEqual(
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  expect(page.items.slice(0, 2).map(({ text }) => text)).toEqual(['hello ', 'world']);
  expect(page.nextCursor).toBe('100');
  const nextPage = await chat.listEvents(owner, project.id, run.id, Number(page.nextCursor));
  expect(nextPage.items.map(({ sequence }) => sequence)).toEqual([101]);
  expect(nextPage.nextCursor).toBeNull();
  const routePage = await readyApp.request(
    `/api/projects/${project.id}/chat/runs/${run.id}/events?after=${page.nextCursor}`,
    { headers: headers(token) },
  );
  expect(routePage.status).toBe(200);
  expect(((await routePage.json()) as { items: { sequence: number }[] }).items[0]?.sequence).toBe(
    101,
  );
  await expect(chat.listEvents(owner, project.id, run.id, 102)).rejects.toMatchObject({
    status: 409,
  });
  expect((await chat.getRun(owner, project.id, run.id)).lastSequence).toBe(101);
  await new JobRepository(db.pool).finish(claim, 'success');
});

/** @id TEST-CHH-004 @verifies REQ-CHH-004 */
it('TEST-CHH-004 retains committed partial text after confirmed cancellation and fences later writes', async () => {
  const project = await projects.create(owner, 'Retained partial answer');
  const conversation = await chat.createConversation(owner, project.id);
  const prompt = snapshot('hello');
  const run = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'cancel-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const jobs = new JobRepository(db.pool);
  const claim = await jobs.claim(['chat.generate']);
  expect(claim?.input).toEqual({ runId: run.id });
  if (!claim) throw new Error('Expected chat job claim.');
  await chat.appendEvent(claim, { eventKey: 'partial', type: 'delta', text: 'partial answer' });
  const genericCancels = await Promise.all(
    Array.from({ length: 2 }, () =>
      unregisteredJobsApp.request(`/api/projects/${project.id}/jobs/${claim.job.id}/cancel`, {
        method: 'POST',
        headers: headers(token),
      }),
    ),
  );
  expect(genericCancels.map(({ status }) => status)).toEqual([200, 200]);
  const cancelledJobs = await Promise.all(
    genericCancels.map((response) => response.json() as Promise<{ state: string }>),
  );
  expect(cancelledJobs.map(({ state }) => state)).toEqual(['cancel_requested', 'cancel_requested']);
  expect((await chat.getRun(owner, project.id, run.id)).state).toBe('cancel_requested');
  await chat.settle(claim, 'stop_ack');
  const settled = await chat.getRun(owner, project.id, run.id);
  expect(settled.state).toBe('cancelled');
  expect(settled.answer).toBe('partial answer');
  expect(
    (
      await db.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM chat_events WHERE run_id=$1 AND type='status'",
        [run.id],
      )
    ).rows[0]?.count,
  ).toBe(2);
  expect(
    await chat.appendEvent(claim, {
      eventKey: 'late',
      type: 'delta',
      text: 'must not appear',
    }),
  ).toBeNull();
  expect((await chat.getRun(owner, project.id, run.id)).answer).toBe('partial answer');
  const next = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'expiry-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const expiryClaim = await jobs.claim(['chat.generate']);
  expect(expiryClaim?.input).toEqual({ runId: next.id });
  if (!expiryClaim) throw new Error('Expected expiry chat claim.');
  await chat.appendEvent(expiryClaim, { eventKey: 'expiry-partial', type: 'delta', text: 'kept' });
  await db.pool.query(
    "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expiryClaim.job.id],
  );
  const reconciledByRead = await chat.getRun(owner, project.id, next.id);
  expect([reconciledByRead.state, reconciledByRead.failureCode]).toEqual(['failed', 'interrupted']);
  expect((await jobs.get(owner, project.id, expiryClaim.job.id)).failureCode).toBe('interrupted');
  const failed = await chat.getRun(owner, project.id, next.id);
  expect([failed.state, failed.answer, failed.failureCode]).toEqual([
    'failed',
    'kept',
    'interrupted',
  ]);
  expect(
    await chat.appendEvent(expiryClaim, {
      eventKey: 'late-expired',
      type: 'delta',
      text: 'must not appear',
    }),
  ).toBeNull();

  const cancelRun = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'expired-cancel-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const cancelClaim = await jobs.claim(['chat.generate']);
  expect(cancelClaim?.input).toEqual({ runId: cancelRun.id });
  if (!cancelClaim) throw new Error('Expected expired cancellation claim.');
  await db.pool.query(
    "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [cancelClaim.job.id],
  );
  const expiredCancel = await chat.cancelRun(owner, project.id, cancelRun.id);
  expect([expiredCancel.state, expiredCancel.failureCode]).toEqual(['failed', 'interrupted']);

  const genericExpiry = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'generic-expiry-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const genericExpiryClaim = await jobs.claim(['chat.generate']);
  expect(genericExpiryClaim?.input).toEqual({ runId: genericExpiry.id });
  if (!genericExpiryClaim) throw new Error('Expected generic expiry claim.');
  await db.pool.query(
    "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [genericExpiryClaim.job.id],
  );
  const expiryResponses = await Promise.all(
    Array.from({ length: 2 }, () =>
      unregisteredJobsApp.request(`/api/projects/${project.id}/jobs/${genericExpiryClaim.job.id}`, {
        headers: headers(token),
      }),
    ),
  );
  expect(expiryResponses.map(({ status }) => status)).toEqual([200, 200]);
  const expiredJobs = await Promise.all(
    expiryResponses.map(
      (response) => response.json() as Promise<{ state: string; failureCode: string }>,
    ),
  );
  expect(expiredJobs.map(({ state, failureCode }) => [state, failureCode])).toEqual([
    ['failed', 'interrupted'],
    ['failed', 'interrupted'],
  ]);
  expect((await chat.getRun(owner, project.id, genericExpiry.id)).failureCode).toBe('interrupted');
  expect(
    (
      await db.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM chat_events WHERE run_id=$1 AND type='status'",
        [genericExpiry.id],
      )
    ).rows[0]?.count,
  ).toBe(1);

  const shutdownRun = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'shutdown-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  let handlerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });
  const shutdown = new AbortController();
  const worker = new JobWorker(
    new JobRepository(db.pool),
    new Map([
      [
        'chat.generate',
        {
          input: z.strictObject({ runId: z.uuid() }),
          run: async ({ signal }) => {
            handlerStarted();
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );
          },
        },
      ],
    ]),
    { heartbeatMs: 1000 },
  );
  const running = worker.runOne(shutdown.signal);
  await started;
  shutdown.abort();
  await running;
  const shutdownResult = await chat.getRun(owner, project.id, shutdownRun.id);
  expect([shutdownResult.state, shutdownResult.failureCode]).toEqual(['failed', 'interrupted']);

  const rollbackRun = await chat.admitConfirmed(owner, project.id, conversation.id, {
    idempotencyKey: 'missing-schema-key',
    modelId: 'gpt-6.1-sol',
    snapshot: prompt,
    snapshotHash: hash(prompt),
  });
  const rollbackClaim = await jobs.claim(['chat.generate']);
  expect(rollbackClaim?.input).toEqual({ runId: rollbackRun.id });
  if (!rollbackClaim) throw new Error('Expected missing-schema claim.');
  await db.pool.query('ALTER TABLE chat_runs RENAME TO isolated_unapplied_chat_runs');
  try {
    await expect(jobs.cancel(owner, project.id, rollbackClaim.job.id)).rejects.toThrow();
  } finally {
    await db.pool.query('ALTER TABLE isolated_unapplied_chat_runs RENAME TO chat_runs');
  }
  const rollbackState = await db.pool.query<{ state: string }>(
    'SELECT state FROM durable_jobs WHERE id=$1',
    [rollbackClaim.job.id],
  );
  expect(rollbackState.rows[0]?.state).toBe('running');
  await db.pool.query(
    "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [rollbackClaim.job.id],
  );
  await db.pool.query('ALTER TABLE chat_runs RENAME TO isolated_unapplied_chat_runs');
  try {
    await expect(jobs.get(owner, project.id, rollbackClaim.job.id)).rejects.toThrow();
  } finally {
    await db.pool.query('ALTER TABLE isolated_unapplied_chat_runs RENAME TO chat_runs');
  }
  const expiryRollbackState = await db.pool.query<{ state: string }>(
    'SELECT state FROM durable_jobs WHERE id=$1',
    [rollbackClaim.job.id],
  );
  expect(expiryRollbackState.rows[0]?.state).toBe('running');
  expect((await chat.getRun(owner, project.id, rollbackRun.id)).failureCode).toBe('interrupted');
  const preservedRun = await chat.getRun(owner, project.id, run.id);
  expect([preservedRun.state, preservedRun.answer]).toEqual(['cancelled', 'partial answer']);
});

/** @id TEST-CHH-005 @verifies REQ-CHH-005 */
it('TEST-CHH-005 leaves chat disabled by default and avoids optional chat-schema access', async () => {
  expect(readConfig(env)).toEqual(config);
  expect(readConfig({ ...env, CHAT_ENABLED: 'false' })).toEqual(config);
  const enabledEnv = {
    ...env,
    JOBS_ENABLED: 'true',
    CHAT_ENABLED: 'true',
    GITHUB_OAUTH_CLIENT_ID: 'test-client',
    COPILOT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  };
  expect(readConfig(enabledEnv)).toMatchObject({
    jobsEnabled: true,
    chatEnabled: true,
    copilot: { clientId: 'test-client' },
  });
  for (const value of ['', '1', 'TRUE', 'false '])
    expect(() => readConfig({ ...enabledEnv, CHAT_ENABLED: value })).toThrow();
  expect(() => readConfig({ ...env, CHAT_ENABLED: 'true' })).toThrow();

  const project = await projects.create(owner, 'Chat disabled');
  const query = vi.spyOn(db.pool, 'query');
  await db.pool.query(
    'ALTER TABLE chat_conversations RENAME TO isolated_unapplied_chat_conversations',
  );
  await db.pool.query('ALTER TABLE durable_jobs RENAME TO isolated_unapplied_jobs');
  query.mockClear();
  try {
    const capabilities = await app.request(`/api/projects/${project.id}/chat/capabilities`, {
      headers: headers(token),
    });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({ enabled: false });
    const conversations = await app.request(`/api/projects/${project.id}/chat/conversations`, {
      headers: headers(token),
    });
    expect(conversations.status).toBe(503);
    const malformedCancel = await app.request(
      `/api/projects/${project.id}/chat/runs/not-a-uuid/cancel`,
      {
        method: 'POST',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: 'invalid',
      },
    );
    expect(malformedCancel.status).toBe(503);
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toMatch(
      /chat_|durable_jobs/i,
    );
  } finally {
    await db.pool.query('ALTER TABLE isolated_unapplied_jobs RENAME TO durable_jobs');
    await db.pool.query(
      'ALTER TABLE isolated_unapplied_chat_conversations RENAME TO chat_conversations',
    );
    query.mockRestore();
  }

  const unready = await unreadyApp.request(`/api/projects/${project.id}/chat/capabilities`, {
    headers: headers(token),
  });
  expect(unready.status).toBe(503);
  const unreadyBody = (await unready.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  expect(unreadyBody.error).toEqual({
    code: 'CHAT_UNAVAILABLE',
    message: 'Chat is unavailable.',
    requestId: expect.any(String),
  });

  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.pool.query('ALTER TABLE chat_events RENAME TO isolated_unapplied_chat_events');
  try {
    const missingSchema = await readyApp.request(`/api/projects/${project.id}/chat/capabilities`, {
      headers: headers(token),
    });
    expect(missingSchema.status).toBe(503);
    expect(await missingSchema.json()).toMatchObject({
      error: { code: 'CHAT_UNAVAILABLE', message: 'Chat is unavailable.' },
    });
  } finally {
    await db.pool.query('ALTER TABLE isolated_unapplied_chat_events RENAME TO chat_events');
    log.mockRestore();
  }
});
