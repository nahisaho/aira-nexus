import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

async function setupQualification(
  holdWait: boolean,
  breachThreshold = false,
  failUidRead = false,
  failProjectDelete = false,
  stallProjectWait = false,
  initialLoad = 0,
  subsequentLoad = initialLoad,
) {
  const dir = await mkdtemp(join(tmpdir(), 'notebook-verify-test-'));
  const marker = join(dir, 'waiting');
  const deletions = join(dir, 'deletions');
  const qualification = join(dir, 'qualification');
  const failedUid = join(dir, 'failed-uid');
  const loadSample = join(dir, 'load-sample');
  const kubectl = join(dir, 'kubectl');
  await writeFile(
    kubectl,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('wait') && args.includes('pod/notebook-qualification-postgres')) {
  fs.writeFileSync(process.env.WAIT_MARKER, '');
  if (process.env.HOLD_WAIT === 'true') setTimeout(() => process.exit(0), 15000);
} else if (args.includes('wait') && process.env.STALL_PROJECT_WAIT === 'true' && args.includes('namespace/aira-qual-00000000-0000-4000-8000-000000000001')) {
  setTimeout(() => process.exit(0), 8000);
} else if (args.includes('config')) {
  console.log(JSON.stringify({clusters:[{cluster:{server:'https://127.0.0.1:1234'}}]}));
} else if (args.includes('nodes')) {
  console.log(JSON.stringify({items:[{metadata:{labels:{'aira.nexus/purpose':'notebook-qualification','aira.nexus/owner':'test'}}}]}));
} else if (args.includes('runtimeclass')) {
  console.log(JSON.stringify({handler:'kata'}));
} else if (args.includes('namespaces')) {
  const id = fs.readFileSync(process.env.QUALIFICATION, 'utf8');
  const items = process.env.FAIL_PROJECT_DELETE === 'true' || process.env.STALL_PROJECT_WAIT === 'true'
    ? ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'].map(suffix => ({metadata:{name:'aira-qual-'+suffix,uid:'test-uid',labels:{'aira.nexus/deployment':id,'aira.nexus/component':'notebook-project'}}}))
    : [];
  console.log(JSON.stringify({items}));
} else if (args.includes('label')) {
  const label = args.find(arg => arg.startsWith('aira.nexus/qualification='));
  fs.writeFileSync(process.env.QUALIFICATION, label.split('=')[1]);
  if (args.includes('k8s/notebook/rbac.yaml')) {
    for (const kind of ['ServiceAccount', 'ClusterRole', 'ClusterRoleBinding'])
      console.log(JSON.stringify({apiVersion:'v1', kind}));
  } else console.log(JSON.stringify({apiVersion:'v1',kind:'Namespace'}));
} else if (args.includes('exec')) {
  process.stdin.resume();
} else if (args.includes('create')) {
  if (args.includes('--dry-run=client')) console.log(JSON.stringify({metadata:{labels:{}},spec:{containers:[{}]}}));
  else if (args.includes('k8s/notebook/namespace.yaml')) console.log('namespace/aira-notebook-qualification');
  if (args.includes('k8s/notebook/rbac.yaml')) console.log('clusterrole.rbac.authorization.k8s.io/notebook-qualification\\nclusterrolebinding.rbac.authorization.k8s.io/notebook-qualification');
  if (args.includes('-')) {
    let body;
    try { body = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(1); }
    if (body.kind === 'List' && body.items.some(item => item.kind === 'Namespace')) console.log('namespace/aira-notebook-qualification');
    if (body.kind === 'List' && body.items.some(item => item.kind === 'ClusterRole')) console.log('clusterrole.rbac.authorization.k8s.io/notebook-qualification\\nclusterrolebinding.rbac.authorization.k8s.io/notebook-qualification');
  }
} else if (args.includes('delete')) {
  const body = args.includes('--raw') ? fs.readFileSync(0, 'utf8') : '';
  fs.appendFileSync(process.env.DELETIONS, args.join(' ') + ' ' + body + '\\n');
  if (process.env.FAIL_PROJECT_DELETE === 'true' && args.some(arg => arg.endsWith('00000000-0000-4000-8000-000000000001'))) process.exit(1);
} else if (args.includes('get') && args.includes('json')) {
  if (process.env.FAIL_UID === 'true' && args.includes('clusterrole.rbac.authorization.k8s.io/notebook-qualification') && !fs.existsSync(process.env.FAILED_UID)) {
    fs.writeFileSync(process.env.FAILED_UID, '');
    process.exit(1);
  }
  const id = fs.existsSync(process.env.QUALIFICATION) ? fs.readFileSync(process.env.QUALIFICATION, 'utf8') : '';
  console.log(JSON.stringify({metadata:{uid:'test-uid', labels:{'aira.nexus/qualification':id}}}));
}
`,
    { mode: 0o755 },
  );
  const preload = join(dir, 'memory-preload.mjs');
  await writeFile(
    preload,
    `import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
let reads = 0;
fs.readFileSync = function(path, ...args) {
  if (path === '/proc/meminfo') {
    const available = process.env.BREACH_THRESHOLD === 'true' && ++reads > 1 ? 1 : 50 * 1024 * 1024;
    return 'MemAvailable: ' + available + ' kB\\nSwapTotal: 0 kB\\nSwapFree: 0 kB\\n';
  }
  return original.call(this, path, ...args);
};
let loadReads = 0;
os.loadavg = () => {
  if (++loadReads > 1) fs.writeFileSync(process.env.LOAD_SAMPLE, '');
  return [Number(loadReads > 1 ? process.env.SUBSEQUENT_LOAD : process.env.INITIAL_LOAD), 0, 0];
};
syncBuiltinESMExports();
`,
  );
  const child = spawn(process.execPath, ['scripts/verify-notebook-cluster.mjs'], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      WAIT_MARKER: marker,
      DELETIONS: deletions,
      QUALIFICATION: qualification,
      FAILED_UID: failedUid,
      LOAD_SAMPLE: loadSample,
      INITIAL_LOAD: String(initialLoad),
      SUBSEQUENT_LOAD: String(subsequentLoad),
      FAIL_UID: String(failUidRead),
      FAIL_PROJECT_DELETE: String(failProjectDelete),
      STALL_PROJECT_WAIT: String(stallProjectWait),
      HOLD_WAIT: String(holdWait),
      BREACH_THRESHOLD: String(breachThreshold),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
      KUBECONFIG: '/tmp/disposable-test-kubeconfig',
      NOTEBOOK_VERIFY_CONTEXT: 'kind-test',
      NOTEBOOK_VERIFY_DISPOSABLE: 'true',
      NOTEBOOK_VERIFY_API_IMAGE: 'test',
      NOTEBOOK_VERIFY_KERNEL_IMAGE: `test@sha256:${'a'.repeat(64)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    stderr += data;
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    dir,
    marker,
    deletions,
    loadSample,
    child,
    finished,
    output: () => ({ stdout, stderr }),
  };
}

it('allows a load of 18 at startup and while running', async () => {
  const { dir, marker, loadSample, child, finished, output } = await setupQualification(
    true,
    false,
    false,
    false,
    false,
    18,
  );
  try {
    await vi.waitFor(
      async () => {
        expect(child.exitCode, output().stderr).toBeNull();
        await stat(marker);
      },
      { timeout: 5000, interval: 20 },
    );
    await vi.waitFor(() => stat(loadSample), { timeout: 8000, interval: 20 });
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    expect(await finished).not.toBe(0);
    expect(output().stderr).toContain('Qualification interrupted.');
    expect(output().stderr).not.toContain('Host resource threshold reached');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('rejects startup when load is above 18', async () => {
  const { dir, child, finished, output } = await setupQualification(
    false,
    false,
    false,
    false,
    false,
    18.01,
  );
  try {
    expect(await finished).not.toBe(0);
    expect(output().stderr).toContain('Insufficient host headroom');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('stops a pending wait when load rises above 18', async () => {
  const { dir, child, finished, output } = await setupQualification(
    true,
    false,
    false,
    false,
    false,
    0,
    18.01,
  );
  try {
    expect(await finished).not.toBe(0);
    expect(output().stderr).toContain('Host resource threshold reached');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('interrupts a pending kubectl wait and cleans up created qualification resources', async () => {
  const { dir, marker, deletions, child, finished, output } = await setupQualification(true);
  try {
    await vi.waitFor(() => stat(marker), { timeout: 5000, interval: 20 });
    child.kill('SIGTERM');
    const result = await Promise.race([
      finished,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    expect(result).not.toBe('timeout');
    expect(result).not.toBe(0);
    expect(output().stderr).toContain('Qualification interrupted.');
    const cleanup = await readFile(deletions, 'utf8');
    expect(cleanup).toContain('/api/v1/namespaces/aira-notebook-qualification');
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterroles/notebook-qualification',
    );
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/notebook-qualification',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('requests deletion of all project namespaces before waiting for termination', async () => {
  const { dir, deletions, child, finished } = await setupQualification(
    false,
    false,
    false,
    false,
    true,
  );
  try {
    await vi.waitFor(
      async () => {
        const cleanup = await readFile(deletions, 'utf8');
        expect(cleanup).toContain(
          '/api/v1/namespaces/aira-qual-00000000-0000-4000-8000-000000000002',
        );
      },
      { timeout: 3000, interval: 20 },
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('continues removing other project namespaces after one deletion fails', async () => {
  const { dir, deletions, child, finished, output } = await setupQualification(
    false,
    false,
    false,
    true,
  );
  try {
    expect(await finished).not.toBe(0);
    expect(output().stderr).toContain('Qualification cleanup failed');
    const cleanup = await readFile(deletions, 'utf8');
    expect(cleanup).toContain('/api/v1/namespaces/aira-qual-00000000-0000-4000-8000-000000000002');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('cleans all recorded RBAC resources after an individual UID lookup fails', async () => {
  const { dir, deletions, child, finished } = await setupQualification(false, false, true);
  try {
    expect(await finished).not.toBe(0);
    const cleanup = await readFile(deletions, 'utf8');
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterroles/notebook-qualification',
    );
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/notebook-qualification',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('stops a pending kubectl wait when host memory crosses the safety threshold', async () => {
  const { dir, child, finished, output } = await setupQualification(true, true);
  try {
    expect(await finished).not.toBe(0);
    expect(output().stderr).toContain('Host resource threshold reached');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

it('completes and cleans up when all qualification commands succeed', async () => {
  const { dir, deletions, child, finished, output } = await setupQualification(false);
  try {
    expect(await finished).toBe(0);
    expect(output().stdout).toContain('PASS qualification resources removed');
    expect(output().stdout.trim().split('\n')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[\d{4}-\d\d-\d\dT.*Z\] Qualification deployment:/),
        expect.stringMatching(/^\[\d{4}-\d\d-\d\dT.*Z\] PASS qualification resources removed$/),
      ]),
    );
    const cleanup = await readFile(deletions, 'utf8');
    expect(cleanup).toContain('/api/v1/namespaces/aira-notebook-qualification');
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterroles/notebook-qualification',
    );
    expect(cleanup).toContain(
      '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/notebook-qualification',
    );
    expect(cleanup).toContain('"preconditions":{"uid":"test-uid"}');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);
