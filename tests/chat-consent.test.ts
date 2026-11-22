import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { CopilotService } from '../src/server/copilot/service.js';
import { TokenVault } from '../src/server/copilot/secrets.js';
import { ChatRuntime } from '../src/server/chat/runtime.js';
import type { ChatSessionOptions, ChatSdkClient } from '../src/server/chat/runtime.js';
import { ChatConsentRepository, ChatConsentService } from '../src/server/chat/consent.js';
import { ProjectRepository } from '../src/server/projects.js';
import { ChatRepository } from '../src/server/chat/repository.js';
import { ChatService } from '../src/server/chat/service.js';
import { chatHandlers } from '../src/server/chat/worker.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { JobWorker } from '../src/server/jobs/worker.js';
import { parseModelInventory } from '../src/server/chat/models.js';
import { parseConfirmInput, parsePrepareInput } from '../src/server/chat/consent.js';
import { createChatSnapshot } from '../src/server/chat/snapshot.js';
import { alice, config, identityFixture } from './helpers/identity.js';
import { testDatabase } from './helpers/database.js';

const credentialOwner = { tenantId: config.tenantId, objectId: alice };
const vault = new TokenVault(Buffer.alloc(32).toString('base64'));
let credentialDb: Awaited<ReturnType<typeof testDatabase>>;
let copilot: CopilotService;

beforeAll(async () => {
  credentialDb = await testDatabase();
  copilot = new CopilotService({
    pool: credentialDb.pool,
    provider: {
      start: async () => ({
        deviceCode: 'test',
        userCode: 'TEST-CODE',
        expiresIn: 900,
        interval: 5,
      }),
      poll: async () => ({ type: 'pending' }),
    },
    secrets: vault,
  });
});

afterAll(async () => {
  await credentialDb?.close();
});

async function createConsentContext(label: string) {
  const owner = { tenantId: config.tenantId, objectId: randomUUID() };
  const project = await new ProjectRepository(credentialDb.pool).create(owner, label);
  const chat = new ChatRepository(credentialDb.pool);
  const conversation = await chat.createConversation(owner, project.id);
  const binding = {
    token: `synthetic-${randomUUID()}`,
    connectionId: randomUUID(),
    generation: randomUUID(),
  };
  await credentialDb.pool.query(
    `INSERT INTO copilot_owners(tenant_id,object_id,generation,connection_id,access_token,token_expires_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
    [
      owner.tenantId,
      owner.objectId,
      binding.generation,
      binding.connectionId,
      vault.seal(owner, binding.connectionId, 'access-token', binding.token),
    ],
  );
  const consentRepository = new ChatConsentRepository(credentialDb.pool);
  const consent = new ChatConsentService(
    consentRepository,
    copilot,
    new ChatRuntime(() => {
      throw new Error('Preparation must not invoke the provider.');
    }),
  );
  return { owner, project, chat, conversation, binding, consent, consentRepository };
}

async function saveConsentCatalog(
  context: Awaited<ReturnType<typeof createConsentContext>>,
): Promise<void> {
  await context.consentRepository.saveModels(context.owner, context.project.id, context.binding, [
    { id: 'gpt-6.1-sol', name: 'Chat model' },
  ]);
}

function workerRuntime(
  listModels: () => Promise<unknown[]>,
  onSend: (prompt: string) => void = () => {},
  held?: { until: Promise<void>; onAbort: () => void },
): ChatRuntime {
  const client: ChatSdkClient = {
    start: async () => {},
    stop: async () => {},
    listModels,
    createSession: async () => {
      let onMessage: (text: string) => void = () => {};
      let onIdle = () => {};
      return {
        onMessage: (handler) => {
          onMessage = handler;
          return () => {};
        },
        onIdle: (handler) => {
          onIdle = handler;
          return () => {};
        },
        send: async ({ prompt }) => {
          onSend(prompt);
          onMessage('synthetic answer');
          await held?.until;
          onIdle();
        },
        abort: async () => held?.onAbort(),
        disconnect: async () => {},
      };
    },
  };
  return new ChatRuntime(() => client);
}

/** @id TEST-CHC-003 @verifies REQ-CHC-003 */
it('TEST-CHC-003 requires strict one-use confirmation and an idempotency key', async () => {
  const valid = {
    previewId: '11111111-1111-4111-8111-111111111111',
    snapshotHash: 'a'.repeat(64),
    confirmed: true as const,
  };
  expect(parseConfirmInput(valid, 'request-1')).toEqual(valid);
  for (const [body, key] of [
    [{ ...valid, confirmed: false }, 'request-1'],
    [{ ...valid, extra: true }, 'request-1'],
    [{ ...valid, snapshotHash: 'A'.repeat(64) }, 'request-1'],
    [valid, null],
    [valid, ''],
    [valid, 'x'.repeat(129)],
  ] as const)
    expect(() => parseConfirmInput(body, key)).toThrow();

  const context = await createConsentContext('Confirm preview test');
  await saveConsentCatalog(context);
  const preview = await context.consent.createPreview(
    context.owner,
    context.project.id,
    context.conversation.id,
    { text: 'confirm this', modelId: 'gpt-6.1-sol' },
  );
  const confirmation = {
    previewId: preview.previewId,
    snapshotHash: preview.snapshotHash,
    confirmed: true as const,
  };
  const admitted = await context.consent.confirmPreview(
    context.owner,
    context.project.id,
    context.conversation.id,
    confirmation,
    'confirm-1',
    context.chat,
  );
  expect(admitted.state).toBe('queued');
  const consumed = await credentialDb.pool.query<{ consumed_at: Date | null }>(
    'SELECT consumed_at FROM chat_previews WHERE id=$1',
    [preview.previewId],
  );
  expect(consumed.rows[0]?.consumed_at).toBeInstanceOf(Date);
  const firstTurn = await credentialDb.pool.query<{ text: string }>(
    `SELECT text FROM chat_turns WHERE conversation_id=$1 AND role='user' ORDER BY sequence LIMIT 1`,
    [context.conversation.id],
  );
  expect(firstTurn.rows[0]?.text).toBe('confirm this');
  const nextPreview = await context.consent.createPreview(
    context.owner,
    context.project.id,
    context.conversation.id,
    { text: 'second message', modelId: 'gpt-6.1-sol' },
  );
  expect(JSON.parse(nextPreview.prompt)).toEqual([
    { role: 'user', text: 'confirm this' },
    { role: 'user', text: 'second message' },
  ]);

  const replay = await context.consent.confirmPreview(
    context.owner,
    context.project.id,
    context.conversation.id,
    confirmation,
    'confirm-1',
    context.chat,
  );
  expect(replay.id).toBe(admitted.id);

  await credentialDb.pool.query(
    `UPDATE chat_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [preview.previewId],
  );
  const replacementId = randomUUID();
  const replacementGeneration = randomUUID();
  await credentialDb.pool.query(
    `UPDATE copilot_owners SET generation=$3,connection_id=$4,access_token=$5
     WHERE tenant_id=$1 AND object_id=$2`,
    [
      context.owner.tenantId,
      context.owner.objectId,
      replacementGeneration,
      replacementId,
      vault.seal(context.owner, replacementId, 'access-token', 'synthetic-replacement'),
    ],
  );
  await expect(
    context.consent.confirmPreview(
      context.owner,
      context.project.id,
      context.conversation.id,
      confirmation,
      'confirm-1',
      context.chat,
    ),
  ).resolves.toMatchObject({ id: admitted.id });
  await expect(
    context.consent.confirmPreview(
      context.owner,
      context.project.id,
      context.conversation.id,
      confirmation,
      'confirm-2',
      context.chat,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await credentialDb.pool.query(
    `UPDATE copilot_owners SET connection_id=NULL,access_token=NULL
     WHERE tenant_id=$1 AND object_id=$2`,
    [context.owner.tenantId, context.owner.objectId],
  );
  await expect(
    context.consent.confirmPreview(
      context.owner,
      context.project.id,
      context.conversation.id,
      confirmation,
      'confirm-1',
      context.chat,
    ),
  ).resolves.toMatchObject({ id: admitted.id });
  await context.chat.cancelRun(context.owner, context.project.id, admitted.id);

  const changedProject = await createConsentContext('Changed project preview test');
  await saveConsentCatalog(changedProject);
  const projectPreview = await changedProject.consent.createPreview(
    changedProject.owner,
    changedProject.project.id,
    changedProject.conversation.id,
    { text: 'project-bound preview', modelId: 'gpt-6.1-sol' },
  );
  await credentialDb.pool.query('UPDATE projects SET version=version+1 WHERE id=$1', [
    changedProject.project.id,
  ]);
  await expect(
    changedProject.consent.confirmPreview(
      changedProject.owner,
      changedProject.project.id,
      changedProject.conversation.id,
      {
        previewId: projectPreview.previewId,
        snapshotHash: projectPreview.snapshotHash,
        confirmed: true,
      },
      'changed-project',
      changedProject.chat,
    ),
  ).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });

  const racing = await createConsentContext('Concurrent preview test');
  await saveConsentCatalog(racing);
  const racingPreview = await racing.consent.createPreview(
    racing.owner,
    racing.project.id,
    racing.conversation.id,
    { text: 'one-use race', modelId: 'gpt-6.1-sol' },
  );
  const racingConfirmation = {
    previewId: racingPreview.previewId,
    snapshotHash: racingPreview.snapshotHash,
    confirmed: true as const,
  };
  const results = await Promise.allSettled(
    ['race-a', 'race-b'].map((key) =>
      racing.consent.confirmPreview(
        racing.owner,
        racing.project.id,
        racing.conversation.id,
        racingConfirmation,
        key,
        racing.chat,
      ),
    ),
  );
  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(succeeded).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  if (rejected[0]?.status === 'rejected')
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
  if (succeeded[0]?.status === 'fulfilled') {
    await racing.chat.cancelRun(racing.owner, racing.project.id, succeeded[0].value.id);
    await expect(
      racing.consent.confirmPreview(
        racing.owner,
        racing.project.id,
        racing.conversation.id,
        racingConfirmation,
        'race-c',
        racing.chat,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
  }

  const stale = await createConsentContext('Stale preview test');
  await saveConsentCatalog(stale);
  const superseded = await stale.consent.createPreview(
    stale.owner,
    stale.project.id,
    stale.conversation.id,
    { text: 'first preview', modelId: 'gpt-6.1-sol' },
  );
  const currentPreview = await stale.consent.createPreview(
    stale.owner,
    stale.project.id,
    stale.conversation.id,
    { text: 'second preview', modelId: 'gpt-6.1-sol' },
  );
  const confirm = (previewId: string, snapshotHash: string, key: string) =>
    stale.consent.confirmPreview(
      stale.owner,
      stale.project.id,
      stale.conversation.id,
      { previewId, snapshotHash, confirmed: true },
      key,
      stale.chat,
    );
  await expect(
    confirm(superseded.previewId, superseded.snapshotHash, 'superseded'),
  ).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
  await credentialDb.pool.query(
    `INSERT INTO chat_turns(id,tenant_id,owner_oid,project_id,conversation_id,sequence,role,text)
     VALUES($1,$2,$3,$4,$5,1,'user','changed after preview')`,
    [
      randomUUID(),
      stale.owner.tenantId,
      stale.owner.objectId,
      stale.project.id,
      stale.conversation.id,
    ],
  );
  await credentialDb.pool.query(
    `UPDATE chat_conversations SET history_revision=history_revision+1 WHERE id=$1`,
    [stale.conversation.id],
  );
  await expect(
    confirm(currentPreview.previewId, currentPreview.snapshotHash, 'changed-history'),
  ).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
  const expired = await stale.consent.createPreview(
    stale.owner,
    stale.project.id,
    stale.conversation.id,
    { text: 'expired preview', modelId: 'gpt-6.1-sol' },
  );
  await credentialDb.pool.query(
    `UPDATE chat_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [expired.previewId],
  );
  await expect(confirm(expired.previewId, expired.snapshotHash, 'expired')).rejects.toMatchObject({
    status: 409,
    code: 'CONSENT_REQUIRED',
  });
});

/** @id TEST-CHC-004 @verifies REQ-CHC-004 */
it('TEST-CHC-004 fences credential changes before dispatch and during generation', async () => {
  const connectionId = randomUUID();
  const generation = randomUUID();
  const firstToken = 'synthetic-first-token';
  await credentialDb.pool.query(
    `INSERT INTO copilot_owners(tenant_id,object_id,generation,connection_id,access_token,token_expires_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
    [
      credentialOwner.tenantId,
      credentialOwner.objectId,
      generation,
      connectionId,
      vault.seal(credentialOwner, connectionId, 'access-token', firstToken),
    ],
  );
  const first = await copilot.chatCredential(credentialOwner);
  expect(first).toMatchObject({ token: firstToken, connectionId, generation });
  const replacementId = randomUUID();
  const replacementGeneration = randomUUID();
  await credentialDb.pool.query(
    `UPDATE copilot_owners SET generation=$3,connection_id=$4,access_token=$5
     WHERE tenant_id=$1 AND object_id=$2`,
    [
      credentialOwner.tenantId,
      credentialOwner.objectId,
      replacementGeneration,
      replacementId,
      vault.seal(credentialOwner, replacementId, 'access-token', 'synthetic-replacement'),
    ],
  );
  await expect(copilot.currentChatCredential(credentialOwner, first)).rejects.toMatchObject({
    status: 409,
  });

  const success = await createConsentContext('Worker success test');
  await saveConsentCatalog(success);
  const preview = await success.consent.createPreview(
    success.owner,
    success.project.id,
    success.conversation.id,
    { text: 'worker prompt', modelId: 'gpt-6.1-sol' },
  );
  const successRun = await success.consent.confirmPreview(
    success.owner,
    success.project.id,
    success.conversation.id,
    { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
    'worker-success',
    success.chat,
  );
  let sentPrompt = '';
  const successWorker = new JobWorker(
    new JobRepository(credentialDb.pool),
    chatHandlers(
      success.chat,
      copilot,
      workerRuntime(
        async () => [{ id: 'gpt-6.1-sol', name: 'Chat' }],
        (prompt) => {
          sentPrompt = prompt;
        },
      ),
    ),
  );
  expect(await successWorker.runOne()).toBe(true);
  expect(sentPrompt).toContain('worker prompt');
  expect(await success.chat.getRun(success.owner, success.project.id, successRun.id)).toMatchObject(
    {
      state: 'succeeded',
      answer: 'synthetic answer',
    },
  );

  const replaced = await createConsentContext('Worker replacement test');
  await saveConsentCatalog(replaced);
  const replacedPreview = await replaced.consent.createPreview(
    replaced.owner,
    replaced.project.id,
    replaced.conversation.id,
    { text: 'must not dispatch', modelId: 'gpt-6.1-sol' },
  );
  const replacedRun = await replaced.consent.confirmPreview(
    replaced.owner,
    replaced.project.id,
    replaced.conversation.id,
    {
      previewId: replacedPreview.previewId,
      snapshotHash: replacedPreview.snapshotHash,
      confirmed: true,
    },
    'worker-replacement',
    replaced.chat,
  );
  let replacementSent = false;
  const replacementWorker = new JobWorker(
    new JobRepository(credentialDb.pool),
    chatHandlers(
      replaced.chat,
      copilot,
      workerRuntime(
        async () => {
          const replacementId = randomUUID();
          await credentialDb.pool.query(
            `UPDATE copilot_owners SET generation=$3,connection_id=$4,access_token=$5
           WHERE tenant_id=$1 AND object_id=$2`,
            [
              replaced.owner.tenantId,
              replaced.owner.objectId,
              randomUUID(),
              replacementId,
              vault.seal(replaced.owner, replacementId, 'access-token', 'synthetic-replacement'),
            ],
          );
          return [{ id: 'gpt-6.1-sol', name: 'Chat' }];
        },
        () => {
          replacementSent = true;
        },
      ),
    ),
  );
  expect(await replacementWorker.runOne()).toBe(true);
  expect(replacementSent).toBe(false);
  expect(
    await replaced.chat.getRun(replaced.owner, replaced.project.id, replacedRun.id),
  ).toMatchObject({
    state: 'failed',
  });

  const unavailable = await createConsentContext('Unavailable model test');
  await saveConsentCatalog(unavailable);
  const unavailablePreview = await unavailable.consent.createPreview(
    unavailable.owner,
    unavailable.project.id,
    unavailable.conversation.id,
    { text: 'do not switch models', modelId: 'gpt-6.1-sol' },
  );
  const unavailableRun = await unavailable.consent.confirmPreview(
    unavailable.owner,
    unavailable.project.id,
    unavailable.conversation.id,
    {
      previewId: unavailablePreview.previewId,
      snapshotHash: unavailablePreview.snapshotHash,
      confirmed: true,
    },
    'worker-model-unavailable',
    unavailable.chat,
  );
  let unavailableSent = false;
  const unavailableWorker = new JobWorker(
    new JobRepository(credentialDb.pool),
    chatHandlers(
      unavailable.chat,
      copilot,
      workerRuntime(
        async () => [{ id: 'different-model', name: 'Other' }],
        () => {
          unavailableSent = true;
        },
      ),
    ),
  );
  expect(await unavailableWorker.runOne()).toBe(true);
  expect(unavailableSent).toBe(false);
  expect(
    await unavailable.chat.getRun(unavailable.owner, unavailable.project.id, unavailableRun.id),
  ).toMatchObject({ state: 'failed', answer: '' });

  const active = await createConsentContext('Disconnect during generation');
  await saveConsentCatalog(active);
  const activePreview = await active.consent.createPreview(
    active.owner,
    active.project.id,
    active.conversation.id,
    { text: 'stop active generation', modelId: 'gpt-6.1-sol' },
  );
  const activeRun = await active.consent.confirmPreview(
    active.owner,
    active.project.id,
    active.conversation.id,
    {
      previewId: activePreview.previewId,
      snapshotHash: activePreview.snapshotHash,
      confirmed: true,
    },
    'worker-disconnect',
    active.chat,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn();
  const abort = vi.fn(() => release());
  const activeWorker = new JobWorker(
    new JobRepository(credentialDb.pool),
    chatHandlers(
      active.chat,
      copilot,
      workerRuntime(async () => [{ id: 'gpt-6.1-sol', name: 'Chat' }], send, {
        until: held,
        onAbort: abort,
      }),
    ),
  );
  const running = activeWorker.runOne();
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await copilot.disconnect(active.owner);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce(), { timeout: 6500 });
  } finally {
    release();
    await running;
  }
  expect(send).toHaveBeenCalledExactlyOnceWith(activePreview.prompt);
  expect(await active.chat.getRun(active.owner, active.project.id, activeRun.id)).toMatchObject({
    state: 'failed',
    answer: '',
  });
});

it('interrupts a stalled chat worker at the DB run deadline and keeps only committed text', async () => {
  const context = await createConsentContext('Worker run deadline');
  await saveConsentCatalog(context);
  const { owner, project, conversation, consent, chat } = context;
  const preview = await consent.createPreview(owner, project.id, conversation.id, {
    text: 'deadline question',
    modelId: 'gpt-6.1-sol',
  });
  const run = await consent.confirmPreview(
    owner,
    project.id,
    conversation.id,
    { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
    'worker-run-deadline',
    chat,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abort = vi.fn(release);
  const send = vi.fn();
  const runtime = new ChatRuntime(() => ({
    start: async () => {},
    stop: async () => {},
    listModels: async () => [{ id: 'gpt-6.1-sol', name: 'Chat' }],
    createSession: async () => {
      let delta: (text: string) => void = () => {};
      let idle = () => {};
      return {
        onMessage: () => () => {},
        onDelta: (handler) => {
          delta = handler;
          return () => {};
        },
        onIdle: (handler) => {
          idle = handler;
          return () => {};
        },
        send: async () => {
          send();
          delta('committed prefix');
          await held;
          delta('too late');
          idle();
        },
        abort: async () => abort(),
        disconnect: async () => {},
      };
    },
  }));
  const worker = new JobWorker(
    new JobRepository(credentialDb.pool),
    chatHandlers(chat, copilot, runtime),
    { heartbeatMs: 25 },
  );
  const running = worker.runOne();
  try {
    await vi.waitFor(async () => {
      expect(await chat.getRun(owner, project.id, run.id)).toMatchObject({
        state: 'running',
        answer: 'committed prefix',
      });
    });
    await credentialDb.pool.query(
      `UPDATE durable_jobs SET started_at=clock_timestamp()-interval '300 seconds'
       WHERE id=(SELECT job_id FROM chat_runs WHERE id=$1)`,
      [run.id],
    );
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
  } finally {
    release();
    await running;
  }
  expect(await chat.getRun(owner, project.id, run.id)).toMatchObject({
    state: 'failed',
    answer: 'committed prefix',
    failureCode: 'interrupted',
  });
  await expect(worker.runOne()).resolves.toBe(false);
  expect(send).toHaveBeenCalledOnce();
});

/** @id TEST-CHC-001 @verifies REQ-CHC-001 */
it('TEST-CHC-001 accepts strict model inventory and captures account-only SDK requests', async () => {
  const valid = [{ id: 'gpt-6.1-sol', name: 'Chat 🦊' }];
  expect(parseModelInventory(valid)).toEqual(valid);
  expect(() => parseModelInventory([...valid, { id: valid[0]!.id, name: 'Duplicate' }])).toThrow();
  expect(() => parseModelInventory([{ id: '', name: 'Invalid' }])).toThrow();
  expect(() => parseModelInventory([{ id: 'valid', name: `x${'\u0000'}` }])).toThrow();
  expect(() => parseModelInventory([{ id: 'valid', name: 'x'.repeat(201) }])).toThrow();
  expect(() =>
    parseModelInventory(
      Array.from({ length: 1001 }, (_, index) => ({ id: `m${index}`, name: 'Model' })),
    ),
  ).toThrow();

  let token = '';
  let discoveryCalls = 0;
  let sessionOptions: ChatSessionOptions | undefined;
  let sendInput: { prompt: string } | undefined;
  let stopped = false;
  const client: ChatSdkClient = {
    start: async () => {},
    stop: async () => {
      stopped = true;
    },
    listModels: async () => {
      discoveryCalls += 1;
      return [{ id: valid[0]!.id, name: valid[0]!.name, privatePayload: 'secret' }];
    },
    createSession: async (options) => {
      sessionOptions = options;
      let onMessage: (text: string) => void = () => {};
      let onIdle = () => {};
      return {
        onMessage: (handler) => {
          onMessage = handler;
          return () => {};
        },
        onIdle: (handler) => {
          onIdle = handler;
          return () => {};
        },
        send: async (input) => {
          sendInput = input;
          onMessage('answer');
          onIdle();
        },
        abort: async () => {},
        disconnect: async () => {},
      };
    },
  };
  const runtime = new ChatRuntime((value) => {
    token = value;
    return client;
  });
  expect(await runtime.listModels('synthetic-token')).toEqual(valid);
  const projectOwner = { tenantId: config.tenantId, objectId: randomUUID() };
  const project = await new ProjectRepository(credentialDb.pool).create(
    projectOwner,
    'Consent test',
  );
  const connectionId = randomUUID();
  await credentialDb.pool.query(
    `INSERT INTO copilot_owners(tenant_id,object_id,generation,connection_id,access_token,token_expires_at)
     VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
    [
      projectOwner.tenantId,
      projectOwner.objectId,
      randomUUID(),
      connectionId,
      vault.seal(projectOwner, connectionId, 'access-token', 'synthetic-token'),
    ],
  );
  const consent = new ChatConsentService(
    new ChatConsentRepository(credentialDb.pool),
    copilot,
    runtime,
  );
  await expect(consent.discoverModels(projectOwner, project.id, false)).rejects.toMatchObject({
    status: 400,
  });
  const catalog = await consent.discoverModels(projectOwner, project.id, true);
  expect(catalog.models).toEqual(valid);
  expect(catalog).not.toHaveProperty('token');
  expect(discoveryCalls).toBe(2);
  await expect(
    consent.discoverModels({ ...projectOwner, objectId: randomUUID() }, project.id, true),
  ).rejects.toMatchObject({ status: 404 });
  expect(discoveryCalls).toBe(2);
  await expect(
    runtime.generate(
      'synthetic-token',
      valid[0]!.id,
      'approved system',
      'approved prompt',
      new AbortController().signal,
    ),
  ).resolves.toBe('answer');
  expect(token).toBe('synthetic-token');
  expect(sessionOptions).toEqual({
    model: valid[0]!.id,
    systemMessage: { mode: 'replace', content: 'approved system' },
    tools: { availableTools: [] },
    github: { telemetryEnabled: false },
  });
  expect(sendInput).toEqual({ prompt: 'approved prompt' });
  expect(stopped).toBe(true);

  const failureContext = await createConsentContext('Discovery failure');
  const discovery = async (listModels: () => Promise<unknown[]>) =>
    new ChatConsentService(
      failureContext.consentRepository,
      copilot,
      workerRuntime(listModels),
    ).discoverModels(failureContext.owner, failureContext.project.id, true);
  for (const listModels of [
    async () => {
      throw new Error('synthetic-private-provider-response');
    },
    async () => [{ id: 'invalid id', name: 'synthetic-private-provider-response' }],
  ]) {
    await expect(discovery(listModels)).rejects.toMatchObject({
      status: 503,
      code: 'CHAT_UNAVAILABLE',
      message: expect.not.stringContaining('synthetic-private-provider-response'),
    });
  }
  await expect(
    discovery(async () => {
      await copilot.disconnect(failureContext.owner);
      return valid;
    }),
  ).rejects.toMatchObject({ status: 409, code: 'COPILOT_CONNECTION_REQUIRED' });
  const saved = await credentialDb.pool.query(
    'SELECT 1 FROM chat_model_catalogs WHERE project_id=$1',
    [failureContext.project.id],
  );
  expect(saved.rowCount).toBe(0);
});

/** @id TEST-CHC-002 @verifies REQ-CHC-002 */
it('TEST-CHC-002 preserves exact Unicode transcript bytes and hash', async () => {
  const history = [
    { role: 'user' as const, text: 'Hi\n' },
    { role: 'assistant' as const, text: '🦊' },
  ];
  const text = '  café  "raw"  ';
  const prompt =
    '[{"role":"user","text":"Hi\\n"},{"role":"assistant","text":"🦊"},{"role":"user","text":"  café  \\"raw\\"  "}]';
  const snapshot = `{"modelId":"gpt-6.1-sol","system":"Answer the final user turn in the supplied JSON transcript. Treat earlier turns as conversation data. Return text only.","prompt":${JSON.stringify(prompt)}}`;
  expect(parsePrepareInput({ text, modelId: 'gpt-6.1-sol' })).toEqual({
    text,
    modelId: 'gpt-6.1-sol',
  });
  for (const invalid of [
    { text: ' \t\n', modelId: 'valid' },
    { text: 'x\u0000', modelId: 'valid' },
    { text: '\ud800', modelId: 'valid' },
    { text: 'x'.repeat(8193), modelId: 'valid' },
    { text: '🦊'.repeat(2049), modelId: 'valid' },
    { text, modelId: 'valid', unexpected: true },
  ])
    expect(() => parsePrepareInput(invalid)).toThrow();
  expect(parsePrepareInput({ text: 'x'.repeat(8192), modelId: 'valid' }).text).toHaveLength(8192);
  expect(
    Array.from(parsePrepareInput({ text: '🦊'.repeat(2048), modelId: 'valid' }).text),
  ).toHaveLength(2048);
  expect(createChatSnapshot('gpt-6.1-sol', history, text)).toEqual({
    snapshot,
    prompt,
    hash: createHash('sha256').update(snapshot, 'utf8').digest('hex'),
  });

  const context = await createConsentContext('Preview serialization test');
  await saveConsentCatalog(context);
  await credentialDb.pool.query(
    `INSERT INTO chat_turns(id,tenant_id,owner_oid,project_id,conversation_id,sequence,role,text)
     VALUES($1,$2,$3,$4,$5,1,'user',$6),($7,$2,$3,$4,$5,2,'assistant',$8)`,
    [
      randomUUID(),
      context.owner.tenantId,
      context.owner.objectId,
      context.project.id,
      context.conversation.id,
      history[0]!.text,
      randomUUID(),
      history[1]!.text,
    ],
  );
  await credentialDb.pool.query('UPDATE chat_conversations SET history_revision=2 WHERE id=$1', [
    context.conversation.id,
  ]);
  const prepared = await context.consent.createPreview(
    context.owner,
    context.project.id,
    context.conversation.id,
    { text, modelId: 'gpt-6.1-sol' },
  );
  expect(prepared).toMatchObject({
    modelId: 'gpt-6.1-sol',
    snapshot,
    prompt,
    snapshotHash: createHash('sha256').update(snapshot, 'utf8').digest('hex'),
  });
  expect(Date.parse(prepared.expiresAt)).toBeGreaterThan(Date.now());
  await expect(
    context.consent.createPreview(context.owner, context.project.id, context.conversation.id, {
      text,
      modelId: 'unlisted-model',
    }),
  ).rejects.toMatchObject({ status: 409 });
  await credentialDb.pool.query(
    `UPDATE chat_model_catalogs SET expires_at=clock_timestamp()-interval '1 second'
     WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3`,
    [context.owner.tenantId, context.owner.objectId, context.project.id],
  );
  await expect(
    context.consent.createPreview(context.owner, context.project.id, context.conversation.id, {
      text,
      modelId: 'gpt-6.1-sol',
    }),
  ).rejects.toMatchObject({ status: 409 });

  await saveConsentCatalog(context);
  const baseBytes = Buffer.byteLength(snapshot);
  const padding = 'x'.repeat(262144 - baseBytes);
  for (const extra of ['', 'x']) {
    await credentialDb.pool.query(
      'UPDATE chat_turns SET text=$2 WHERE conversation_id=$1 AND sequence=2',
      [context.conversation.id, history[1]!.text + padding + extra],
    );
    const result = context.consent.createPreview(
      context.owner,
      context.project.id,
      context.conversation.id,
      { text, modelId: 'gpt-6.1-sol' },
    );
    if (extra) await expect(result).rejects.toMatchObject({ status: 413 });
    else expect(Buffer.byteLength((await result).snapshot)).toBe(262144);
  }

  // An isolated PostgreSQL search path freezes only this pool's clock, so equality cannot drift.
  await credentialDb.pool.query(`CREATE SCHEMA consent_test_time;
    CREATE FUNCTION consent_test_time.clock_timestamp() RETURNS timestamptz LANGUAGE sql
    AS $$ SELECT TIMESTAMPTZ '2026-01-01 00:00:00+00' $$`);
  const fixedPool = new Pool({
    ...credentialDb.pool.options,
    options: '-c search_path=consent_test_time,pg_catalog,public',
  });
  try {
    const clockContext = await createConsentContext('Exact expiry boundary');
    await saveConsentCatalog(clockContext);
    const fixedConsent = new ChatConsentService(
      new ChatConsentRepository(fixedPool),
      copilot,
      workerRuntime(async () => {
        throw new Error('Unexpected discovery');
      }),
    );
    const prepare = () =>
      fixedConsent.createPreview(
        clockContext.owner,
        clockContext.project.id,
        clockContext.conversation.id,
        { text, modelId: 'gpt-6.1-sol' },
      );
    const edge = '2026-01-01T00:00:00.000Z';
    const after = '2026-01-01T00:00:00.001Z';
    const setCatalogExpiry = (at: string) =>
      credentialDb.pool.query('UPDATE chat_model_catalogs SET expires_at=$2 WHERE project_id=$1', [
        clockContext.project.id,
        at,
      ]);
    await setCatalogExpiry(edge);
    await expect(prepare()).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
    await setCatalogExpiry(after);
    const preview = await prepare();
    const confirm = () =>
      fixedConsent.confirmPreview(
        clockContext.owner,
        clockContext.project.id,
        clockContext.conversation.id,
        { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
        'clock-boundary',
        new ChatRepository(fixedPool),
      );
    const setPreviewExpiry = (at: string) =>
      credentialDb.pool.query('UPDATE chat_previews SET expires_at=$2 WHERE id=$1', [
        preview.previewId,
        at,
      ]);
    await setPreviewExpiry(edge);
    await expect(confirm()).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
    await setPreviewExpiry(after);
    await setCatalogExpiry(edge);
    await expect(confirm()).rejects.toMatchObject({ status: 409, code: 'CONSENT_REQUIRED' });
    await setCatalogExpiry(after);
    const run = await confirm();
    expect(run.state).toBe('queued');
    await clockContext.chat.cancelRun(clockContext.owner, clockContext.project.id, run.id);
  } finally {
    await fixedPool.end();
  }
});

/** @id TEST-CHC-005 @verifies REQ-CHC-005 */
it('TEST-CHC-005 rejects unknown capabilities before persistence or provider access', async () => {
  const context = await createConsentContext('Strict capability test');
  await saveConsentCatalog(context);
  for (const extra of [
    { fileIds: ['file-id'] },
    { tools: ['shell'] },
    { skills: ['custom'] },
    { mcp: { url: 'https://example.invalid' } },
    { credentials: 'synthetic-secret' },
    { role: 'system' },
    { customAgent: true },
  ]) {
    await expect(
      context.consent.createPreview(context.owner, context.project.id, context.conversation.id, {
        text: 'safe input',
        modelId: 'gpt-6.1-sol',
        ...extra,
      }),
    ).rejects.toMatchObject({ status: 400 });
  }
  const rows = await credentialDb.pool.query(
    `SELECT count(*)::int AS count FROM chat_previews
     WHERE tenant_id=$1 AND owner_oid=$2 AND project_id=$3`,
    [context.owner.tenantId, context.owner.objectId, context.project.id],
  );
  expect(rows.rows[0]?.count).toBe(0);

  const discovery = vi.fn(async () => [{ id: 'gpt-6.1-sol', name: 'Chat model' }]);
  const identity = await identityFixture();
  const token = await identity.sign({ oid: context.owner.objectId });
  const consent = new ChatConsentService(
    context.consentRepository,
    copilot,
    workerRuntime(discovery),
  );
  const enabled = {
    ...config,
    jobsEnabled: true,
    chatEnabled: true as const,
    copilot: { clientId: 'test-client', encryptionKey: Buffer.alloc(32).toString('base64') },
  };
  const options = {
    projects: new ProjectRepository(credentialDb.pool),
    verifyToken: identity.verify,
  };
  const app = createApp({
    ...options,
    config: enabled,
    chat: new ChatService(context.chat, enabled, true, consent),
  });
  const disabled = createApp({ ...options, config });
  const main = `/api/projects/${context.project.id}/chat`;
  const conversation = `${main}/conversations/${context.conversation.id}`;
  const payload = JSON.stringify({ text: 'HTTP consent', modelId: 'gpt-6.1-sol' });
  const post = (path: string, body: string, headers: Record<string, string> = {}, server = app) =>
    server.request(path, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    });
  const padded = payload.padEnd(16384, ' ');
  const discoveryPath = `${main}/models`;
  const previewsPath = `${conversation}/previews`;
  const runsPath = `${conversation}/runs`;
  for (const [path, body] of [
    [discoveryPath, '{"confirmed":true,"extra":true}'],
    [discoveryPath, '{"confirmed":false}'],
    [previewsPath, '{"text":"x","modelId":"gpt-6.1-sol","extra":true}'],
  ] as const) {
    const invalid = await post(path, body, { 'Idempotency-Key': 'route-key' });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(discovery).not.toHaveBeenCalled();
  expect(
    (await post(main.replace(context.project.id, randomUUID()) + '/models', '{}', {}, disabled))
      .status,
  ).toBe(404);
  expect((await post(discoveryPath, '{}', {}, disabled)).status).toBe(503);
  expect((await post(previewsPath, payload, { 'Content-Type': 'text/plain' })).status).toBe(400);
  expect((await post(previewsPath, padded + ' ')).status).toBe(413);
  expect((await post(discoveryPath, '{"confirmed":true}')).status).toBe(200);
  expect(discovery).toHaveBeenCalledOnce();
  const prepared = await post(previewsPath, padded);
  expect(prepared.status).toBe(201);
  expect(prepared.headers.get('Cache-Control')).toBe('no-store');
  const { previewId, snapshotHash } = await prepared.json();
  const confirmation = JSON.stringify({ previewId, snapshotHash, confirmed: true });
  expect((await post(runsPath, confirmation)).status).toBe(400);
  const unexpected = await post(
    runsPath,
    JSON.stringify({ previewId, snapshotHash, confirmed: true, extra: true }),
    { 'Idempotency-Key': 'route-key' },
  );
  expect(unexpected.status).toBe(400);
  expect(unexpected.headers.get('Cache-Control')).toBe('no-store');
  const admitted = await post(runsPath, confirmation, { 'Idempotency-Key': 'route-key' });
  expect(admitted.status).toBe(202);
  expect(admitted.headers.get('Cache-Control')).toBe('no-store');
  const { id } = await admitted.json();
  const replay = await post(runsPath, confirmation, { 'Idempotency-Key': 'route-key' });
  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({ id });
  expect(discovery).toHaveBeenCalledOnce();
  await context.chat.cancelRun(context.owner, context.project.id, id);
});
