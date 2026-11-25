import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { loadavg } from 'node:os';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const { AbortSignal, fetch, ReadableStream, Response } = globalThis;

const namespace = 'aira-notebook-qualification';
const role = 'notebook-qualification';
const prefix = 'aira-qual-';
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const logError = (message) => console.error(`[${new Date().toISOString()}] ${message}`);

function memory() {
  const values = Object.fromEntries(
    readFileSync('/proc/meminfo', 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^(\w+):\s+(\d+)/.exec(line);
        return match ? [match[1], Number(match[2]) * 1024] : ['', 0];
      }),
  );
  if (!values.MemAvailable || values.SwapTotal === undefined || values.SwapFree === undefined)
    throw new Error('Host memory information is unavailable.');
  return { available: values.MemAvailable, swapUsed: values.SwapTotal - values.SwapFree };
}

async function host() {
  const config = process.env.KUBECONFIG;
  const context = process.env.NOTEBOOK_VERIFY_CONTEXT;
  const image = process.env.NOTEBOOK_VERIFY_API_IMAGE;
  const kernelImage = process.env.NOTEBOOK_VERIFY_KERNEL_IMAGE;
  if (
    process.env.NOTEBOOK_VERIFY_DISPOSABLE !== 'true' ||
    !config?.startsWith('/') ||
    config.includes(':') ||
    !context?.startsWith('kind-') ||
    !image ||
    !kernelImage ||
    !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(kernelImage)
  )
    throw new Error(
      'Explicit disposable kind context, absolute KUBECONFIG and both images are required.',
    );

  const initial = memory();
  if (initial.available < 20 * 1024 ** 3 || loadavg()[0] > 18)
    throw new Error('Insufficient host headroom for qualification.');
  const base = ['--kubeconfig', config, '--context', context];
  let active;
  async function call(args, input, acceptFailure = false) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'kubectl',
        [...base, ...args],
        {
          encoding: 'utf8',
          timeout: 150000,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (active === child) active = undefined;
          if (error && (typeof error.code !== 'number' || !acceptFailure)) {
            reject(new Error(`kubectl ${args[0]} failed: ${stderr.trim() || error.message}`));
            return;
          }
          resolve({ status: error?.code ?? 0, stdout, stderr });
        },
      );
      if (args.includes('wait')) active = child;
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin.end(input);
    });
  }
  const view = JSON.parse((await call(['config', 'view', '--minify', '-o', 'json'])).stdout);
  const server = new URL(view.clusters?.[0]?.cluster?.server);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname))
    throw new Error('Qualification requires a loopback-only kind API endpoint.');
  const nodes = JSON.parse((await call(['get', 'nodes', '-o', 'json'])).stdout).items;
  if (
    nodes.length !== 1 ||
    nodes.some(
      (node) =>
        node.metadata.labels?.['aira.nexus/purpose'] !== 'notebook-qualification' ||
        !node.metadata.labels?.['aira.nexus/owner'],
    )
  )
    throw new Error('The cluster must have one explicitly owned qualification node.');
  const runtimeClass = JSON.parse(
    (await call(['get', 'runtimeclass', 'kata', '-o', 'json'])).stdout,
  );
  if (runtimeClass.handler !== 'kata') throw new Error('The kata RuntimeClass is unavailable.');
  for (const resource of [
    `namespace/${namespace}`,
    `clusterrole/${role}`,
    `clusterrolebinding/${role}`,
  ])
    if ((await call(['get', resource, '--ignore-not-found', '-o', 'name'])).stdout.trim())
      throw new Error(`Refusing to overwrite existing ${resource}.`);

  const deployment = randomUUID();
  log(`Qualification deployment: ${deployment}`);
  const created = new Map();
  let failure;
  let interrupted = false;
  let termination;
  const terminate = (reason) => {
    if (interrupted) return;
    interrupted = true;
    logError(reason);
    if (active) active.kill('SIGTERM');
    termination = (async () => {
      const current = await call(
        [
          '-n',
          namespace,
          'get',
          'pod',
          'notebook-qualification-gateway',
          '--ignore-not-found',
          '-o',
          'json',
        ],
        undefined,
        true,
      );
      if (current.status !== 0)
        throw new Error(`Failed to find qualification gateway: ${current.stderr.trim()}`);
      if (!current.stdout.trim()) return;
      const metadata = JSON.parse(current.stdout).metadata;
      if (
        metadata.labels?.['aira.nexus/qualification'] !== deployment ||
        typeof metadata.uid !== 'string' ||
        !metadata.uid
      )
        throw new Error('Refusing to stop a gateway without matching ownership.');
      await call(
        [
          'delete',
          '--raw',
          `/api/v1/namespaces/${namespace}/pods/notebook-qualification-gateway`,
          '-f',
          '-',
        ],
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: metadata.uid },
        }),
      );
    })().catch((error) => {
      logError(`Qualification emergency stop failed: ${error.message}`);
      failure ??= error;
    });
  };
  const onSignal = () => terminate('Qualification interrupted.');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer = setInterval(() => {
    try {
      const current = memory();
      if (
        current.available < 20 * 1024 ** 3 ||
        current.swapUsed - initial.swapUsed > 512 * 1024 ** 2 ||
        loadavg()[0] > 18
      )
        terminate('Host resource threshold reached; stopping qualification.');
    } catch (error) {
      terminate(`Host resource monitoring failed: ${error.message}`);
    }
  }, 5000);
  timer.unref();
  async function create(args, input) {
    if (interrupted) throw new Error('Qualification stopped before resource creation.');
    const result = await call(['create', ...args, '-o', 'name'], input, true);
    const names = result.stdout
      .trim()
      .split('\n')
      .filter(
        (name) =>
          name.startsWith('namespace/') ||
          name.startsWith('clusterrole.') ||
          name.startsWith('clusterrolebinding.'),
      );
    for (const name of names) created.set(name, null);
    for (const name of names) {
      const resource = JSON.parse((await call(['get', name, '-o', 'json'])).stdout);
      if (resource.metadata.labels?.['aira.nexus/qualification'] !== deployment)
        throw new Error(`Unexpected ownership for ${name}.`);
      if (typeof resource.metadata.uid !== 'string' || !resource.metadata.uid)
        throw new Error(`Missing UID for ${name}.`);
      created.set(name, resource.metadata.uid);
      log(`Created ${name} uid=${resource.metadata.uid}`);
    }
    if (result.status !== 0) throw new Error(`Resource creation failed: ${result.stderr.trim()}`);
    if (interrupted) throw new Error('Qualification stopped after resource creation.');
  }
  async function createManifest(path) {
    const manifest = await call([
      'label',
      '--local',
      '-f',
      path,
      `aira.nexus/qualification=${deployment}`,
      '-o',
      'jsonpath={@}{"\\n"}',
    ]);
    const items = manifest.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!items.length) throw new Error(`Empty qualification manifest: ${path}`);
    await create(['-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
  }
  async function removeVerified(resource, uid, wait = true) {
    const [kind, name, extra] = resource.split('/');
    const paths = {
      namespace: '/api/v1/namespaces',
      'clusterrole.rbac.authorization.k8s.io': '/apis/rbac.authorization.k8s.io/v1/clusterroles',
      'clusterrolebinding.rbac.authorization.k8s.io':
        '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
    };
    if (!paths[kind] || !name || extra || typeof uid !== 'string' || !uid)
      throw new Error(`Missing deletion identity for ${resource}.`);
    await call(
      ['delete', '--raw', `${paths[kind]}/${encodeURIComponent(name)}`, '-f', '-'],
      JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } }),
    );
    if (wait) await call(['wait', '--for=delete', resource, '--timeout=120s']);
  }
  try {
    await createManifest('k8s/notebook/namespace.yaml');
    await createManifest('k8s/notebook/rbac.yaml');
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'notebook-qualification-postgres', namespace },
      data: {
        password: Buffer.from(randomBytes(32).toString('hex')).toString('base64'),
        'blob-key': Buffer.from(randomBytes(64).toString('base64')).toString('base64'),
      },
    };
    await create(['-f', '-'], JSON.stringify(secret));
    await create(
      ['-f', '-'],
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'notebook-qualification', namespace },
        data: { 'deployment-id': deployment, 'kernel-image': kernelImage },
      }),
    );
    await create(['-f', 'k8s/notebook/test-postgres.yaml']);
    await call([
      '-n',
      namespace,
      'wait',
      '--for=condition=Ready',
      'pod/notebook-qualification-postgres',
      '--timeout=120s',
    ]);
    const pod = JSON.parse(
      (
        await call([
          'create',
          '--dry-run=client',
          '-f',
          'k8s/notebook/api-worker.yaml',
          '-o',
          'json',
        ])
      ).stdout,
    );
    pod.spec.containers[0].image = image;
    pod.metadata.labels = { ...pod.metadata.labels, 'aira.nexus/qualification': deployment };
    await create(['-f', '-'], JSON.stringify(pod));
    await call([
      '-n',
      namespace,
      'wait',
      '--for=condition=Ready',
      'pod/notebook-qualification-gateway',
      '--timeout=120s',
    ]);
    if (interrupted) throw new Error('Qualification stopped before execution.');
    await new Promise((resolve, reject) => {
      active = spawn(
        'kubectl',
        [
          ...base,
          '-n',
          namespace,
          'exec',
          '-i',
          'notebook-qualification-gateway',
          '-c',
          'gateway',
          '--',
          'node',
          '--input-type=module',
          '-',
          '--inside',
        ],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      active.once('error', reject);
      active.once('close', (code) => {
        active = undefined;
        if (code === 0 && !interrupted) resolve();
        else reject(new Error('In-cluster qualification failed or was interrupted.'));
      });
      active.stdin.on('error', reject);
      active.stdin.end(readFileSync(fileURLToPath(import.meta.url)));
    });
  } catch (error) {
    failure ??= error;
  } finally {
    clearInterval(timer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (termination) {
      try {
        await termination;
      } catch (error) {
        failure ??= error;
      }
    }
    const cleanupErrors = [];
    try {
      const list = JSON.parse(
        (
          await call([
            'get',
            'namespaces',
            '-l',
            `aira.nexus/deployment=${deployment}`,
            '-o',
            'json',
          ])
        ).stdout,
      );
      const deleted = [];
      await Promise.all(
        list.items.map(async (item) => {
          try {
            if (
              !new RegExp(`^${prefix}[a-f0-9-]{36}$`).test(item.metadata.name) ||
              item.metadata.labels?.['aira.nexus/component'] !== 'notebook-project' ||
              item.metadata.labels?.['aira.nexus/deployment'] !== deployment
            )
              throw new Error('Unexpected namespace in qualification cleanup.');
            const resource = `namespace/${item.metadata.name}`;
            await removeVerified(resource, item.metadata.uid, false);
            deleted.push(resource);
          } catch (error) {
            cleanupErrors.push(error.message);
          }
        }),
      );
      await Promise.all(
        deleted.map(async (resource) => {
          try {
            await call(['wait', '--for=delete', resource, '--timeout=120s']);
          } catch (error) {
            cleanupErrors.push(error.message);
          }
        }),
      );
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    for (const [resource, uid] of [...created.entries()].reverse()) {
      try {
        const current = (await call(['get', resource, '--ignore-not-found', '-o', 'json'])).stdout;
        if (!current) continue;
        const metadata = JSON.parse(current).metadata;
        if (
          metadata.labels?.['aira.nexus/qualification'] !== deployment ||
          (uid && metadata.uid !== uid)
        ) {
          cleanupErrors.push(`Refusing to delete replaced ${resource}.`);
          continue;
        }
        await removeVerified(resource, metadata.uid);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    if (cleanupErrors.length) {
      logError(`Qualification cleanup failed: ${cleanupErrors.join('; ')}`);
      failure ??= new Error('Qualification cleanup failed.');
    }
  }
  if (failure) throw failure;
  log('PASS qualification resources removed');
}

async function inside() {
  const assert = (await import('node:assert/strict')).default;
  const { createRequire } = await import('node:module');
  const { readdir, readFile } = await import('node:fs/promises');
  const { createApp } = await import('/app/dist/server/app.js');
  const { createTokenVerifier } = await import('/app/dist/server/identity.js');
  const { ProjectRepository } = await import('/app/dist/server/projects.js');
  const { FileRepository } = await import('/app/dist/server/files/repository.js');
  const { FileService } = await import('/app/dist/server/files/service.js');
  const { AzureBlobStore } = await import('/app/dist/server/files/store.js');
  const { NotebookRepository } = await import('/app/dist/server/notebook/repository.js');
  const { NotebookService } = await import('/app/dist/server/notebook/service.js');
  const { NotebookRuntime } = await import('/app/dist/server/notebook/runtime.js');
  const require = createRequire('/app/package.json');
  const { Pool } = require('pg');
  const { serve } = require('@hono/node-server');
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(
    require.resolve('jose')
  );
  const pool = new Pool({
    host: 'notebook-qualification-postgres',
    port: 5432,
    user: 'notebooktest',
    password: process.env.PGPASSWORD,
    database: 'notebooktest',
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  const runtime = new NotebookRuntime(process.env);
  const repository = new NotebookRepository(pool);
  let server;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const name of (await readdir('/app/db/migrations'))
        .filter((n) => /^\d+_.+\.sql$/.test(n))
        .sort())
        await client.query(await readFile(`/app/db/migrations/${name}`, 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const tenantId = randomUUID(),
      apiClientId = randomUUID(),
      spaClientId = randomUUID();
    const owner = { tenantId, objectId: randomUUID() };
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'local', alg: 'RS256', use: 'sig' };
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const sign = async (oid) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iss: issuer,
        aud: apiClientId,
        tid: tenantId,
        oid,
        azp: spaClientId,
        scp: 'access_as_user',
        ver: '2.0',
        iat: now,
        nbf: now - 1,
        exp: now + 3600,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'local' })
        .sign(privateKey);
    };
    const ownerToken = await sign(owner.objectId),
      foreignToken = await sign(randomUUID());
    const projects = new ProjectRepository(pool);
    const storage = {
      mode: 'azurite',
      endpoint: 'http://127.0.0.1:10000/notebooktest',
      account: 'notebooktest',
      key: process.env.AZURITE_ACCOUNT_KEY,
      container: 'notebook-qualification',
    };
    const files = new FileService(new FileRepository(pool), new AzureBlobStore(storage));
    let app;
    server = await new Promise((resolve) => {
      const listener = serve(
        { hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) },
        () => resolve(listener),
      );
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = {
      tenantId,
      apiClientId,
      spaClientId,
      publicOrigin: origin,
      databaseUrl: 'postgresql://disposable/notebooktest',
      port: server.address().port,
      notebookEnabled: true,
      projectManagementEnabled: true,
    };
    app = createApp({
      config,
      projects,
      files,
      verifyToken: createTokenVerifier(config, createLocalJWKSet({ keys: [jwk] })),
      notebook: { pool, runtime, files },
    });
    async function request(path, method = 'GET', body, token = ownerToken, headers = {}) {
      return fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: origin,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(240000),
      });
    }
    async function ok(path, method, body, expected = 200) {
      const response = await request(path, method, body);
      assert.equal(response.status, expected, `${method} ${path} failed`);
      return response.json();
    }
    const path = (project) => `/api/projects/${project}/notebook`;
    const create = (project, language, code) =>
      ok(`${path(project)}/cells`, 'POST', { language, code }, 201);
    const execute = (project, cell, ids = []) =>
      ok(`${path(project)}/cells/${cell.id}/execute`, 'POST', {
        version: cell.version,
        files: ids,
      });
    const project = await projects.create(owner, 'Disposable notebook smoke');
    const input = Buffer.from('value\n42\n');
    const file = await files.upload(
      owner,
      project.id,
      { name: 'data.csv', size: input.length },
      new ReadableStream({
        start(c) {
          c.enqueue(input);
          c.close();
        },
      }),
    );
    assert.equal((await request(path(project.id), 'GET', undefined, foreignToken)).status, 404);
    assert.equal(
      (
        await request(
          `${path(project.id)}/cells`,
          'POST',
          { language: 'python', code: '1' },
          ownerToken,
          { Origin: 'https://foreign.invalid' },
        )
      ).status,
      400,
    );
    const python = await create(
      project.id,
      'python',
      `x=42
print(open('/data/${file.id}/data.csv').read())
try:
 open('/data/${file.id}/data.csv','w')
except OSError: print('read-only')
open('/outputs/result.csv','w').write('artifact')`,
    );
    const first = await execute(project.id, python, [file.id]);
    assert.match(first.output, /value\n42/);
    assert.match(first.output, /read-only/);
    const again = await create(project.id, 'python', 'print(x)');
    assert.match((await execute(project.id, again, [file.id])).output, /42/);
    const artifact = await ok(
      `${path(project.id)}/artifacts`,
      'POST',
      { language: 'python', name: 'result.csv' },
      201,
    );
    const freshFiles = new FileService(new FileRepository(pool), new AzureBlobStore(storage));
    assert.equal(
      await new Response((await freshFiles.open(owner, project.id, artifact.id)).body).text(),
      'artifact',
    );
    const r = await create(project.id, 'r', 'x <- 12; print(x)');
    assert.match((await execute(project.id, r)).output, /12/);
    const rAgain = await create(project.id, 'r', 'print(x)');
    assert.match((await execute(project.id, rAgain)).output, /12/);
    log(
      'PASS HTTP authorization, separate Python/R state, read-only staging and Azurite artifact persistence',
    );

    const resources = await create(
      project.id,
      'python',
      `
import time
print('cpu',open('/sys/fs/cgroup/cpu.max').read().strip())
print('memory',open('/sys/fs/cgroup/memory.max').read().strip())
a=bytearray(512*1024*1024)
print('allocated',len(a))
del a
t=time.monotonic(); cpu=time.process_time()
while time.monotonic()-t<4: pass
print('cpu_seconds',round(time.process_time()-cpu,2))
`,
    );
    const load = await execute(project.id, resources, [file.id]);
    assert.match(load.output, /cpu 100000 100000/);
    assert.match(load.output, /memory 2147483648/);
    assert.match(load.output, /allocated 536870912/);
    assert.match(load.output, /cpu_seconds/);
    log('PASS 1-core and 2-GiB cgroups with real CPU and 512-MiB memory load');

    const timeout = await create(project.id, 'python', 'while True: pass');
    const start = Date.now();
    const timed = await execute(project.id, timeout, [file.id]);
    assert.equal(timed.stateLost, true);
    assert.match(timed.output, /execution interrupted/);
    assert.ok(Date.now() - start >= 110000, 'Timeout occurred before the 120-second limit.');
    log('PASS 120-second timeout stops the kernel and reports state loss');
    const afterTimeout = await execute(project.id, again, [file.id]);
    assert.equal(afterTimeout.stateLost, true);
    assert.match(afterTimeout.output, /NameError/);

    const extras = [];
    for (let i = 0; i < 6; i++) {
      const extra = await projects.create(owner, `Kernel capacity ${i}`);
      const cell = await create(extra.id, 'python', "print(globals().get('x','isolated'))");
      assert.match((await execute(extra.id, cell)).output, /isolated/);
      extras.push(extra);
    }
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM notebook_kernels')).rows[0].n,
      8,
    );
    const ninth = await projects.create(owner, 'Ninth kernel');
    const denied = await create(ninth.id, 'python', 'print(1)');
    assert.equal(
      (
        await request(`${path(ninth.id)}/cells/${denied.id}/execute`, 'POST', {
          version: denied.version,
        })
      ).status,
      429,
    );
    const pods = await runtime.kube.json([
      'get',
      'pods',
      '--all-namespaces',
      '-l',
      `aira.nexus/deployment=${process.env.NOTEBOOK_DEPLOYMENT_ID},aira.nexus/component=notebook-kernel`,
    ]);
    assert.equal(pods.items.length, 8);
    assert.ok(
      pods.items.every(
        (pod) => pod.spec.runtimeClassName === 'kata' && pod.status.phase === 'Running',
      ),
    );
    log('PASS eight live Kata kernel Pods and ninth-kernel admission rejection');

    await pool.query(
      "UPDATE notebook_kernels SET last_used_at=clock_timestamp()-interval '901 seconds' WHERE project_id=$1",
      [extras[0].id],
    );
    await new NotebookService(repository, runtime, files).reclaim();
    assert.equal(
      (
        await runtime.kube.command([
          'get',
          'namespace',
          runtime.kube.namespace(extras[0].id),
          '--ignore-not-found',
          '-o',
          'json',
        ])
      ).length,
      0,
    );
    const trashed = await request(
      `/api/project-management/projects/${project.id}/trash`,
      'POST',
      {},
      ownerToken,
      { 'If-Match': '"1"' },
    );
    assert.equal(trashed.status, 200);
    assert.equal((await request(path(project.id))).status, 404);
    assert.equal(
      (
        await runtime.kube.command([
          'get',
          'namespace',
          runtime.kube.namespace(project.id),
          '--ignore-not-found',
          '-o',
          'json',
        ])
      ).length,
      0,
    );
    const restored = await request(
      `/api/project-management/projects/${project.id}/restore`,
      'POST',
      {},
      ownerToken,
      { 'If-Match': '"2"' },
    );
    assert.equal(restored.status, 200);
    const saved = await ok(path(project.id), 'GET');
    assert.equal(saved.cells.length, 6);
    const after = await execute(project.id, again, [file.id]);
    assert.equal(after.stateLost, true);
    assert.match(after.output, /NameError/);
    assert.equal(
      await new Response((await freshFiles.open(owner, project.id, artifact.id)).body).text(),
      'artifact',
    );
    log('PASS idle and trash cleanup, restore, state loss and durable cells/artifact');
  } finally {
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await pool.end();
  }
}

if (process.argv.includes('--inside')) await inside();
else {
  log('Qualification started');
  await host();
}
