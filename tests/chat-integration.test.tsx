import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { BrowserAuth } from '../src/client/auth.js';
import { createChatApi } from '../src/client/chat-api.js';
import { ChatConsentRepository, ChatConsentService } from '../src/server/chat/consent.js';
import { ChatRepository } from '../src/server/chat/repository.js';
import { ChatRuntime } from '../src/server/chat/runtime.js';
import type { ChatSdkClient } from '../src/server/chat/runtime.js';
import { ChatService } from '../src/server/chat/service.js';
import { chatHandlers } from '../src/server/chat/worker.js';
import { createApp } from '../src/server/app.js';
import { CopilotService } from '../src/server/copilot/service.js';
import { TokenVault } from '../src/server/copilot/secrets.js';
import { ProjectRepository } from '../src/server/projects.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { JobWorker } from '../src/server/jobs/worker.js';
import type { ChatEvent } from '../src/shared/chat.js';
import { alice, config, identityFixture } from './helpers/identity.js';
import { testDatabase } from './helpers/database.js';

const key = Buffer.alloc(32).toString('base64');
const vault = new TokenVault(key);
const owner = { tenantId: config.tenantId, objectId: alice };
const model = { id: 'gpt-6.1-sol', name: 'Synthetic model' };
const enabledConfig = {
  ...config,
  jobsEnabled: true,
  chatEnabled: true as const,
  copilot: { clientId: 'test-client', encryptionKey: key },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  let latest!: T;
  while (Date.now() < deadline) {
    latest = await read();
    if (accepts(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `${label} did not reach the expected state; last value: ${JSON.stringify(latest)}`,
  );
}

function generation(partial: string, suffix: string) {
  return {
    partial,
    suffix,
    started: deferred(),
    release: deferred(),
    abortRequested: deferred(),
    prompt: '',
    token: '',
    modelId: '',
  };
}

function syntheticRuntime(generations: ReturnType<typeof generation>[]) {
  let activeToken = '';
  const client: ChatSdkClient = {
    start: async () => {},
    stop: async () => {},
    listModels: async () => [model],
    createSession: async (options) => {
      const current = generations.shift();
      if (!current) throw new Error('Unexpected synthetic generation.');
      current.token = activeToken;
      current.modelId = options.model;
      let onMessage: (text: string) => void = () => {};
      let onDelta: (text: string) => void = () => {};
      let onIdle: () => void = () => {};
      return {
        onMessage: (handler) => {
          onMessage = handler;
          return () => {};
        },
        onDelta: (handler) => {
          onDelta = handler;
          return () => {};
        },
        onIdle: (handler) => {
          onIdle = handler;
          return () => {};
        },
        send: async ({ prompt }) => {
          current.prompt = prompt;
          current.started.resolve();
          onDelta(current.partial);
          await current.release.promise;
          onDelta(current.suffix);
          onMessage(current.partial + current.suffix);
          onIdle();
        },
        abort: async () => current.abortRequested.resolve(),
        disconnect: async () => {},
      };
    },
  };
  return new ChatRuntime((token) => {
    activeToken = token;
    return client;
  });
}

let db: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** @id TEST-SVC-014 @verifies REQ-SVC-002 */
it('TEST-SVC-014 replays an admitted synthetic run across browser detachment and settles cancellation after local drain', async () => {
  const projects = new ProjectRepository(db.pool);
  const chat = new ChatRepository(db.pool);
  const jobs = new JobRepository(db.pool);
  const project = await projects.create(owner, 'Chat integration');
  const firstConversation = await chat.createConversation(owner, project.id);
  const secondConversation = await chat.createConversation(owner, project.id);
  const first = generation('committed ', 'after reconnect');
  const second = generation('cancelled partial', '');
  const runtime = syntheticRuntime([first, second]);
  const connectionId = randomUUID();
  const connectionGeneration = randomUUID();
  const tokenValue = 'synthetic-owner-token';
  const copilot = new CopilotService({
    pool: db.pool,
    provider: {
      start: async () => ({
        deviceCode: 'unused',
        userCode: 'UNUSED-CODE',
        expiresIn: 900,
        interval: 5,
      }),
      poll: async () => ({ type: 'pending' }),
    },
    secrets: vault,
  });
  await db.pool.query(
    `INSERT INTO copilot_owners(tenant_id,object_id,generation,connection_id,access_token,token_expires_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
    [
      owner.tenantId,
      owner.objectId,
      connectionGeneration,
      connectionId,
      vault.seal(owner, connectionId, 'access-token', tokenValue),
    ],
  );
  const identity = await identityFixture();
  const token = await identity.sign();
  const consent = new ChatConsentService(new ChatConsentRepository(db.pool), copilot, runtime);
  const app = createApp({
    config: enabledConfig,
    projects,
    verifyToken: identity.verify,
    chat: new ChatService(chat, enabledConfig, true, consent),
  });
  let loseNextRunResponse = true;
  let admittedRunId: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : String(input),
        enabledConfig.publicOrigin,
      );
      const request = new Request(requestUrl, init);
      const response = await app.request(request);
      if (
        loseNextRunResponse &&
        request.method === 'POST' &&
        requestUrl.pathname.endsWith('/runs')
      ) {
        loseNextRunResponse = false;
        admittedRunId = ((await response.clone().json()) as { id: string }).id;
        throw new Error('synthetic connection loss after durable admission');
      }
      return response;
    }),
  );

  const auth: BrowserAuth = {
    account: () => ({ id: owner.objectId, name: 'Synthetic owner' }),
    accessToken: async () => token,
    signIn: async () => ({ id: owner.objectId, name: 'Synthetic owner' }),
    signOut: async () => {},
  };
  const api = createChatApi(auth);
  const controller = new AbortController();
  const conversations = await api.listConversations(project.id, controller.signal);
  expect(conversations.items.map(({ id }) => id)).toEqual([
    secondConversation.id,
    firstConversation.id,
  ]);
  expect(await api.discoverModels(project.id, controller.signal)).toEqual([model]);
  const preview = await api.createPreview(
    project.id,
    firstConversation.id,
    { text: 'exact confirmed question', modelId: model.id },
    controller.signal,
  );
  await expect(
    api.confirmPreview(
      project.id,
      firstConversation.id,
      { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
      'same-confirmation-key',
      controller.signal,
    ),
  ).rejects.toThrow('synthetic connection loss after durable admission');
  const recoveredRun = await api.confirmPreview(
    project.id,
    firstConversation.id,
    { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
    'same-confirmation-key',
    controller.signal,
  );
  expect(recoveredRun.id).toBe(admittedRunId);
  expect(
    (
      await db.pool.query('SELECT count(*)::int AS count FROM chat_runs WHERE id=$1', [
        admittedRunId,
      ])
    ).rows[0]?.count,
  ).toBe(1);

  const worker = new JobWorker(jobs, chatHandlers(chat, copilot, runtime), {
    heartbeatMs: 20,
  });
  const firstWorker = worker.runOne();
  await first.started.promise;
  expect(
    await eventually(
      () => chat.getRun(owner, project.id, admittedRunId!),
      (run) => run.answer === first.partial && run.state === 'running',
      'first persisted delta',
    ),
  ).toMatchObject({ answer: first.partial, state: 'running' });
  expect(first.modelId).toBe(model.id);
  expect(first.token).toBe(tokenValue);
  expect(first.prompt).toBe('[{"role":"user","text":"exact confirmed question"}]');

  first.release.resolve();
  await firstWorker;
  expect(await chat.getRun(owner, project.id, admittedRunId!)).toMatchObject({
    answer: first.partial + first.suffix,
    state: 'succeeded',
  });
  const replayed: ChatEvent[] = [];
  await api.subscribe(
    project.id,
    admittedRunId!,
    0,
    (event) => replayed.push(event),
    controller.signal,
  );
  const durable = await chat.listEvents(owner, project.id, admittedRunId!, 0);
  expect(replayed.map(({ sequence }) => sequence)).toEqual(
    durable.items.map(({ sequence }) => sequence),
  );
  expect(replayed.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual([
    first.partial,
    first.suffix,
  ]);
  expect((await chat.listTurns(owner, project.id, firstConversation.id)).items).toHaveLength(2);

  const cancelPreview = await api.createPreview(
    project.id,
    secondConversation.id,
    { text: 'cancel after partial', modelId: model.id },
    controller.signal,
  );
  const cancelledRun = await api.confirmPreview(
    project.id,
    secondConversation.id,
    {
      previewId: cancelPreview.previewId,
      snapshotHash: cancelPreview.snapshotHash,
      confirmed: true,
    },
    'cancelled-run',
    controller.signal,
  );
  const secondWorker = worker.runOne();
  await second.started.promise;
  expect(
    await eventually(
      () => chat.getRun(owner, project.id, cancelledRun.id),
      (run) => run.answer === second.partial && run.state === 'running',
      'cancellable persisted delta',
    ),
  ).toMatchObject({ answer: second.partial, state: 'running' });
  await expect(api.getRun(project.id, cancelledRun.id, controller.signal)).resolves.toMatchObject({
    state: 'running',
  });
  await expect(
    api.cancelRun(project.id, cancelledRun.id, controller.signal),
  ).resolves.toMatchObject({ state: 'cancel_requested', answer: second.partial });
  await second.abortRequested.promise;
  await expect(chat.getRun(owner, project.id, cancelledRun.id)).resolves.toMatchObject({
    answer: second.partial,
    state: 'cancel_requested',
  });
  second.release.resolve();
  await secondWorker;
  await expect(chat.getRun(owner, project.id, cancelledRun.id)).resolves.toMatchObject({
    answer: second.partial,
    state: 'cancelled',
  });
  expect(
    (await chat.listTurns(owner, project.id, secondConversation.id)).items.map(
      ({ role, text }) => ({ role, text }),
    ),
  ).toEqual([
    { role: 'user', text: 'cancel after partial' },
    { role: 'assistant', text: second.partial },
  ]);

  const foreignToken = await identity.sign({ oid: randomUUID() });
  const foreignApi = createChatApi({
    ...auth,
    accessToken: async () => foreignToken,
  });
  await expect(
    foreignApi.getRun(project.id, admittedRunId!, controller.signal),
  ).rejects.toMatchObject({ status: 404 });
  expect(new Set([firstConversation.id, secondConversation.id]).size).toBe(2);
});
