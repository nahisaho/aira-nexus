import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { createApp } from '../src/server/app.js';
import { FileRepository } from '../src/server/files/repository.js';
import { FileService } from '../src/server/files/service.js';
import { readFileStorageConfig } from '../src/server/files/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { createFilesApi } from '../src/client/files-api.js';
import type { BlobStore } from '../src/server/files/store.js';
import type { ProjectFile, FilePage } from '../src/shared/files.js';
import { testDatabase } from './helpers/database.js';
import { testBlobStorage } from './helpers/blob.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';
const owner = { tenantId: config.tenantId, objectId: alice };
const other = { ...owner, objectId: bob };
let db: Awaited<ReturnType<typeof testDatabase>>;
let blobs: Awaited<ReturnType<typeof testBlobStorage>>;
let identity: Awaited<ReturnType<typeof identityFixture>>;
let token: string;
let otherToken: string;
let repository: FileRepository;
let service: FileService;
let projects: ProjectRepository;
let app: ReturnType<typeof createApp>;
const authHeaders = (value = token) => ({ Authorization: `Bearer ${value}` });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  db = await testDatabase();
  blobs = await testBlobStorage();
  identity = await identityFixture();
  token = await identity.sign();
  otherToken = await identity.sign({ oid: bob });
  projects = new ProjectRepository(db.pool);
  repository = new FileRepository(db.pool);
  service = new FileService(repository, blobs.store);
  app = createApp({ config, verifyToken: identity.verify, projects, files: service });
});
afterAll(async () => {
  vi.restoreAllMocks();
  try {
    await blobs?.close();
  } finally {
    await db?.close();
  }
});
function upload(
  project: string,
  name: string,
  body: string,
  size = Buffer.byteLength(body),
  bearer = token,
) {
  return app.request(`/api/projects/${project}/files`, {
    method: 'POST',
    headers: {
      ...authHeaders(bearer),
      'X-File-Name': encodeURIComponent(name),
      'X-File-Size': String(size),
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
}
/** @id TEST-FTP-002 @verifies REQ-FTP-002 */
it('TEST-FTP-002 permanently empties all trash pages while retaining active and foreign files', async () => {
  const p = await projects.create(owner, 'Empty trash');
  const empty = (id = p.id, bearer = token) =>
    app.request(`/api/projects/${id}/files/trash`, {
      method: 'DELETE',
      headers: authHeaders(bearer),
    });
  expect((await empty()).status).toBe(204);
  const active = await service.upload(
    owner,
    p.id,
    { name: 'active.txt', size: 1 },
    new Response('a').body,
  );
  const trashFiles: ProjectFile[] = [];
  for (let n = 0; n < 101; n++) {
    const stored = await service.upload(
      owner,
      p.id,
      { name: `trash-${n}.txt`, size: 1 },
      new Response('x').body,
    );
    await repository.setTrashed(owner, p.id, stored.id, true);
    trashFiles.push(stored);
  }
  const q = await projects.create(other, 'Foreign trash');
  const foreign = await service.upload(
    other,
    q.id,
    { name: 'foreign.txt', size: 1 },
    new Response('f').body,
  );
  await repository.setTrashed(other, q.id, foreign.id, true);
  expect(
    (await app.request(`/api/projects/${p.id}/files/trash`, { method: 'DELETE' })).status,
  ).toBe(401);
  for (const id of ['bad-id', randomUUID(), q.id]) expect((await empty(id)).status).toBe(404);
  expect((await empty(p.id, otherToken)).status).toBe(404);
  const remove = vi.spyOn(blobs.store, 'remove');
  await expect(
    service.emptyTrash({ ...owner, tenantId: randomUUID() }, p.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(remove).not.toHaveBeenCalled();
  expect((await service.list(owner, p.id, undefined, true)).nextCursor).not.toBeNull();
  expect((await empty()).status).toBe(204);
  expect((await service.list(owner, p.id, undefined, true)).items).toEqual([]);
  expect((await service.list(owner, p.id)).items).toEqual([active]);
  expect((await service.list(owner, p.id)).usedBytes).toBe(1);
  for (const f of trashFiles)
    expect(await blobs.container.getBlobClient(`${p.id}/${f.id}`).exists()).toBe(false);
  expect(await blobs.container.getBlobClient(`${p.id}/${active.id}`).exists()).toBe(true);
  expect(await blobs.container.getBlobClient(`${q.id}/${foreign.id}`).exists()).toBe(true);
  expect((await service.list(other, q.id, undefined, true)).items).toEqual([foreign]);
  await repository.setTrashed(other, q.id, foreign.id, false);
  await repository.setTrashed(other, q.id, foreign.id, true);
  expect((await empty()).status).toBe(204);
  remove.mockRestore();
  let account = { id: 'alice', name: 'Test owner' };
  const client = createFilesApi({
    account: () => account,
    accessToken: async () => token,
    signIn: async () => account,
    signOut: async () => {},
  });
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (typeof input !== 'string') throw new Error('Expected file API path');
    return app.request(input, init);
  });
  try {
    await client.emptyTrash(p.id);
    transport.mockResolvedValueOnce(Response.json({ unexpected: 'success' }));
    await expect(client.emptyTrash(p.id)).rejects.toMatchObject({ status: 503 });
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(client.setTrashed(p.id, trashFiles[0]!.id, false)).rejects.toMatchObject({
      status: 409,
      message: '完全削除が中断されています。ごみ箱をもう一度空にしてください。',
    });
    transport.mockImplementationOnce(async () => {
      account = { id: 'bob', name: 'Changed account' };
      return new Response(null, { status: 204 });
    });
    await expect(client.emptyTrash(p.id)).rejects.toMatchObject({ status: 401 });
  } finally {
    transport.mockRestore();
  }
}, 60000);

/** @id TEST-FTP-003 @verifies REQ-FTP-003 */
it('TEST-FTP-003 keeps interrupted purges charged/non-restorable and safely resumes after missing blobs and races', async () => {
  const p = await projects.create(owner, 'Interrupted purge');
  const add = async (name: string) => {
    const file = await service.upload(owner, p.id, { name, size: 1 }, new Response('x').body);
    const stored = await repository.get(owner, p.id, file.id);
    await repository.setTrashed(owner, p.id, file.id, true);
    return stored;
  };
  const first = await add('first.txt');
  const broken: BlobStore = {
    put: blobs.store.put.bind(blobs.store),
    read: blobs.store.read.bind(blobs.store),
    remove: async () => {
      throw Error('Injected storage failure');
    },
  };
  const failedApp = createApp({
    config,
    verifyToken: identity.verify,
    projects,
    files: new FileService(repository, broken),
  });
  const path = `/api/projects/${p.id}/files/trash`;
  expect((await failedApp.request(path, { method: 'DELETE', headers: authHeaders() })).status).toBe(
    503,
  );
  expect((await service.list(owner, p.id, undefined, true)).items.map((f) => f.id)).toEqual([
    first.id,
  ]);
  expect((await service.list(owner, p.id)).usedBytes).toBe(1);
  await expect(repository.setTrashed(owner, p.id, first.id, false)).rejects.toMatchObject({
    status: 409,
  });
  await repository.setTrashed(owner, p.id, first.id, true);
  const finish = vi
    .spyOn(repository, 'finishPurge')
    .mockRejectedValueOnce(Error('Injected metadata failure'));
  await expect(service.emptyTrash(owner, p.id)).rejects.toMatchObject({ status: 503 });
  expect(await blobs.container.getBlobClient(first.key).exists()).toBe(false);
  expect((await service.list(owner, p.id)).usedBytes).toBe(1);
  await expect(repository.setTrashed(owner, p.id, first.id, false)).rejects.toMatchObject({
    status: 409,
  });
  finish.mockRestore();
  const fresh = new FileService(new FileRepository(db.pool), blobs.store);
  await fresh.emptyTrash(owner, p.id);
  expect((await fresh.list(owner, p.id)).usedBytes).toBe(0);
  const wrong = await add('wrong-etag.txt');
  await db.pool.query('UPDATE project_files SET etag=$2 WHERE id=$1', [wrong.id, '"wrong"']);
  await expect(fresh.emptyTrash(owner, p.id)).rejects.toMatchObject({ status: 503 });
  expect(await blobs.container.getBlobClient(wrong.key).exists()).toBe(true);
  expect((await fresh.list(owner, p.id)).usedBytes).toBe(1);
  await db.pool.query('UPDATE project_files SET etag=$2 WHERE id=$1', [wrong.id, wrong.etag]);
  await fresh.emptyTrash(owner, p.id);
  const aborted = await add('aborted.txt');
  const abort = new AbortController();
  const interrupted: BlobStore = {
    put: blobs.store.put.bind(blobs.store),
    read: blobs.store.read.bind(blobs.store),
    remove: async (_key, _etag, signal) => {
      abort.abort();
      signal?.throwIfAborted();
    },
  };
  await expect(
    new FileService(repository, interrupted).emptyTrash(owner, p.id, abort.signal),
  ).rejects.toMatchObject({ status: 503 });
  expect(await blobs.container.getBlobClient(aborted.key).exists()).toBe(true);
  expect((await fresh.list(owner, p.id)).usedBytes).toBe(1);
  await expect(repository.setTrashed(owner, p.id, aborted.id, false)).rejects.toMatchObject({
    status: 409,
  });
  await Promise.all([fresh.emptyTrash(owner, p.id), fresh.emptyTrash(owner, p.id)]);
  expect((await fresh.list(owner, p.id)).usedBytes).toBe(0);
  const restored = await add('restored-before-admission.txt');
  await repository.setTrashed(owner, p.id, restored.id, false);
  const selected = await add('selected-before-admission.txt');
  const newlyTrashed = await service.upload(
    owner,
    p.id,
    { name: 'new-trash.txt', size: 1 },
    new Response('n').body,
  );
  let changed = false;
  const concurrent: BlobStore = {
    put: blobs.store.put.bind(blobs.store),
    read: blobs.store.read.bind(blobs.store),
    remove: async (key, etag, signal) => {
      if (!changed) {
        changed = true;
        await repository.setTrashed(owner, p.id, newlyTrashed.id, true);
      }
      await blobs.store.remove(key, etag, signal);
    },
  };
  await new FileService(repository, concurrent).emptyTrash(owner, p.id);
  expect(await blobs.container.getBlobClient(selected.key).exists()).toBe(false);
  expect(await blobs.container.getBlobClient(restored.key).exists()).toBe(true);
  expect((await fresh.list(owner, p.id, undefined, true)).items.map((f) => f.id)).toEqual([
    newlyTrashed.id,
  ]);
  expect((await fresh.list(owner, p.id)).usedBytes).toBe(2);
}, 60000);

/** @id TEST-FEX-002 @verifies REQ-FEX-002 */
it('TEST-FEX-002 persists owner-isolated reversible trash without changing original bytes or quota', async () => {
  const p = await projects.create(owner, 'Reversible file trash');
  const original = 'Original file retained in trash';
  const uploaded = await upload(p.id, 'retained.txt', original);
  const file = (await uploaded.json()) as ProjectFile;
  const path = `/api/projects/${p.id}/files/${file.id}`;
  const transition = (trashed: boolean, bearer = token, base = path) =>
    app.request(`${base}${trashed ? '' : '/restore'}`, {
      method: trashed ? 'DELETE' : 'POST',
      headers: authHeaders(bearer),
    });
  expect((await transition(true)).status).toBe(204);
  expect((await transition(true)).status).toBe(204);
  const freshService = new FileService(new FileRepository(db.pool), blobs.store);
  const active = await freshService.list(owner, p.id);
  expect(active.items).toEqual([]);
  expect(active.usedBytes).toBe(Buffer.byteLength(original));
  expect((await app.request(`${path}/content`, { headers: authHeaders() })).status).toBe(404);
  const trashResponse = await app.request(`/api/projects/${p.id}/files?trashed=true`, {
    headers: authHeaders(),
  });
  expect(trashResponse.status).toBe(200);
  const trash = (await trashResponse.json()) as FilePage;
  expect(trash.items).toEqual([file]);
  expect(trash.usedBytes).toBe(active.usedBytes);
  await expect(
    new FileRepository(db.pool).setTrashed(
      { ...owner, tenantId: randomUUID() },
      p.id,
      file.id,
      false,
    ),
  ).rejects.toMatchObject({ status: 404 });
  for (const trashed of [true, false]) {
    expect((await transition(trashed, otherToken)).status).toBe(404);
    expect(
      (
        await app.request(`${path}${trashed ? '' : '/restore'}`, {
          method: trashed ? 'DELETE' : 'POST',
        })
      ).status,
    ).toBe(401);
    const alien = await projects.create(other, 'Another owner');
    expect(
      (await transition(trashed, otherToken, `/api/projects/${alien.id}/files/${file.id}`)).status,
    ).toBe(404);
    for (const id of ['bad-id', randomUUID()]) {
      expect((await transition(trashed, token, `/api/projects/${p.id}/files/${id}`)).status).toBe(
        404,
      );
    }
    const wrongTenant = await identity.sign({ tid: randomUUID() });
    expect((await transition(trashed, wrongTenant)).status).toBe(401);
    for (const state of ['uploading', 'failed']) {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO project_files(id,project_id,name,size_bytes,kind,state) VALUES($1,$2,'not-ready.txt',0,'text',$3)",
        [id, p.id, state],
      );
      expect((await transition(trashed, token, `/api/projects/${p.id}/files/${id}`)).status).toBe(
        404,
      );
    }
  }
  expect((await transition(false)).status).toBe(204);
  expect((await transition(false)).status).toBe(204);
  expect((await freshService.list(owner, p.id)).items).toEqual([file]);
  const restored = await freshService.open(owner, p.id, file.id);
  expect(restored.file).toEqual(file);
  expect(await new Response(restored.body).text()).toBe(original);
  let account = { id: 'alice', name: 'Synthetic account' };
  const browserAuth = {
    account: () => account,
    accessToken: async () => token,
    signIn: async () => account,
    signOut: async () => {},
  };
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (typeof input !== 'string') throw new Error('Expected file API path');
    return app.request(input, init);
  });
  try {
    const client = createFilesApi(browserAuth);
    await client.setTrashed(p.id, file.id, true);
    expect((await client.list(p.id, undefined, undefined, true)).items).toEqual([file]);
    await expect(client.content(p.id, file)).rejects.toMatchObject({ status: 404 });
    await client.setTrashed(p.id, file.id, false);
    expect(Buffer.from(await client.content(p.id, file)).toString()).toBe(original);
    transport.mockResolvedValueOnce(Response.json({ unexpected: 'success' }));
    await expect(client.setTrashed(p.id, file.id, true)).rejects.toMatchObject({ status: 503 });
    transport.mockImplementationOnce(async () => {
      account = { id: 'bob', name: 'Changed account' };
      return new Response(null, { status: 204 });
    });
    await expect(client.setTrashed(p.id, file.id, true)).rejects.toMatchObject({ status: 401 });
  } finally {
    transport.mockRestore();
  }
  expect(
    (await app.request(`/api/projects/${p.id}/files?trashed=invalid`, { headers: authHeaders() }))
      .status,
  ).toBe(400);
  await transition(true);
  const rejected = await upload(p.id, 'quota.txt', 'x');
  expect(rejected.status).toBe(201);
  await db.pool.query(
    "INSERT INTO project_files(id,project_id,name,size_bytes,kind,state,sha256,etag,trashed_at) SELECT gen_random_uuid(),$1,'quota.txt',CASE WHEN n=100 THEN 100000000-$3::bigint ELSE 100000000 END,'text','ready',$2,'synthetic',clock_timestamp() FROM generate_series(1,100) n",
    [p.id, '0'.repeat(64), Buffer.byteLength(original) + 1],
  );
  expect((await upload(p.id, 'over-quota.txt', 'x')).status).toBe(409);
  const listed = await app.request(`/api/projects/${p.id}/files?trashed=true`, {
    headers: authHeaders(),
  });
  const firstPage = (await listed.json()) as FilePage;
  expect(firstPage.items).toHaveLength(100);
  expect(firstPage.nextCursor).not.toBeNull();
  const next = await app.request(
    `/api/projects/${p.id}/files?trashed=true&cursor=${firstPage.nextCursor}`,
    { headers: authHeaders() },
  );
  const nextPage = (await next.json()) as FilePage;
  expect(nextPage.items).toHaveLength(1);
  expect(new Set([...firstPage.items, ...nextPage.items].map((item) => item.id)).size).toBe(101);
  expect(nextPage.nextCursor).toBeNull();
});
/** @id TEST-SVC-001 @verifies REQ-SVC-001 */
it('TEST-SVC-001 stores exact original bytes privately and fences every route by tenant/project/owner', async () => {
  const p = await projects.create(owner, 'Private files');
  const original = '日本語の研究\n<script>never execute</script>\n';
  const response = await upload(p.id, '研究.txt', original);
  expect(response.status).toBe(201);
  const file = (await response.json()) as ProjectFile;
  expect(file.sha256).toBe(sha(Buffer.from(original)));
  expect(file.size).toBe(Buffer.byteLength(original));
  expect(Object.keys(file).sort()).toEqual(['createdAt', 'id', 'kind', 'name', 'sha256', 'size']);
  const fresh = new FileRepository(db.pool);
  expect((await fresh.get(owner, p.id, file.id)).sha256).toBe(file.sha256);
  const download = await app.request(`/api/projects/${p.id}/files/${file.id}/content`, {
    headers: authHeaders(),
  });
  expect(download.status).toBe(200);
  expect(await download.text()).toBe(original);
  expect(download.headers.get('Content-Type')).toContain('application/octet-stream');
  expect(download.headers.get('Content-Disposition')).toContain('attachment;');
  expect(download.headers.get('Content-Disposition')).toContain(encodeURIComponent(file.name));
  expect(download.headers.get('Cache-Control')).toBe('no-store');
  expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
  const again = await upload(p.id, file.name, 'different');
  expect(again.status).toBe(201);
  expect(((await again.json()) as ProjectFile).id).not.toBe(file.id);
  const alien = await projects.create(other, 'Other private project');
  for (const path of [
    `/api/projects/${p.id}/files`,
    `/api/projects/${p.id}/files/${file.id}/content`,
  ]) {
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: authHeaders(otherToken) })).status).toBe(404);
  }
  expect((await upload(p.id, 'bad/../../x.txt', 'x', 1, otherToken)).status).toBe(404);
  expect(
    (
      await app.request(`/api/projects/${alien.id}/files/${file.id}/content`, {
        headers: authHeaders(otherToken),
      })
    ).status,
  ).toBe(404);
  await expect(
    fresh.get({ ...owner, tenantId: randomUUID() }, p.id, file.id),
  ).rejects.toMatchObject({ status: 404 });
  const stored = await fresh.get(owner, p.id, file.id);
  await expect(
    blobs.store.put(
      stored.key,
      Readable.from([Buffer.from('overwrite')]),
      new AbortController().signal,
    ),
  ).rejects.toBeDefined();
  expect((await fresh.get(owner, p.id, file.id)).sha256).toBe(file.sha256);
});
/** @id TEST-SVC-002 @verifies REQ-SVC-004 */
it('TEST-SVC-002 validates names/types and exact streamed declarations before publishing, with zero and100MB controls', async () => {
  const p = await projects.create(owner, 'Upload limits');
  expect((await upload(p.id, '../x.txt', 'x')).status).toBe(400);
  for (const name of ['', '   ', 'x\\file.txt', 'x\n.txt', 'a'.repeat(256) + '.txt']) {
    expect((await upload(p.id, name, 'x')).status).toBe(400);
  }
  expect((await upload(p.id, 'x.exe', 'x')).status).toBe(415);
  expect((await upload(p.id, 'x.txt', 'x', 100000001)).status).toBe(413);
  expect((await upload(p.id, 'short.txt', 'one', 4)).status).toBe(400);
  expect((await upload(p.id, 'over.txt', 'two', 1)).status).toBe(413);
  for (const size of ['-1', '1.5', 'NaN', '01', '', '100000000000000000000']) {
    expect(
      (
        await app.request(`/api/projects/${p.id}/files`, {
          method: 'POST',
          headers: { ...authHeaders(), 'X-File-Name': 'x.txt', 'X-File-Size': size },
          body: 'x',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect((await upload(p.id, 'empty.txt', '', 0)).status).toBe(201);
  expect((await upload(p.id, '🔬'.repeat(251) + '.txt', 'x')).status).toBe(201);
  const page = await service.list(owner, p.id);
  expect(page.items.map((f) => f.name)).toEqual(
    expect.arrayContaining(['empty.txt', '🔬'.repeat(251) + '.txt']),
  );
  expect(page.items.some((f) => ['short.txt', 'over.txt'].includes(f.name))).toBe(false);
  let consumed = 0;
  const sink: BlobStore = {
    remove: async () => {
      throw new Error('Unexpected blob removal');
    },
    put: async (_key, input) => {
      for await (const chunk of input) consumed += (chunk as Buffer).length;
      return '"streamed"';
    },
    read: async () => Readable.from([]),
  };
  const block = new Uint8Array(1000000).fill(42);
  let remaining = 100;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(block);
      else controller.close();
    },
  });
  const maximum = await new FileService(repository, sink).upload(
    owner,
    p.id,
    { name: 'maximum.txt', size: 100000000 },
    body,
  );
  expect(maximum.size).toBe(100000000);
  expect(consumed).toBe(100000000);
  const independent = createHash('sha256');
  for (let n = 0; n < 100; n++) independent.update(block);
  expect(maximum.sha256).toBe(independent.digest('hex'));
  let release = () => {};
  let entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bounded: BlobStore = {
    remove: async () => {
      throw new Error('Unexpected blob removal');
    },
    put: async (_key, input) => {
      for await (const chunk of input) expect(Buffer.byteLength(chunk)).toBeGreaterThan(0);
      if (++entered <= 4) await gate;
      return '"capacity"';
    },
    read: async () => Readable.from([]),
  };
  const limited = new FileService(repository, bounded);
  const pending = Array.from({ length: 4 }, (_, n) =>
    limited.upload(owner, p.id, { name: `capacity-${n}.txt`, size: 1 }, new Response('x').body),
  );
  const settled = Promise.allSettled(pending);
  try {
    await vi.waitFor(() => expect(entered).toBe(4), { timeout: 10000 });
    await expect(
      limited.upload(owner, p.id, { name: 'fifth.txt', size: 1 }, new Response('x').body),
    ).rejects.toMatchObject({ status: 429 });
  } finally {
    release();
    await settled;
  }
  expect((await settled).every((result) => result.status === 'fulfilled')).toBe(true);
  for (const reason of ['timeout', 'abort'] as const) {
    let begin: () => void = () => {
      throw Error('Missing stream-start resolver');
    };
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let ended = false;
    let finish = () => {};
    const cancelled = vi.fn(() => {
      ended = true;
    });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([42]));
        finish = () => {
          if (!ended) {
            ended = true;
            controller.close();
          }
        };
      },
      cancel: cancelled,
    });
    const transport: BlobStore = {
      remove: async () => {
        throw new Error('Unexpected blob removal');
      },
      put: async (_key, input) => {
        for await (const chunk of input) {
          expect(Buffer.byteLength(chunk)).toBe(1);
          begin();
        }
        return '"interruption-fixture"';
      },
      read: async () => Readable.from([]),
    };
    const external = new AbortController();
    if (reason === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = new FileService(repository, transport)
      .upload(owner, p.id, { name: `${reason}.txt`, size: 2 }, stalled, external.signal)
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    try {
      await started;
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(300001);
      else external.abort();
      expect(cancelled).toHaveBeenCalled();
      expect(await outcome).toMatchObject({
        status: 503,
        code: reason === 'timeout' ? 'UPLOAD_TIMEOUT' : 'UPLOAD_INTERRUPTED',
      });
    } finally {
      external.abort();
      finish();
      await outcome;
      vi.useRealTimers();
    }
    const state = await db.pool.query(
      'SELECT state FROM project_files WHERE project_id=$1 AND name=$2',
      [p.id, `${reason}.txt`],
    );
    expect(state.rows).toEqual([{ state: 'failed' }]);
    const interruptedPage = await service.list(owner, p.id);
    expect(interruptedPage.items.some((file) => file.name === `${reason}.txt`)).toBe(false);
    expect(interruptedPage.reservedBytes).toBe(0);
  }
  const recovered = await Promise.allSettled(
    Array.from({ length: 4 }, (_, n) =>
      new FileService(repository, sink).upload(
        owner,
        p.id,
        { name: `recovered-${n}.txt`, size: 1 },
        new Response('x').body,
      ),
    ),
  );
  expect(recovered.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(readFileStorageConfig({})).toBeUndefined();
  for (const endpoint of [
    'http://example.invalid/account',
    'https://127.0.0.1.evil.invalid/account',
    'http://localhost/account',
    'http://user:pass@127.0.0.1/account',
  ]) {
    expect(() =>
      readFileStorageConfig({
        FILE_STORAGE_MODE: 'azurite',
        AZURITE_BLOB_ENDPOINT: endpoint,
        AZURITE_ACCOUNT_NAME: 'testaccount',
        AZURITE_ACCOUNT_KEY: Buffer.alloc(64, 1).toString('base64'),
      }),
    ).toThrow();
  }
  expect(
    readFileStorageConfig({
      FILE_STORAGE_MODE: 'azurite',
      AZURITE_BLOB_ENDPOINT: 'http://127.0.0.1:10000/testaccount',
      AZURITE_ACCOUNT_NAME: 'testaccount',
      AZURITE_ACCOUNT_KEY: Buffer.alloc(64, 1).toString('base64'),
    }),
  ).toMatchObject({ mode: 'azurite', endpoint: 'http://127.0.0.1:10000/testaccount' });
  const azure = {
    FILE_STORAGE_MODE: 'azure',
    AZURE_STORAGE_ACCOUNT_URL: 'https://testaccount.blob.core.windows.net',
  };
  for (const domain of ['windows.net', 'usgovcloudapi.net', 'chinacloudapi.cn']) {
    expect(
      readFileStorageConfig({
        ...azure,
        AZURE_STORAGE_ACCOUNT_URL: `https://testaccount.blob.core.${domain}`,
        AZURE_MANAGED_IDENTITY_CLIENT_ID: alice,
      }),
    ).toMatchObject({ mode: 'azure', clientId: alice });
  }
  for (const changes of [
    { AZURE_STORAGE_ACCOUNT_URL: 'http://testaccount.blob.core.windows.net' },
    { AZURE_STORAGE_ACCOUNT_URL: 'https://testaccount.blob.core.windows.net.evil.invalid' },
    { AZURE_STORAGE_ACCOUNT_URL: 'https://user:pass@testaccount.blob.core.windows.net' },
    { AZURE_STORAGE_ACCOUNT_URL: 'https://testaccount.blob.core.windows.net/container' },
    { AZURE_MANAGED_IDENTITY_CLIENT_ID: 'not-a-guid' },
    { AZURITE_ACCOUNT_KEY: Buffer.alloc(64, 1).toString('base64') },
    { AZURITE_ACCOUNT_NAME: 'testaccount' },
    { AZURITE_BLOB_ENDPOINT: 'http://127.0.0.1:10000/testaccount' },
  ]) {
    expect(() => readFileStorageConfig({ ...azure, ...changes })).toThrow();
  }
});
/** @id TEST-SVC-003 @verifies REQ-SVC-005 */
it('TEST-SVC-003 serializes quota reservations, expires using DB time and fences terminal states', async () => {
  const p = await projects.create(owner, 'Quota races');
  const controls = await Promise.all([
    repository.reserve(owner, p.id, { name: 'a.txt', size: 100000000 }),
    repository.reserve(owner, p.id, { name: 'b.txt', size: 100000000 }),
  ]);
  expect(new Set(controls).size).toBe(2);
  for (const id of controls) await repository.fail(owner, p.id, id);
  for (let n = 0; n < 99; n++)
    await db.pool.query(
      "INSERT INTO project_files(id,project_id,name,size_bytes,kind,state,expires_at,sha256,etag) VALUES($1,$2,$3,100000000,'text','ready',clock_timestamp(),$4,$5)",
      [randomUUID(), p.id, `${n}.txt`, '0'.repeat(64), '"fixture"'],
    );
  const raced = await Promise.allSettled([
    repository.reserve(owner, p.id, { name: 'first.txt', size: 100000000 }),
    repository.reserve(owner, p.id, { name: 'second.txt', size: 100000000 }),
  ]);
  expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const accepted = raced.find((r) => r.status === 'fulfilled');
  if (!accepted || accepted.status !== 'fulfilled') throw Error('Missing valid reservation');
  const ready = await repository.finalize(owner, p.id, accepted.value, 'a'.repeat(64), '"ready"');
  await repository.fail(owner, p.id, ready.id);
  expect((await repository.get(owner, p.id, ready.id)).sha256).toBe('a'.repeat(64));
  await expect(
    repository.reserve(owner, p.id, { name: 'one-byte.txt', size: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  const q = await projects.create(owner, 'Expiry');
  const expired = await repository.reserve(owner, q.id, { name: 'expired.txt', size: 100000000 });
  await db.pool.query("UPDATE project_files SET expires_at='2000-01-01' WHERE id=$1", [expired]);
  await expect(
    repository.finalize(owner, q.id, expired, 'a'.repeat(64), '"late"'),
  ).rejects.toMatchObject({ status: 409 });
  expect((await repository.list(owner, q.id)).items).toEqual([]);
  expect((await repository.list(owner, q.id)).reservedBytes).toBe(0);
  const failed = await repository.reserve(owner, q.id, { name: 'failed.txt', size: 1 });
  await repository.fail(owner, q.id, failed);
  await expect(
    repository.finalize(owner, q.id, failed, 'a'.repeat(64), '"late"'),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    repository.finalize(owner, p.id, ready.id, 'b'.repeat(64), '"replace"'),
  ).rejects.toMatchObject({ status: 409 });
});
/** @id TEST-SVC-004 @verifies REQ-SVC-006 */
it('TEST-SVC-004 paginates ready metadata and refuses changed or interrupted content before any successful save', async () => {
  const p = await projects.create(owner, 'Pages');
  const first = await upload(p.id, 'original.txt', 'original bytes');
  expect(first.status).toBe(201);
  const file = (await first.json()) as ProjectFile;
  for (let n = 0; n < 103; n++) {
    const id = await repository.reserve(owner, p.id, { name: `${n}.txt`, size: 1 });
    await repository.finalize(owner, p.id, id, '0'.repeat(64), '"fixture"');
  }
  const page = (await (
    await app.request(`/api/projects/${p.id}/files`, { headers: authHeaders() })
  ).json()) as FilePage;
  expect(page.items).toHaveLength(100);
  expect(page.nextCursor).toBeTruthy();
  const next = await service.list(owner, p.id, page.nextCursor!);
  expect(next.items).toHaveLength(4);
  expect(new Set([...page.items, ...next.items].map((f) => f.id)).size).toBe(104);
  await expect(service.list(owner, p.id, 'not-a-cursor')).rejects.toMatchObject({ status: 400 });
  const stored = await repository.get(owner, p.id, file.id);
  const target = blobs.container.getBlockBlobClient(stored.key);
  await target.uploadData(Buffer.from('replaced'));
  expect(
    (
      await app.request(`/api/projects/${p.id}/files/${file.id}/content`, {
        headers: authHeaders(),
      })
    ).status,
  ).toBe(503);
  const broken = new Readable({ read() {} });
  const faulty: BlobStore = {
    put: async () => '"unused"',
    read: async () => broken,
    remove: async () => {
      throw new Error('Unexpected blob removal');
    },
  };
  const streamingApp = createApp({
    config,
    verifyToken: identity.verify,
    projects,
    files: new FileService(repository, faulty),
  });
  const server = serve({ fetch: streamingApp.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing isolated HTTP port');
    const pending = fetch(
      `http://127.0.0.1:${address.port}/api/projects/${p.id}/files/${file.id}/content`,
      { headers: authHeaders() },
    );
    broken.push(Buffer.from('o'));
    const response = await pending;
    expect(response.status).toBe(200);
    const incomplete = response.arrayBuffer();
    broken.destroy(new Error('synthetic upstream interruption'));
    await expect(incomplete).rejects.toBeDefined();
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const auth = {
    account: () => ({ id: 'alice', name: 'A' }),
    accessToken: async () => token,
    signIn: async () => ({ id: 'alice', name: 'A' }),
    signOut: async () => {},
  };
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('wrong but same-length'.slice(0, file.size)));
  try {
    await expect(createFilesApi(auth).content(p.id, file)).rejects.toBeDefined();
  } finally {
    fetcher.mockRestore();
  }
});
