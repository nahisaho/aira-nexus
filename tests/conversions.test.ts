import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ConversionFileRepository,
  ConversionRepository,
} from '../src/server/conversion/repository.js';
import { readConversionConfig } from '../src/server/conversion/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { FileRepository } from '../src/server/files/repository.js';
import { JobRepository } from '../src/server/jobs/repository.js';
import { testDatabase } from './helpers/database.js';
import type { JobClaim } from '../src/shared/jobs.js';
import { createApp } from '../src/server/app.js';
import { config } from './helpers/identity.js';
import { FileService } from '../src/server/files/service.js';
import { JobService, JobExecutionUnconfirmed } from '../src/server/jobs/service.js';
import { JobWorker } from '../src/server/jobs/worker.js';
import { conversionHandlers } from '../src/server/conversion/worker.js';
import {
  ConversionRuntimeError,
  DoclingRuntime,
  type ConversionRuntimeInput,
} from '../src/server/conversion/runtime.js';
import { testBlobStorage } from './helpers/blob.js';
import type { BlobStore } from '../src/server/files/store.js';
import type { ConversionPage, ConversionRequest } from '../src/shared/conversions.js';

const owner = { tenantId: randomUUID(), objectId: randomUUID() };
const other = { ...owner, objectId: randomUUID() };
let db: Awaited<ReturnType<typeof testDatabase>>;
let projects: ProjectRepository;
let files: FileRepository;
let jobs: JobRepository;
let conversions: ConversionRepository;
beforeAll(async () => {
  db = await testDatabase();
  projects = new ProjectRepository(db.pool);
  files = new FileRepository(db.pool);
  jobs = new JobRepository(db.pool);
  conversions = new ConversionRepository(db.pool);
});
beforeEach(async () => {
  const found = await db.pool.query("SELECT to_regclass('document_conversion_requests') AS name");
  if (found.rows[0].name) await db.pool.query('TRUNCATE document_conversion_requests');
  await db.pool.query(
    'TRUNCATE chat_previews,chat_events,chat_runs,chat_turns,chat_conversations,durable_jobs',
  );
});
afterAll(async () => {
  await db?.close();
});
async function source(name = 'synthetic.pdf', size = 1, who = owner) {
  const project = await projects.create(who, 'Synthetic conversions');
  const id = await files.reserve(who, project.id, { name, size });
  const file = await files.finalize(who, project.id, id, 'a'.repeat(64), 'synthetic');
  return { project, file };
}
async function claim(project: string, id: string): Promise<JobClaim> {
  await conversions.request(owner, project, id, randomUUID());
  expect(await conversions.dispatch()).toBe(1);
  const current = await jobs.claim(['document.convert']);
  if (!current) throw new Error('Expected admitted conversion.');
  return current;
}

/** @id TEST-DCV-001 @verifies REQ-DCV-001 */
it('TEST-DCV-001 atomically retains automatic waiting without queue admission and excludes generated/oversized files', async () => {
  await expect(
    (async () => {
      const project = await projects.create(owner, 'Automatic conversion');
      const id = await files.reserve(owner, project.id, { name: 'automatic.pdf', size: 1 });
      const ready = await conversions.finalizeUpload(owner, project.id, id, 'b'.repeat(64), 'etag');
      expect(ready.id).toBe(id);
      const page = await conversions.list(owner, project.id);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ sourceId: id, state: 'waiting', jobId: null });
      expect(
        (await db.pool.query('SELECT count(*)::int AS count FROM durable_jobs')).rows[0].count,
      ).toBe(0);
      for (const [name, size] of [
        ['generated.md', 1],
        ['large.pdf', 25000001],
      ] as const) {
        const next = await files.reserve(owner, project.id, { name, size });
        await conversions.finalizeUpload(owner, project.id, next, 'c'.repeat(64), 'etag');
      }
      return (await conversions.list(owner, project.id)).items.length;
    })(),
  ).resolves.toBe(1);
});

/** @id TEST-DCV-002 @verifies REQ-DCV-002 */
it('TEST-DCV-002 fences both owner axes and atomically deduplicates replay and active sources', async () => {
  await expect(
    (async () => {
      const { project, file } = await source();
      const key = randomUUID();
      const first = await conversions.request(owner, project.id, file.id, key);
      expect(first).toMatchObject({ created: true, request: { state: 'waiting' } });
      const replay = await conversions.request(owner, project.id, file.id, key);
      expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
      await expect(
        conversions.request(owner, project.id, file.id, randomUUID()),
      ).rejects.toMatchObject({ status: 409 });
      for (const who of [other, { ...owner, tenantId: randomUUID() }]) {
        await expect(conversions.request(who, project.id, file.id, key)).rejects.toMatchObject({
          status: 404,
        });
      }
      const unsupported = await source('notes.md');
      await expect(
        conversions.request(owner, unsupported.project.id, unsupported.file.id, randomUUID()),
      ).rejects.toMatchObject({ status: 415 });
      const large = await source('large.pdf', 25000001);
      await expect(
        conversions.request(owner, large.project.id, large.file.id, randomUUID()),
      ).rejects.toMatchObject({ status: 413 });
      return replay.request.id;
    })(),
  ).resolves.toEqual(expect.any(String));
});

/** @id TEST-DCV-003 @verifies REQ-DCV-003 */
it('TEST-DCV-003 leaves capped owners waiting while admitting another owner exactly once across dispatchers', async () => {
  await expect(
    (async () => {
      const a = await source();
      for (let index = 0; index < 20; index++)
        await jobs.enqueue(owner, a.project.id, randomUUID(), 'synthetic', {});
      await conversions.request(owner, a.project.id, a.file.id, randomUUID());
      const b = await source('other.pdf', 1, other);
      await conversions.request(other, b.project.id, b.file.id, randomUUID());
      const counts = await Promise.all([conversions.dispatch(), conversions.dispatch()]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect((await conversions.list(owner, a.project.id)).items[0]?.state).toBe('waiting');
      return (await conversions.list(other, b.project.id)).items[0]?.state;
    })(),
  ).resolves.toBe('queued');
});

/** @id TEST-DCV-004 @verifies REQ-DCV-004 */
it('TEST-DCV-004 publishes both outputs and success together but rejects cancel/expired/reservation/source/quota fences', async () => {
  await expect(
    (async () => {
      for (const control of [
        'valid',
        'cancel',
        'lease',
        'reservation',
        'identity',
        'source',
        'quota',
      ] as const) {
        const { project, file } = await source();
        const current = await claim(project.id, file.id);
        const pair = await conversions.reserveOutputs(current, { markdown: 1, json: 2 });
        const publication = {
          markdown: { id: pair.markdown, sha256: 'b'.repeat(64), etag: 'md-etag' },
          json: { id: pair.json, sha256: 'c'.repeat(64), etag: 'json-etag' },
        };
        if (control === 'cancel') await jobs.cancel(owner, project.id, current.job.id);
        if (control === 'lease')
          await db.pool.query(
            "UPDATE durable_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [current.job.id],
          );
        if (control === 'reservation')
          await db.pool.query(
            "UPDATE project_files SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [pair.markdown],
          );
        if (control === 'source') await files.setTrashed(owner, project.id, file.id, true);
        if (control === 'identity')
          await db.pool.query('UPDATE project_files SET sha256=$2 WHERE id=$1', [
            file.id,
            'e'.repeat(64),
          ]);
        if (control === 'quota') {
          await db.pool.query(
            "INSERT INTO project_files(id,project_id,name,size_bytes,kind,state,sha256,etag) SELECT gen_random_uuid(),$1,'quota.md',100000000,'text','ready',$2,'synthetic' FROM generate_series(1,100)",
            [project.id, 'd'.repeat(64)],
          );
        }
        await conversions.settle(current, 'success', { publication });
        const page = await files.list(owner, project.id);
        const visible = page.items.filter((item) => [pair.markdown, pair.json].includes(item.id));
        expect(visible).toHaveLength(control === 'valid' ? 2 : 0);
        const job = await jobs.get(owner, project.id, current.job.id);
        expect(job.state === 'succeeded').toBe(control === 'valid');
      }
      return true;
    })(),
  ).resolves.toBe(true);
});

/** @id TEST-DCV-005 @verifies REQ-DCV-005 */
it('TEST-DCV-005 cancels waiting atomically, preserves typed failure history and suppresses purged output links', async () => {
  await expect(
    (async () => {
      const { project, file } = await source();
      const first = await conversions.request(owner, project.id, file.id, randomUUID());
      expect((await conversions.cancel(owner, project.id, first.request.id)).state).toBe(
        'cancelled',
      );
      expect(await conversions.dispatch()).toBe(0);
      const current = await claim(project.id, file.id);
      await conversions.settle(current, 'error', { reason: 'page_limit' });
      const page = await conversions.list(owner, project.id);
      expect(page.items).toHaveLength(2);
      expect(page.items.find((item) => item.jobId === current.job.id)).toMatchObject({
        state: 'failed',
        reason: 'page_limit',
      });
      await expect(conversions.get(other, project.id, first.request.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(conversions.list(owner, project.id, 'invalid')).rejects.toMatchObject({
        status: 400,
      });
      const success = await claim(project.id, file.id);
      const pair = await conversions.reserveOutputs(success, { markdown: 1, json: 2 });
      await conversions.settle(success, 'success', {
        publication: {
          markdown: { id: pair.markdown, sha256: 'b'.repeat(64), etag: 'markdown' },
          json: { id: pair.json, sha256: 'c'.repeat(64), etag: 'json' },
        },
      });
      await files.setTrashed(owner, project.id, pair.markdown, true);
      await db.pool.query('DELETE FROM project_files WHERE id=$1', [pair.json]);
      const history = (await conversions.list(owner, project.id)).items.find(
        (item) => item.jobId === success.job.id,
      );
      expect(history).toMatchObject({
        state: 'succeeded',
        artifacts: {
          markdown: { id: pair.markdown, availability: 'trashed', file: null },
          json: { id: pair.json, availability: 'missing', file: null },
        },
      });
      return page.nextCursor;
    })(),
  ).resolves.toBeNull();
});

/** @id TEST-DCV-006 @verifies REQ-DCV-006 */
it('TEST-DCV-006 releases terminal active guards for fresh retries and never reruns uncertain failed jobs', async () => {
  await expect(
    (async () => {
      const { project, file } = await source();
      const current = await claim(project.id, file.id);
      await jobs.finish(current, 'error', 'interrupted');
      const retry = await conversions.request(owner, project.id, file.id, randomUUID());
      expect(retry.created).toBe(true);
      expect(retry.request.jobId).toBeNull();
      expect((await jobs.get(owner, project.id, current.job.id)).state).toBe('failed');
      expect(await conversions.dispatch()).toBe(1);
      expect(await conversions.dispatch()).toBe(0);
      return (await conversions.list(owner, project.id)).items.map((item) => item.state).sort();
    })(),
  ).resolves.toEqual(['failed', 'queued']);
});

/** @id TEST-DCV-007 @verifies REQ-DCV-007 */
it('TEST-DCV-007 defaults off and refuses incomplete opt-in dependencies without accepting arbitrary handlers', () => {
  const dependencies = { jobsEnabled: true, filesConfigured: true };
  expect(() => readConversionConfig({}, dependencies)).not.toThrow();
  expect(readConversionConfig({}, dependencies)).toBeUndefined();
  expect(
    readConversionConfig({ DOCUMENT_CONVERSION_ENABLED: 'false' }, dependencies),
  ).toBeUndefined();
  expect(() =>
    readConversionConfig({ DOCUMENT_CONVERSION_ENABLED: 'TRUE' }, dependencies),
  ).toThrow();
  expect(() =>
    readConversionConfig({ DOCUMENT_CONVERSION_ENABLED: 'true' }, dependencies),
  ).toThrow();
});

it('enabled conversion API validates resource ownership before bodies, acknowledges replay and cancellation, and reserves its job type', async () => {
  const { project, file } = await source();
  const app = createApp({
    config: {
      ...config,
      conversion: {
        imageId: `sha256:${'8'.repeat(64)}`,
        modelsPath: '/not-activated/models',
        modelManifestPath: '/not-activated/models.json',
        namespace: 'synthetic-api',
      },
    },
    projects,
    conversions,
    verifyToken: async (token) => ({ ok: true, principal: token === 'other' ? other : owner }),
  });
  const root = `/api/projects/${project.id}`;
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const key = randomUUID();
  const post = (body: string, id = file.id, extra = {}) =>
    app.request(`${root}/files/${id}/conversions`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key, ...extra },
      body,
    });
  expect(await (await app.request(`${root}/conversions/capabilities`, { headers })).json()).toEqual(
    { enabled: true },
  );
  expect((await post('{', randomUUID())).status).toBe(404);
  expect((await post('{', file.id, { Authorization: 'Bearer other' })).status).toBe(404);
  for (const body of ['{', 'null', '[]', '{"extra":true}'])
    expect((await post(body)).status).toBe(400);
  const responses = await Promise.all(Array.from({ length: 5 }, () => post('{}')));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 202]);
  const rows = await Promise.all(
    responses.map((response) => response.json() as Promise<ConversionRequest>),
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(1);
  const row = rows[0]!;
  const cancel = (body?: string) =>
    app.request(`${root}/conversions/${row.id}/cancel`, {
      method: 'POST',
      headers,
      ...(body ? { body } : {}),
    });
  expect((await cancel('{}')).status).toBe(400);
  expect((await conversions.get(owner, project.id, row.id)).state).toBe('waiting');
  const cancelled = (await (await cancel()).json()) as ConversionRequest;
  expect(cancelled.state).toBe('cancelled');
  expect(await (await cancel()).json()).toEqual(cancelled);
  expect((await app.request(`${root}/conversions?cursor=x&cursor=y`, { headers })).status).toBe(
    400,
  );
  expect(
    (
      await app.request(`${root}/conversions/${randomUUID()}/cancel`, {
        method: 'POST',
        headers,
        body: '{',
      })
    ).status,
  ).toBe(404);
  const page = (await (
    await app.request(`${root}/conversions`, { headers })
  ).json()) as ConversionPage;
  expect(page.items).toEqual([cancelled]);
  const handlers = conversionHandlers(
    conversions,
    {
      put: async () => {
        throw new Error('Must not stage via generic job API.');
      },
      read: async () => {
        throw new Error('Must not read via generic job API.');
      },
      remove: async () => {},
    },
    {
      ready: async () => {},
      convert: async () => {
        throw new Error('Must not execute via generic job API.');
      },
    },
  );
  await expect(
    new JobService(jobs, handlers).enqueue(owner, project.id, randomUUID(), {
      type: 'document.convert',
      input: { conversionId: row.id },
    }),
  ).rejects.toMatchObject({ status: 400 });
});

/** @id TEST-DCV-008 @verifies REQ-DCV-004 */
it('TEST-DCV-008 conversion worker binds provider versions and content identity, stages atomic outputs and refuses unconfirmed settlement', async () => {
  const blobs = await testBlobStorage();
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  const bytes = Buffer.from('%PDF-1.7 synthetic conversion integration');
  const markdown = Buffer.from('# Synthetic output');
  const documentJson = Buffer.from(
    '{"schema_name":"DoclingDocument","texts":[{"text":"Synthetic"}]}',
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  const validator = new DoclingRuntime({
    imageId: `sha256:${'8'.repeat(64)}`,
    modelsPath: '/not-activated/models',
    modelManifestPath: '/not-activated/models.json',
    namespace: 'conversion-input-validation',
  });
  try {
    const uploads = new FileService(
      new ConversionFileRepository(db.pool, conversions),
      blobs.store,
    );
    for (const control of [
      'valid',
      'content',
      'version',
      'blob',
      'cancel',
      'unconfirmed',
    ] as const) {
      const project = await projects.create(owner, `Worker ${control}`);
      const file = await uploads.upload(
        owner,
        project.id,
        { name: 'synthetic.pdf', size: bytes.length },
        new Response(bytes).body,
      );
      expect((await conversions.list(owner, project.id)).items[0]?.state).toBe('waiting');
      const sourceBlob = blobs.container.getBlockBlobClient(`${project.id}/${file.id}`);
      const providerEtag = (await sourceBlob.getProperties()).etag;
      expect(providerEtag).toBeTruthy();
      expect(providerEtag).not.toBe(`"${digest}"`);
      const readEtags: string[] = [];
      const inputs: ConversionRuntimeInput[] = [];
      let writes = 0;
      let jobId = '';
      let pairStaged = false;
      let markHeartbeat!: () => void;
      const heartbeatStarted = new Promise<void>((done) => {
        markHeartbeat = done;
      });
      let releaseHeartbeat!: () => void;
      const heartbeatReleased = new Promise<void>((done) => {
        releaseHeartbeat = done;
      });
      const originalHeartbeat = jobs.heartbeat.bind(jobs);
      const heartbeat =
        control === 'valid'
          ? vi.spyOn(jobs, 'heartbeat').mockImplementation(async (claim) => {
              const state = await originalHeartbeat(claim);
              markHeartbeat();
              await heartbeatReleased;
              return state;
            })
          : undefined;
      const settlement = vi.spyOn(conversions, 'settle');
      const store: BlobStore = {
        read: async (...args) => {
          readEtags.push(args[1]);
          if (control === 'version') {
            const changed = Buffer.from(bytes);
            changed[0] = changed[0]! ^ 1;
            await sourceBlob.uploadData(changed);
          }
          const stream = await blobs.store.read(...args);
          if (control !== 'content') return stream;
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const changed = Buffer.concat(chunks);
          changed[0] = changed[0]! ^ 1;
          return Readable.from([changed]);
        },
        remove: (...args) => blobs.store.remove(...args),
        put: async (...args) => {
          writes++;
          if (control === 'blob' && writes === 2) throw new Error('PRIVATE_staging_failure');
          const etag = await blobs.store.put(...args);
          if (control === 'valid' && writes === 2) pairStaged = true;
          if (control === 'cancel' && writes === 2) await jobs.cancel(owner, project.id, jobId);
          return etag;
        },
      };
      const handlers = conversionHandlers(conversions, store, {
        ready: async () => {},
        convert: async (input) => {
          inputs.push(input);
          jobId = input.jobId;
          // Exercise real input validation without requiring model/container assets in this suite.
          try {
            await validator.convert(input, AbortSignal.abort());
            throw new Error('The validation-only conversion must remain aborted.');
          } catch (error) {
            if (!(error instanceof ConversionRuntimeError) || error.code !== 'interrupted')
              throw error;
          }
          if (control === 'valid') await heartbeatStarted;
          if (control === 'unconfirmed')
            throw new ConversionRuntimeError('cancellation_unconfirmed', false);
          return { markdown, documentJson };
        },
      });
      const worker = new JobWorker(jobs, handlers, {
        beforeClaim: async () => {
          await conversions.dispatch();
        },
        heartbeatMs: 1,
      });
      try {
        if (control === 'valid') {
          const running = worker.runOne();
          try {
            await vi.waitFor(
              () => {
                expect(inputs).toHaveLength(1);
                expect(inputs[0]?.etag).toBe(`"${digest}"`);
                expect(pairStaged).toBe(true);
              },
              { timeout: 10000 },
            );
            expect(settlement).not.toHaveBeenCalled();
            expect((await jobs.get(owner, project.id, jobId)).state).toBe('running');
          } finally {
            releaseHeartbeat();
          }
          expect(await running).toBe(true);
        } else if (control === 'unconfirmed')
          await expect(worker.runOne()).rejects.toBeInstanceOf(JobExecutionUnconfirmed);
        else expect(await worker.runOne()).toBe(true);
        expect(settlement).toHaveBeenCalledTimes(control === 'unconfirmed' ? 0 : 1);
      } finally {
        heartbeat?.mockRestore();
        settlement.mockRestore();
      }
      const request = (await conversions.list(owner, project.id)).items[0]!;
      expect(readEtags).toEqual([providerEtag]);
      expect(inputs).toHaveLength(control === 'version' ? 0 : 1);
      if (inputs[0]) {
        expect(inputs[0].sha256).toBe(digest);
        expect(inputs[0].etag).toBe(`"${digest}"`);
        expect(inputs[0].size).toBe(bytes.length);
        if (control !== 'content') expect(Buffer.from(inputs[0].bytes)).toEqual(bytes);
      }
      if (control === 'content') expect(request.reason).toBe('source_changed');
      expect(request.state).toBe(
        control === 'valid'
          ? 'succeeded'
          : control === 'cancel'
            ? 'cancelled'
            : control === 'unconfirmed'
              ? 'running'
              : 'failed',
      );
      const visible = (await files.list(owner, project.id)).items;
      expect(visible).toHaveLength(control === 'valid' ? 3 : 1);
      expect(
        visible.some(
          (item) =>
            item.id === file.id && item.sha256 === createHash('sha256').update(bytes).digest('hex'),
        ),
      ).toBe(true);
      if (request.artifacts) {
        for (const [artifact, expected] of [
          [request.artifacts.markdown, markdown],
          [request.artifacts.json, documentJson],
        ] as const) {
          expect(artifact.file?.name).toContain(request.id);
          const stored = await files.get(owner, project.id, artifact.id);
          const chunks: Buffer[] = [];
          for await (const chunk of await blobs.store.read(stored.key, stored.etag))
            chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks)).toEqual(expected);
        }
      }
      expect(await conversions.dispatch()).toBe(0);
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE_');
  } finally {
    logs.mockRestore();
    await blobs.close();
  }
});

it('upload outbox and output publication roll back together on SQL faults and accept restored controls', async () => {
  const project = await projects.create(owner, 'SQL fault controls');
  const id = await files.reserve(owner, project.id, { name: 'atomic.pdf', size: 1 });
  await db.pool.query(
    `CREATE FUNCTION conversion_insert_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert fault'; END $$`,
  );
  await db.pool.query(
    `CREATE TRIGGER conversion_insert_fault BEFORE INSERT ON document_conversion_requests FOR EACH ROW EXECUTE FUNCTION conversion_insert_fault()`,
  );
  try {
    await expect(
      conversions.finalizeUpload(owner, project.id, id, 'a'.repeat(64), 'etag'),
    ).rejects.toThrow('synthetic insert fault');
    expect(
      (await db.pool.query('SELECT state FROM project_files WHERE id=$1', [id])).rows[0].state,
    ).toBe('uploading');
    expect((await conversions.list(owner, project.id)).items).toEqual([]);
  } finally {
    await db.pool.query('DROP TRIGGER conversion_insert_fault ON document_conversion_requests');
    await db.pool.query('DROP FUNCTION conversion_insert_fault()');
  }
  await conversions.finalizeUpload(owner, project.id, id, 'a'.repeat(64), 'etag');
  expect(await conversions.dispatch()).toBe(1);
  const current = await jobs.claim(['document.convert']);
  if (!current) throw new Error('Expected conversion claim.');
  const pair = await conversions.reserveOutputs(current, { markdown: 1, json: 2 });
  const publication = {
    markdown: { id: pair.markdown, sha256: 'b'.repeat(64), etag: 'markdown' },
    json: { id: pair.json, sha256: 'c'.repeat(64), etag: 'json' },
  };
  await db.pool.query(
    `CREATE FUNCTION conversion_output_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${pair.json}'::uuid AND NEW.state='ready' THEN RAISE EXCEPTION 'synthetic publish fault'; END IF; RETURN NEW; END $$`,
  );
  await db.pool.query(
    'CREATE TRIGGER conversion_output_fault BEFORE UPDATE ON project_files FOR EACH ROW EXECUTE FUNCTION conversion_output_fault()',
  );
  try {
    await expect(conversions.settle(current, 'success', { publication })).rejects.toThrow(
      'synthetic publish fault',
    );
    expect((await files.list(owner, project.id)).items.map((item) => item.id)).toEqual([id]);
    expect((await jobs.get(owner, project.id, current.job.id)).state).toBe('running');
  } finally {
    await db.pool.query('DROP TRIGGER conversion_output_fault ON project_files');
    await db.pool.query('DROP FUNCTION conversion_output_fault()');
  }
  expect((await conversions.settle(current, 'success', { publication }))?.state).toBe('succeeded');
  expect((await files.list(owner, project.id)).items).toHaveLength(3);
});
it('disabled conversion routes authorize before unavailability without querying source or conversion tables', async () => {
  const project = await projects.create(owner, 'Disabled conversion routes');
  const foreign = await projects.create(other, 'Foreign project');
  const app = createApp({
    config,
    projects,
    verifyToken: async () => ({ ok: true, principal: owner }),
  });
  const sourceId = randomUUID();
  const conversionId = randomUUID();
  const root = `/api/projects/${project.id}`;
  const headers = { Authorization: 'Bearer synthetic' };
  const query = vi.spyOn(db.pool, 'query');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const capability = await app.request(`${root}/conversions/capabilities`, { headers });
    expect(capability.status).toBe(200);
    expect(await capability.json()).toEqual({ enabled: false });
    for (const [path, method] of [
      [`${root}/conversions`, 'GET'],
      [`${root}/conversions/${conversionId}`, 'GET'],
      [`${root}/conversions/${conversionId}/cancel`, 'POST'],
      [`${root}/files/${sourceId}/conversions`, 'POST'],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
      const response = await app.request(path, {
        method,
        headers,
        body: method === 'POST' ? '{' : undefined,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        error: { code: 'DOCUMENT_CONVERSION_UNAVAILABLE', requestId: expect.any(String) },
      });
      expect(
        (await app.request(path.replace(project.id, foreign.id), { method, headers })).status,
      ).toBe(404);
      expect(
        (await app.request(path.replace(project.id, 'malformed'), { method, headers })).status,
      ).toBe(404);
    }
    for (const path of [
      `${root}/conversions/malformed`,
      `${root}/conversions/malformed/cancel`,
      `${root}/files/malformed/conversions`,
    ]) {
      expect(
        (await app.request(path, { headers, method: path.endsWith('malformed') ? 'GET' : 'POST' }))
          .status,
      ).toBe(404);
    }
    expect(
      query.mock.calls.some((args) =>
        /\b(project_files|document_conversion_requests)\b/i.test(String(args[0])),
      ),
    ).toBe(false);
  } finally {
    query.mockRestore();
    errors.mockRestore();
  }
});

it('dispatcher admits the oldest head of each owner before their newer waiting requests', async () => {
  const secondOwner = { ...owner, objectId: randomUUID() };
  const newer = await source('newer.pdf');
  const oldest = await source('oldest.pdf');
  const otherOldest = await source('other-oldest.pdf', 1, secondOwner);
  const otherNewer = await source('other-newer.pdf', 1, secondOwner);
  const requests = [];
  for (const [item, who] of [
    [newer, owner],
    [oldest, owner],
    [otherOldest, secondOwner],
    [otherNewer, secondOwner],
  ] as const)
    requests.push(
      (await conversions.request(who, item.project.id, item.file.id, randomUUID())).request,
    );
  for (const [index, order] of [3, 0, 1, 2].entries())
    await db.pool.query('UPDATE document_conversion_requests SET created_at=$2 WHERE id=$1', [
      requests[index]!.id,
      `2026-01-01T00:00:00.00${order}Z`,
    ]);
  expect(await conversions.dispatch()).toBe(2);
  expect(
    (
      await db.pool.query<{ input: { conversionId: string } }>(
        'SELECT input FROM durable_jobs ORDER BY created_at,id',
      )
    ).rows.map((row) => row.input.conversionId),
  ).toEqual([requests[1]!.id, requests[2]!.id]);
  expect((await conversions.get(owner, newer.project.id, requests[0]!.id)).state).toBe('waiting');
  expect((await conversions.get(secondOwner, otherNewer.project.id, requests[3]!.id)).state).toBe(
    'waiting',
  );
  expect(await conversions.dispatch()).toBe(2);
});

it('new upload outbox insertion and fenced publication interleave without losing either transaction', async () => {
  const { project, file } = await source();
  const current = await claim(project.id, file.id);
  const next = await files.reserve(owner, project.id, { name: 'concurrent.pdf', size: 1 });
  const pair = await conversions.reserveOutputs(current, { markdown: 1, json: 2 });
  const result = await Promise.all([
    conversions.finalizeUpload(owner, project.id, next, 'd'.repeat(64), 'next-source'),
    conversions.settle(current, 'success', {
      publication: {
        markdown: { id: pair.markdown, sha256: 'b'.repeat(64), etag: 'markdown' },
        json: { id: pair.json, sha256: 'c'.repeat(64), etag: 'json' },
      },
    }),
  ]);
  expect(result[0].id).toBe(next);
  expect(result[1]?.state).toBe('succeeded');
  expect((await files.list(owner, project.id)).items).toHaveLength(4);
  expect((await conversions.list(owner, project.id)).items.map((row) => row.state).sort()).toEqual([
    'succeeded',
    'waiting',
  ]);
  expect(await conversions.dispatch()).toBe(1);
});
