import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { GenericContainer, Wait } from 'testcontainers';
import { readConfig, publicConfig } from '../src/server/config.js';
import { FileRepository } from '../src/server/files/repository.js';
import { FileService } from '../src/server/files/service.js';
import type { BlobStore } from '../src/server/files/store.js';
import { createNotebookOptions, NotebookRuntime } from '../src/server/notebook/runtime.js';
import { NotebookRepository } from '../src/server/notebook/repository.js';
import { NotebookService, startNotebookReclaimer } from '../src/server/notebook/service.js';
import { notebookFixture } from './helpers/notebook.js';

const websocketMessages = vi.hoisted(() => ({ chunks: [] as string[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      private maxPayload: number;
      constructor(_url: string, options: { maxPayload: number }) {
        super();
        this.maxPayload = options.maxPayload;
        queueMicrotask(() => this.emit('open'));
      }
      send(data: string) {
        const request = JSON.parse(data) as { header: { msg_id: string } };
        const emit = (msg_type: string, content: object) => {
          const message = Buffer.from(
            JSON.stringify({
              parent_header: { msg_id: request.header.msg_id },
              header: { msg_type },
              content,
            }),
          );
          if (message.length > this.maxPayload)
            this.emit('error', new Error('maxPayload exceeded'));
          else this.emit('message', message);
        };
        for (const text of websocketMessages.chunks) emit('stream', { text });
        emit('status', { execution_state: 'idle' });
      }
      terminate() {}
    },
  };
});

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
  const secondService = new NotebookService(
    new NotebookRepository(fixture.db.pool),
    fixture.runtime,
  );
  const second = secondService.execute(fixture.owner, p.id, readPython.id, 1, []);
  try {
    await vi.waitFor(
      async () => {
        const locks = await fixture.db.pool.query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        expect(locks.rows[0].count).toBe(1);
      },
      { timeout: 10000, interval: 25 },
    );
    expect(fixture.runtime.execute.mock.calls.length).toBe(before);
  } finally {
    release();
  }
  expect((await first).status).toBe(200);
  expect((await second).output).toBe('40');
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

  const token = randomBytes(32).toString('hex');
  const runtime = new NotebookRuntime({
    KUBERNETES_SERVICE_HOST: '127.0.0.1',
    NOTEBOOK_GATEWAY_NAMESPACE: 'notebook-gateway',
    HOSTNAME: 'gateway-pod',
    NOTEBOOK_DEPLOYMENT_ID: randomUUID(),
    NOTEBOOK_KERNEL_IMAGE: `notebook@sha256:${'a'.repeat(64)}`,
  });
  vi.spyOn(runtime, 'ready').mockResolvedValue();
  vi.spyOn(runtime.kube, 'prepare').mockResolvedValue('notebook-project');
  vi.spyOn(runtime.kube, 'verify').mockResolvedValue();
  let command: string[] = [];
  const captured = new Error('Captured supervisor command');
  vi.spyOn(runtime.kube, 'create').mockImplementation(async (object) => {
    const spec = object.spec as { containers: { command: string[] }[] };
    command = spec.containers[0]!.command;
    throw captured;
  });
  await expect(
    runtime.start(
      {
        project: p.id,
        language: 'python',
        generation: randomUUID(),
        token,
        inputsHash: '0'.repeat(64),
        state: 'idle',
      },
      [],
    ),
  ).rejects.toBe(captured);
  expect(command).toHaveLength(4);
  const container = await new GenericContainer(
    'quay.io/jupyter/r-notebook@sha256:95282ae540ecb3260014841ff2f6edafe8543e9c3816a52988a08eab7d53bb39',
  )
    .withNetworkMode('none')
    .withUser('1000:100')
    .withTmpFs({ '/tmp': 'rw,uid=1000,gid=100', '/outputs': 'rw,uid=1000,gid=100' })
    .withEnvironment({
      NOTEBOOK_TOKEN: token,
      HOME: '/tmp',
      JUPYTER_RUNTIME_DIR: '/tmp/jupyter',
      IPYTHONDIR: '/tmp/ipython',
    })
    .withEntrypoint(command.slice(0, 3))
    .withCommand(command.slice(3))
    .withWaitStrategy(
      Wait.forSuccessfulCommand(
        `python3 -c 'import os,urllib.request; urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8888/api",headers={"Authorization":"token "+os.environ["NOTEBOOK_TOKEN"]}),timeout=1).read()'`,
      ).withStartupTimeout(90000),
    )
    .start();
  try {
    const files = await container.exec([
      'python3',
      '-c',
      "import glob,os\npaths=glob.glob('/tmp/jupyter/jpserver-*')\nprint('TOKEN_EXPOSED' if any(os.environ['NOTEBOOK_TOKEN'].encode() in open(p,'rb').read() for p in paths if os.path.isfile(p)) else 'TOKEN_NOT_EXPOSED')",
    ]);
    expect(files.exitCode).toBe(0);
    expect(files.output.trim()).toBe('TOKEN_NOT_EXPOSED');
    const apis = await container.exec([
      'python3',
      '-c',
      `
import os,urllib.request,urllib.error
for path in ('/api','/api/terminals','/api/contents'):
 request=urllib.request.Request('http://127.0.0.1:8888'+path,headers={'Authorization':'token '+os.environ['NOTEBOOK_TOKEN']})
 try:
  with urllib.request.urlopen(request,timeout=5) as response: print(response.status)
 except urllib.error.HTTPError as error: print(error.code)
`,
    ]);
    expect(apis.exitCode).toBe(0);
    expect(apis.output.trim().split('\n')).toEqual(['200', '404', '404']);
    const logs = spawnSync('docker', ['logs', container.getId()], { encoding: 'utf8' });
    expect(logs.status).toBe(0);
    expect((logs.stdout + logs.stderr).includes(token)).toBe(false);
  } finally {
    await container.stop();
  }
}, 120000);

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

  await fixture.db.pool.query(
    "UPDATE notebook_kernels SET last_used_at=clock_timestamp()-interval '901 seconds' WHERE project_id=$1",
    [p.id],
  );
  const service = new NotebookService(new NotebookRepository(fixture.db.pool), fixture.runtime);
  const before = fixture.runtime.stop.mock.calls.length;
  await service.reclaim();
  expect(fixture.runtime.stop.mock.calls.length).toBeGreaterThan(before);
  expect((await run(p.id, saved.id, 2)).stateLost).toBe(true);

  const reclaim = vi.fn(async () => {});
  vi.useFakeTimers();
  try {
    const stop = startNotebookReclaimer({ reclaim });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reclaim).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reclaim).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
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
  const runtimeEnv = {
    KUBERNETES_SERVICE_HOST: '10.0.0.1',
    NOTEBOOK_GATEWAY_NAMESPACE: 'notebook-gateway',
    HOSTNAME: 'gateway-pod',
    NOTEBOOK_DEPLOYMENT_ID: randomUUID(),
    NOTEBOOK_KERNEL_IMAGE: `notebook@sha256:${'a'.repeat(64)}`,
  };
  expect(createNotebookOptions(false, fixture.db.pool, undefined, {})).toBeUndefined();
  const enabledOptions = createNotebookOptions(true, fixture.db.pool, undefined, runtimeEnv);
  expect(enabledOptions?.pool).toBe(fixture.db.pool);
  expect(enabledOptions?.runtime).toBeInstanceOf(NotebookRuntime);
  const kubernetes = (enabledOptions!.runtime as NotebookRuntime).kube;
  const projectId = randomUUID();
  const namespace = kubernetes.namespace(projectId);
  const policy = {
    podSelector: {},
    policyTypes: ['Ingress', 'Egress'],
    ingress: [
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': runtimeEnv.NOTEBOOK_GATEWAY_NAMESPACE,
                'aira.nexus/role': 'notebook-gateway',
              },
            },
            podSelector: { matchLabels: { 'aira.nexus/component': 'notebook-gateway' } },
          },
        ],
        ports: [
          { protocol: 'TCP', port: 8888 },
          { protocol: 'TCP', port: 8889 },
        ],
      },
    ],
  };
  let additionalPolicy = false;
  const command = vi.spyOn(kubernetes, 'command').mockImplementation(async (args) => {
    if (args[0] === 'get' && args[1] === 'namespace')
      return Buffer.from(
        JSON.stringify({
          metadata: {
            labels: {
              ...kubernetes.labels('notebook-project'),
              'aira.nexus/project': projectId,
            },
          },
        }),
      );
    if (args.includes('networkpolicies'))
      return Buffer.from(
        JSON.stringify({
          items: [
            { metadata: { name: 'notebook-isolation' }, spec: policy },
            ...(additionalPolicy
              ? [{ metadata: { name: 'permit-egress' }, spec: { egress: [{}] } }]
              : []),
          ],
        }),
      );
    return Buffer.from(JSON.stringify({ spec: policy }));
  });
  await expect(kubernetes.prepare(projectId)).resolves.toBe(namespace);
  additionalPolicy = true;
  await expect(kubernetes.prepare(projectId)).rejects.toThrow();
  additionalPolicy = false;
  command.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        metadata: {
          labels: {
            ...kubernetes.labels('notebook-project'),
            'aira.nexus/project': projectId,
          },
        },
      }),
    ),
  );
  command.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        spec: { ...policy, egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }] }] },
      }),
    ),
  );
  await expect(kubernetes.prepare(projectId)).rejects.toThrow();
  command.mockRestore();
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

  const kernel = {
    project: p.id,
    language: 'python' as const,
    generation: randomUUID(),
    token: randomBytes(32).toString('hex'),
    inputsHash: '0'.repeat(64),
    state: 'idle' as const,
  };
  const runtime = new NotebookRuntime({
    KUBERNETES_SERVICE_HOST: '127.0.0.1',
    NOTEBOOK_GATEWAY_NAMESPACE: 'notebook-gateway',
    HOSTNAME: 'gateway-pod',
    NOTEBOOK_DEPLOYMENT_ID: randomUUID(),
    NOTEBOOK_KERNEL_IMAGE: `notebook@sha256:${'a'.repeat(64)}`,
  });
  vi.spyOn(runtime.kube, 'prepare').mockResolvedValue('notebook-project');
  vi.spyOn(runtime.kube, 'json').mockResolvedValue({
    metadata: { labels: { 'aira.nexus/generation': kernel.generation } },
    status: { podIP: '127.0.0.1' },
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      String(input).endsWith('/api/kernels')
        ? new Response(JSON.stringify([{ id: randomUUID() }]), { status: 200 })
        : new Response(null, { status: 204 }),
    );
  try {
    websocketMessages.chunks = ['a'.repeat(8388608)];
    const exact = await runtime.execute(kernel, '', AbortSignal.timeout(10000));
    expect(Buffer.byteLength(exact)).toBe(8388608);
    expect(exact.endsWith('[output truncated]')).toBe(false);
    websocketMessages.chunks = ['\\'.repeat(4300000)];
    await expect(runtime.execute(kernel, '', AbortSignal.timeout(10000))).resolves.toBe(
      '\\'.repeat(4300000),
    );
    websocketMessages.chunks = ['é'.repeat(4194305)];
    const clipped = await runtime.execute(kernel, '', AbortSignal.timeout(10000));
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(8388608);
    expect(clipped).toContain('[output truncated]');
  } finally {
    websocketMessages.chunks = [];
    fetch.mockRestore();
  }
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

  const blobs = new Map<string, Buffer>();
  const store: BlobStore = {
    async put(key, input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      blobs.set(key, Buffer.concat(chunks));
      return 'etag';
    },
    async read(key) {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error('Missing blob');
      return Readable.from([bytes]);
    },
    async remove(key) {
      blobs.delete(key);
    },
  };
  const files = new FileService(new FileRepository(fixture.db.pool), store);
  const data = Buffer.from('value\n42\n');
  const uploaded = await files.upload(
    fixture.owner,
    p.id,
    { name: 'data.csv', size: data.length },
    new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }),
  );
  const service = new NotebookService(
    new NotebookRepository(fixture.db.pool),
    fixture.runtime,
    files,
  );
  await service.execute(fixture.owner, p.id, saved.id, 1, [uploaded.id]);
  expect(fixture.runtime.start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      project: p.id,
      language: 'python',
    }),
    [{ id: uploaded.id, name: 'data.csv', bytes: data }],
  );
  const other = await fixture.projects.create(fixture.owner, 'Foreign files');
  const foreign = await files.upload(
    fixture.owner,
    other.id,
    { name: 'other.csv', size: data.length },
    new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }),
  );
  await expect(
    service.execute(fixture.owner, p.id, saved.id, 1, [foreign.id]),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    service.execute(fixture.owner, p.id, saved.id, 1, [uploaded.id, uploaded.id]),
  ).rejects.toMatchObject({ status: 400 });
  fixture.runtime.files.set('result.csv', Buffer.from('artifact'));
  const artifact = await service.artifact(fixture.owner, p.id, 'python', 'result.csv');
  const opened = await files.open(fixture.owner, p.id, artifact.id);
  expect(await new Response(opened.body).text()).toBe('artifact');
  await fixture.db.pool.query(
    `INSERT INTO project_files(id,project_id,name,size_bytes,kind,state,sha256,etag)
     SELECT gen_random_uuid(),$1,'quota.csv',100000000,'text','ready',repeat('0',64),'etag'
     FROM generate_series(1,100)`,
    [p.id],
  );
  await expect(service.artifact(fixture.owner, p.id, 'python', 'result.csv')).rejects.toMatchObject(
    { status: 409, code: 'FILE_QUOTA_EXCEEDED' },
  );

  const large = new Uint8Array(100000000);
  const digest = createHash('sha256').update(large).digest('hex');
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const cancel = vi.fn();
  const open = vi.spyOn(files, 'open').mockImplementation(async (_owner, _project, id) => {
    let sent = false;
    return {
      file: { ...uploaded, id, size: large.length, sha256: digest },
      body: new ReadableStream({
        pull(controller) {
          if (sent) controller.close();
          else {
            sent = true;
            controller.enqueue(large);
          }
        },
        cancel,
      }),
    };
  });
  const starts = fixture.runtime.start.mock.calls.length;
  await expect(service.execute(fixture.owner, p.id, saved.id, 1, ids)).rejects.toMatchObject({
    status: 413,
  });
  expect(cancel).toHaveBeenCalled();
  expect(fixture.runtime.start.mock.calls).toHaveLength(starts);
  open.mockRestore();
}, 120000);

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
