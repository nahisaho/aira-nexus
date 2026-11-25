import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { ChatEventWriter } from '../src/server/chat/event-writer.js';
import { ChatRepository } from '../src/server/chat/repository.js';
import { ChatRuntime } from '../src/server/chat/runtime.js';
import { createPrivateSdkChild } from '../src/server/chat/sdk-child.js';
import { ChatService } from '../src/server/chat/service.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { ProjectRepository } from '../src/server/projects.js';
import { testDatabase } from './helpers/database.js';
import { alice, config, identityFixture } from './helpers/identity.js';

let db: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.close();
});

it('serializes visible deltas and drains the accepted prefix when output is rejected', async () => {
  const writes: [string, string][] = [];
  const stopped: Error[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = new ChatEventWriter(
    async (key, text) => {
      if (text === 'first') await firstWrite;
      writes.push([key, text]);
    },
    (error) => stopped.push(error),
  );
  writer.push('first');
  writer.push('');
  writer.push('second');
  writer.push('\uD800');
  writer.push('must not persist');
  expect(stopped).toHaveLength(1);
  release();
  await expect(writer.finish()).rejects.toThrow('Invalid or oversized chat delta.');
  expect(writes).toEqual([
    ['assistant-delta:1', 'first'],
    ['assistant-delta:2', 'second'],
  ]);
});

/** @id TEST-CHR-002 @verifies REQ-CHR-002 */
it('TEST-CHR-002 isolates SDK attempts in private working, home and configuration directories', async () => {
  const first = await createPrivateSdkChild();
  try {
    const second = await createPrivateSdkChild();
    try {
      expect(second.baseDirectory).not.toBe(first.baseDirectory);
      for (const child of [first, second]) {
        const dirs = [child.workingDirectory, child.env.HOME, child.env.XDG_CONFIG_HOME];
        expect(new Set(dirs).size).toBe(3);
        for (const dir of dirs) {
          expect(dirname(dir ?? '')).toBe(child.baseDirectory);
          expect((await stat(dir ?? '')).mode & 0o777).toBe(0o700);
        }
        expect(child.env.OTEL_SDK_DISABLED).toBe('true');
        expect(child.env.GITHUB_TOKEN).toBeUndefined();
        expect(child.env.GH_TOKEN).toBeUndefined();
      }
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
});

/** @id TEST-CHR-003 @verifies REQ-CHR-003 */
it('TEST-CHR-003 supplies a restricted session to the pinned SDK adapter', async () => {
  const { CopilotClient, ToolSet } = await import('@github/copilot-sdk');
  const captured = new Error('SDK options captured without starting a child');
  const start = vi.spyOn(CopilotClient.prototype, 'start').mockResolvedValue(undefined);
  const stop = vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValue([]);
  const create = vi.spyOn(CopilotClient.prototype, 'createSession').mockRejectedValue(captured);
  try {
    await expect(
      new ChatRuntime().generate(
        'synthetic-token',
        'synthetic-model',
        'fixed framing',
        'approved text',
        new AbortController().signal,
      ),
    ).rejects.toBe(captured);
    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      model: 'synthetic-model',
      allowedModels: ['synthetic-model'],
      systemMessage: { mode: 'replace', content: 'fixed framing' },
      availableTools: [],
      tools: [],
      mcpServers: {},
      customAgents: [],
      skillDirectories: [],
      agentDirectories: [],
      hookDirectories: [],
      instructionDirectories: [],
      pluginDirectories: [],
      enableSkills: false,
      enableConfigDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableOnDemandInstructionDiscovery: false,
      enableSessionStore: false,
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory',
      includeSubAgentStreamingEvents: false,
      infiniteSessions: { enabled: false },
      streaming: true,
    });
    expect(options?.excludedTools).toEqual(
      new ToolSet().addBuiltIn('*').addMcp('*').addCustom('*'),
    );
    expect(options?.onUserInputRequest).toBeUndefined();
    expect(options?.hooks).toBeUndefined();
    expect(options?.onPermissionRequest).toBeTypeOf('function');
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    create.mockRestore();
    stop.mockRestore();
    start.mockRestore();
  }
});

/** @id TEST-CHR-006 @verifies REQ-CHR-006 */
it('TEST-CHR-006 replays authorized committed events after the client disconnects without cancelling execution', async () => {
  const isolated = await testDatabase();
  try {
    const owner = { tenantId: config.tenantId, objectId: alice };
    const projects = new ProjectRepository(isolated.pool);
    const chat = new ChatRepository(isolated.pool);
    const jobs = new JobRepository(isolated.pool);
    const project = await projects.create(owner, 'SSE project');
    const conversation = await chat.createConversation(owner, project.id);
    const modelId = 'synthetic';
    const snapshot = JSON.stringify({ modelId, prompt: 'A question' });
    const run = await chat.admitConfirmed(owner, project.id, conversation.id, {
      modelId,
      snapshot,
      snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
      idempotencyKey: 'sse-run',
    });
    const identity = await identityFixture();
    const enabled = {
      ...config,
      jobsEnabled: true,
      chatEnabled: true as const,
      copilot: { clientId: 'test-client', encryptionKey: Buffer.alloc(32).toString('base64') },
    };
    const app = createApp({
      config: enabled,
      projects,
      verifyToken: identity.verify,
      chat: new ChatService(chat, enabled, true),
    });
    const url = `/api/projects/${project.id}/chat/runs/${run.id}/stream`;
    const headers = { Authorization: `Bearer ${await identity.sign()}` };
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(`${url}?after=00`, { headers })).status).toBe(400);

    const claim = await jobs.claim(['chat.generate']);
    if (!claim) throw new Error('Expected the queued chat job.');
    await chat.appendEvent(claim, { eventKey: 'first-delta', type: 'delta', text: 'first' });
    const subscription = await app.request(url, { headers });
    expect(subscription.status).toBe(200);
    expect(subscription.headers.get('Content-Type')).toMatch(/^text\/event-stream/);
    const reader = subscription.body?.getReader();
    if (!reader) throw new Error('Missing stream response body.');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('id: 1\n');
    await reader.cancel();
    expect((await chat.getRun(owner, project.id, run.id)).state).toBe('running');
    await chat.appendEvent(claim, {
      eventKey: 'internal-key',
      type: 'delta',
      text: 'answer\nnext',
    });
    await jobs.finish(claim, 'success');

    const replay = await app.request(`${url}?after=1`, { headers });
    expect(replay.status).toBe(200);
    const frames = (await replay.text()).trim().split('\n\n');
    const persisted = await chat.listEvents(owner, project.id, run.id, 1);
    expect(frames.map((frame) => Number(/^id: (\d+)/.exec(frame)?.[1]))).toEqual(
      persisted.items.map((event) => event.sequence),
    );
    expect(frames.join('\n')).toContain('"text":"answer\\nnext"');
    expect(frames.join('\n')).not.toContain('internal-key');
    expect(JSON.parse(frames.at(-1)?.split('\ndata: ')[1] ?? '{}')).toMatchObject({
      runId: run.id,
      type: 'status',
      state: 'succeeded',
    });
  } finally {
    await isolated.close();
  }
});

/** @id TEST-CHR-004 @verifies REQ-CHR-004 */
it('TEST-CHR-004 retains committed text when the next delta exceeds the total byte limit', async () => {
  const isolated = await testDatabase();
  try {
    const owner = { tenantId: randomUUID(), objectId: randomUUID() };
    const project = await new ProjectRepository(isolated.pool).create(owner, 'Output budget');
    const chat = new ChatRepository(isolated.pool);
    const conversation = await chat.createConversation(owner, project.id);
    const modelId = 'synthetic';
    const snapshot = JSON.stringify({ modelId, prompt: 'A question' });
    const run = await chat.admitConfirmed(owner, project.id, conversation.id, {
      modelId,
      snapshot,
      snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
      idempotencyKey: 'budget',
    });
    const jobs = new JobRepository(isolated.pool);
    const claim = await jobs.claim(['chat.generate']);
    if (!claim) throw new Error('Expected the queued chat job.');
    const append = (eventKey: string, text: string) =>
      chat.appendEvent(claim, { eventKey, type: 'delta', text });
    const block = '猫'.repeat(5461) + 'x';
    for (let i = 0; i < 61; i++) expect(await append(`block-${i}`, block)).not.toBeNull();
    expect(await append('boundary', 'x'.repeat(576))).not.toBeNull();
    await expect(append('over', 'x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const current = await chat.getRun(owner, project.id, run.id);
    expect(Buffer.byteLength(current.answer)).toBe(1_000_000);
    expect(current.lastSequence).toBe(62);
    await isolated.pool.query(
      `UPDATE durable_jobs SET started_at=clock_timestamp()-interval '300 seconds',
         lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
      [claim.job.id],
    );
    await expect(append('late', '')).resolves.toBeNull();
    await expect(jobs.finish(claim, 'success')).resolves.toBeNull();
    const expired = await chat.getRun(owner, project.id, run.id);
    expect([expired.state, expired.failureCode, expired.answer]).toEqual([
      'failed',
      'interrupted',
      current.answer,
    ]);
    const next = await chat.admitConfirmed(owner, project.id, conversation.id, {
      modelId,
      snapshot,
      snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
      idempotencyKey: 'heartbeat-boundary',
    });
    const nextClaim = await jobs.claim(['chat.generate']);
    if (!nextClaim) throw new Error('Expected the next chat job.');
    const reconcile = jobs.reconcile.bind(jobs);
    const boundary = vi.spyOn(jobs, 'reconcile').mockImplementationOnce(async (client) => {
      await reconcile(client);
      // Simulate the deadline crossing between reconciliation and the heartbeat UPDATE.
      await client.query(
        "UPDATE durable_jobs SET started_at=clock_timestamp()-interval '300 seconds' WHERE id=$1",
        [nextClaim.job.id],
      );
    });
    try {
      await expect(jobs.heartbeat(nextClaim)).resolves.toBeNull();
    } finally {
      boundary.mockRestore();
    }
    expect(await chat.getRun(owner, project.id, next.id)).toMatchObject({
      state: 'failed',
      failureCode: 'interrupted',
    });
  } finally {
    await isolated.close();
  }
});

/** @id TEST-CHR-005 @verifies REQ-CHR-005 */
it('TEST-CHR-005 does not treat ordinary job completion or deadline expiry as a stop acknowledgement', async () => {
  const cancel = new AbortController();
  let idle = () => {};
  let acknowledgeAbort!: () => void;
  const abortAcknowledged = new Promise<void>((resolve) => {
    acknowledgeAbort = resolve;
  });
  let settledLocally = false;
  const runtime = new ChatRuntime(() => ({
    start: async () => {},
    stop: async () => {},
    listModels: async () => [],
    createSession: async () => ({
      onMessage: () => () => {},
      onIdle: (handler) => {
        idle = handler;
        handler(); // Idle at subscription time is not evidence about the dispatched prompt.
        return () => {};
      },
      send: async () => {
        cancel.abort();
      },
      abort: async () => {
        acknowledgeAbort();
      },
      disconnect: async () => {},
    }),
  }));
  const generation = runtime.generate(
    'test-token',
    'synthetic',
    'fixed system',
    'question',
    cancel.signal,
    undefined,
    () => {
      settledLocally = true;
    },
  );
  const aborted = expect(generation).rejects.toMatchObject({ name: 'AbortError' });
  await abortAcknowledged;
  expect(settledLocally).toBe(false);
  idle();
  await aborted;
  expect(settledLocally).toBe(true);

  const unanswered = new AbortController();
  const never = new Promise<never>(() => {});
  const proof = vi.fn();
  const stop = vi.fn(async () => {});
  let markAbortRequested!: () => void;
  const abortRequested = new Promise<void>((resolve) => {
    markAbortRequested = resolve;
  });
  const stalled = new ChatRuntime(() => ({
    start: async () => {},
    stop,
    listModels: async () => [],
    createSession: async () => ({
      onMessage: () => () => {},
      onIdle: () => () => {},
      send: () => {
        unanswered.abort();
        return never;
      },
      abort: () => {
        markAbortRequested();
        return never;
      },
      disconnect: () => never,
    }),
  }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const outcome = stalled
      .generate(
        'test-token',
        'synthetic',
        'fixed system',
        'question',
        unanswered.signal,
        undefined,
        proof,
      )
      .then(
        () => 'success',
        (error: Error) => error.message,
      );
    await abortRequested;
    await vi.advanceTimersByTimeAsync(30_000);
    const watchdog = new Promise((resolve) => {
      AbortSignal.timeout(1000).addEventListener('abort', () => resolve('pending'), { once: true });
    });
    expect(await Promise.race([outcome, watchdog])).toBe(
      'Chat session settlement was not confirmed.',
    );
    expect(proof).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }

  for (const phase of ['start', 'list', 'session'] as const) {
    const controller = new AbortController();
    const stopped = vi.fn(async () => {});
    const settled = vi.fn();
    const stall = () => {
      controller.abort();
      return never;
    };
    const createSession = vi.fn(stall);
    const setup = new ChatRuntime(() => ({
      start: async () => {
        if (phase === 'start') await stall();
      },
      stop: stopped,
      listModels: stall,
      createSession,
    }));
    const result =
      phase === 'session'
        ? setup.generate(
            'test-token',
            'synthetic',
            'fixed system',
            'question',
            controller.signal,
            undefined,
            settled,
          )
        : setup.listModels('test-token', controller.signal);
    const outcome = result.then(
      () => 'success',
      (error: Error) => error.name,
    );
    const watchdog = new Promise((resolve) => {
      AbortSignal.timeout(1000).addEventListener('abort', () => resolve('pending'), { once: true });
    });
    expect(await Promise.race([outcome, watchdog]), phase).toBe('AbortError');
    expect(stopped).toHaveBeenCalledWith(true);
    expect(settled).not.toHaveBeenCalled();
    if (phase !== 'session') expect(createSession).not.toHaveBeenCalled();
  }

  const owner = { tenantId: randomUUID(), objectId: randomUUID() };
  const project = await new ProjectRepository(db.pool).create(owner, 'Cancellation');
  const chat = new ChatRepository(db.pool);
  const jobs = new JobRepository(db.pool);
  const conversation = await chat.createConversation(owner, project.id);
  const modelId = 'synthetic';
  const snapshot = JSON.stringify({ modelId, prompt: 'A question' });
  for (const event of ['success', 'error'] as const) {
    const run = await chat.admitConfirmed(owner, project.id, conversation.id, {
      modelId,
      snapshot,
      snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
      idempotencyKey: `cancel-${event}`,
    });
    const claim = await jobs.claim(['chat.generate']);
    if (!claim) throw new Error('Expected the queued chat job.');
    await chat.appendEvent(claim, { eventKey: 'prefix', type: 'delta', text: 'partial' });
    expect((await chat.cancelRun(owner, project.id, run.id)).state).toBe('cancel_requested');
    await expect(jobs.finish(claim, event)).resolves.toBeNull();
    if (event === 'error') {
      await db.pool.query(
        "UPDATE durable_jobs SET started_at=clock_timestamp()-interval '300 seconds' WHERE id=$1",
        [claim.job.id],
      );
    }
    await chat.settle(claim, 'stop_ack');
    const settled = await chat.getRun(owner, project.id, run.id);
    expect([settled.state, settled.failureCode, settled.answer]).toEqual(
      event === 'success'
        ? ['cancelled', null, 'partial']
        : ['failed', 'cancellation_unconfirmed', 'partial'],
    );
  }
});

/** @id TEST-CHR-001 @verifies REQ-CHR-001 */
it('TEST-CHR-001 admits one active run across Node processes and enforces the owner invariant in PostgreSQL', async () => {
  const peer = new Pool(db.pool.options);
  try {
    const owner = { tenantId: randomUUID(), objectId: randomUUID() };
    const independent = { ...owner, objectId: randomUUID() };
    const projects = new ProjectRepository(db.pool);
    const [first, second, other] = await Promise.all([
      projects.create(owner, 'First'),
      projects.create(owner, 'Second'),
      projects.create(independent, 'Independent'),
    ]);
    const primary = new ChatRepository(db.pool);
    const [firstScope, secondScope] = await Promise.all([
      primary.createConversation(owner, first.id),
      primary.createConversation(owner, second.id),
    ]);
    const modelId = 'synthetic';
    const snapshot = JSON.stringify({ modelId, prompt: 'A question' });
    const payload = {
      modelId,
      snapshot,
      snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
      idempotencyKey: 'same-key',
    };
    const { host, port, database, user, password } = db.pool.options;
    if (typeof password !== 'string') throw new Error('Expected a disposable database password.');
    const admit = async (principal: typeof owner, project: string, scope: string) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import { Pool } from 'pg';
           import { ChatRepository } from './src/server/chat/repository.ts';
           const [owner, project, scope, payload] = JSON.parse(process.argv[1]);
           const pool = new Pool();
           try {
             const run = await new ChatRepository(pool).admitConfirmed(owner, project, scope, payload);
             console.log(JSON.stringify({ kind: 'admitted', run, pid: process.pid }));
           } catch (error) {
             if (error?.code !== 'CHAT_BUSY') throw error;
             console.log(JSON.stringify({ kind: 'busy', pid: process.pid }));
           } finally {
             await pool.end();
           }`,
          JSON.stringify([principal, project, scope, payload]),
        ],
        {
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            PGHOST: host,
            PGPORT: String(port),
            PGDATABASE: database,
            PGUSER: user,
            PGPASSWORD: password,
          },
        },
      );
      return JSON.parse(stdout) as { kind: 'admitted' | 'busy'; run?: unknown; pid: number };
    };
    const admitFirst = () => admit(owner, first.id, firstScope.id);
    const admitSecond = () => admit(owner, second.id, secondScope.id);
    const [firstResult, secondResult] = await Promise.all([admitFirst(), admitSecond()]);
    expect(new Set([process.pid, firstResult.pid, secondResult.pid]).size).toBe(3);
    const firstWon = firstResult.kind === 'admitted';
    const winner = firstWon ? firstResult : secondResult;
    expect(winner.kind).toBe('admitted');
    expect((firstWon ? secondResult : firstResult).kind).toBe('busy');
    await expect(firstWon ? admitFirst() : admitSecond()).resolves.toMatchObject({
      kind: 'admitted',
      run: winner.run,
    });
    const otherScope = await primary.createConversation(independent, other.id);
    await expect(admit(independent, other.id, otherScope.id)).resolves.toMatchObject({
      kind: 'admitted',
      run: { state: 'queued' },
    });

    const pending = randomUUID();
    const loserProject = firstWon ? second : first;
    const loserScope = firstWon ? secondScope : firstScope;
    const { job } = await new JobRepository(peer).enqueue(
      owner,
      loserProject.id,
      `chat:${pending}`,
      'chat.generate',
      { runId: pending },
    );
    await expect(
      peer.query(
        `INSERT INTO chat_runs(id,job_id,tenant_id,owner_oid,project_id,conversation_id,
        idempotency_key,model_id,snapshot,snapshot_hash,assistant_turn_sequence,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,'queued')`,
        [
          pending,
          job.id,
          owner.tenantId,
          owner.objectId,
          loserProject.id,
          loserScope.id,
          payload.idempotencyKey,
          modelId,
          snapshot,
          payload.snapshotHash,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'chat_runs_one_active_owner' });
  } finally {
    await peer.end();
  }
});
