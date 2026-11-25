import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { ProjectRepository } from '../src/server/projects.js';
import { alice, config, identityFixture } from './helpers/identity.js';

const root = process.cwd();
const startupEnv = {
  ENTRA_TENANT_ID: config.tenantId,
  ENTRA_API_CLIENT_ID: config.apiClientId,
  ENTRA_SPA_CLIENT_ID: config.spaClientId,
  PUBLIC_ORIGIN: config.publicOrigin,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
};

function command(file: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: root, env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== 'number') return reject(error);
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function until(check: () => Promise<boolean>, message: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function responds(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return true;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))
      return false;
    throw error;
  }
}

const serviceSchema = z
  .object({
    image: z.string(),
    network_mode: z.string(),
    user: z.string(),
    read_only: z.boolean().optional(),
    volumes: z.array(
      z
        .object({
          source: z.string(),
          target: z.string(),
          read_only: z.boolean(),
        })
        .passthrough(),
    ),
    healthcheck: z.object({ test: z.tuple([z.literal('CMD-SHELL'), z.string()]) }).passthrough(),
  })
  .passthrough();
const inspectSchema = z.object({
  Config: z.object({ Image: z.string(), User: z.string() }),
  HostConfig: z.object({
    NetworkMode: z.string(),
    ReadonlyRootfs: z.boolean(),
    CapDrop: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    Tmpfs: z.record(z.string(), z.string()),
  }),
  Mounts: z.array(z.object({ Destination: z.string(), RW: z.boolean() })),
  State: z.object({ Health: z.object({ Status: z.string() }) }),
});

async function proxyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aira-proxy-test-'));
  const project = `aira-proxy-test-${randomUUID()}`;
  const proxyPort = await availablePort();
  const identity = await identityFixture();
  const pool = new Pool({ connectionString: startupEnv.DATABASE_URL });
  const app = createApp({
    config,
    verifyToken: identity.verify,
    projects: new ProjectRepository(pool),
  });
  app.post('/proxy-probe', async (c) =>
    c.json(
      {
        path: new URL(c.req.url).pathname,
        query: new URL(c.req.url).search,
        body: await c.req.text(),
        host: c.req.header('host'),
        authorization: c.req.header('authorization'),
        version: c.req.header('if-match'),
        forwardedFor: c.req.header('x-forwarded-for'),
        forwardedProto: c.req.header('x-forwarded-proto'),
        realIp: c.req.header('x-real-ip'),
        forwarded: c.req.header('forwarded') ?? null,
      },
      409,
    ),
  );
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected HTTP address.');
  const upstreamPort = address.port;
  const args: string[] = [];
  let started = false;
  let upstreamClosed = false;
  const closeUpstream = async () => {
    if (!upstreamClosed) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      upstreamClosed = true;
    }
  };
  const stop = async () => {
    try {
      if (started) {
        const down = await command('docker', [...args, 'down']);
        expect(down.code, down.stderr).toBe(0);
      }
    } finally {
      try {
        await closeUpstream();
      } finally {
        try {
          await pool.end();
        } finally {
          await rm(directory, { recursive: true });
        }
      }
    }
  };
  try {
    const compose = await command('docker', [
      'compose',
      '-f',
      'compose.proxy.yml',
      'config',
      '--format',
      'json',
    ]);
    expect(compose.code, compose.stderr).toBe(0);
    const service = serviceSchema.parse(JSON.parse(compose.stdout).services.nginx);
    const source = await readFile('nginx/tunnel.conf', 'utf8');
    expect([...source.matchAll(/\blisten\s+([^;]+);/g)].map((match) => match[1])).toEqual([
      '127.0.0.1:18080',
    ]);
    await writeFile(
      join(directory, 'nginx.conf'),
      source.replaceAll(':18080', `:${proxyPort}`).replaceAll(':3000', `:${upstreamPort}`),
    );
    const healthCommand = service.healthcheck.test[1]
      .replaceAll('18080', String(proxyPort))
      .replaceAll('3000', String(upstreamPort));
    const runtime = {
      services: {
        nginx: {
          ...service,
          volumes: service.volumes.map((volume) => ({
            ...volume,
            source:
              volume.target === '/etc/nginx/nginx.conf'
                ? join(directory, 'nginx.conf')
                : volume.source,
          })),
          healthcheck: {
            ...service.healthcheck,
            test: ['CMD-SHELL', healthCommand],
            interval: '1s',
            timeout: '2s',
            retries: 1,
            start_period: '0s',
          },
        },
      },
    };
    const composePath = join(directory, 'compose.json');
    await writeFile(composePath, JSON.stringify(runtime));
    args.push('compose', '-p', project, '-f', composePath);
    started = true;
    const up = await command('docker', [...args, 'up', '-d', 'nginx']);
    expect(up.code, up.stderr).toBe(0);
    const id = (await command('docker', [...args, 'ps', '-q', 'nginx'])).stdout.trim();
    expect(id).not.toBe('');
    await until(
      () => responds(`http://127.0.0.1:${proxyPort}/health/live`),
      'nginx did not respond',
    );
    return {
      url: `http://127.0.0.1:${proxyPort}`,
      id,
      identity,
      proxyPort,
      upstreamPort,
      healthCommand,
      closeUpstream,
      stop,
      inspect: async () => {
        const result = await command('docker', ['inspect', id]);
        expect(result.code, result.stderr).toBe(0);
        return z.tuple([inspectSchema]).parse(JSON.parse(result.stdout))[0];
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

describe('SSH-only nginx development proxy', () => {
  /** @id TEST-TUN-001 @verifies REQ-TUN-001 */
  it('TEST-TUN-001 preserves real authentication and request/response semantics without request logging', async () => {
    const proxy = await proxyFixture();
    try {
      const missing = await fetch(`${proxy.url}/api/me`);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toBe('Bearer');
      expect(await missing.text()).toContain('UNAUTHENTICATED');
      const token = await proxy.identity.sign();
      const valid = await fetch(`${proxy.url}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ tenantId: config.tenantId, objectId: alice });
      expect(valid.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
      expect(valid.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(valid.headers.get('cache-control')).toBe('no-store');
      const response = await fetch(`${proxy.url}/proxy-probe?do-not-log=sensitive-probe`, {
        method: 'POST',
        body: 'private-probe-body',
        headers: {
          Authorization: 'Bearer private-probe-header',
          'If-Match': '"7"',
          'X-Forwarded-For': '198.51.100.10',
          'X-Forwarded-Proto': 'https',
          'X-Real-IP': '198.51.100.10',
          Forwarded: 'for=198.51.100.10',
        },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        path: '/proxy-probe',
        query: '?do-not-log=sensitive-probe',
        body: 'private-probe-body',
        host: `127.0.0.1:${proxy.proxyPort}`,
        authorization: 'Bearer private-probe-header',
        version: '"7"',
        forwardedFor: '127.0.0.1',
        forwardedProto: 'http',
        realIp: '127.0.0.1',
        forwarded: null,
      });
      const logs = await command('docker', ['logs', proxy.id]);
      expect(logs.code, logs.stderr).toBe(0);
      expect(logs.stdout.trim()).toMatch(/^\d{3}(?:\n\d{3})*$/);
      expect(logs.stdout + logs.stderr).not.toMatch(
        /private-probe|sensitive-probe|proxy-probe|Bearer/,
      );
    } finally {
      await proxy.stop();
    }
  }, 60_000);

  /** @id TEST-TUN-002 @verifies REQ-TUN-002 */
  it('TEST-TUN-002 validates loopback configuration and binds the actual Node listener', async () => {
    expect(readConfig({ ...startupEnv, BIND_HOST: '127.0.0.1' })).toMatchObject({
      bindHost: '127.0.0.1',
    });
    for (const value of ['', '0.0.0.0', '::', '::1', 'localhost', '192.0.2.1', '127.0.0.1:3000'])
      expect(() => readConfig({ ...startupEnv, BIND_HOST: value }), value).toThrow();
    expect(readConfig(startupEnv)).not.toHaveProperty('bindHost');
    for (const loopback of [true, false]) {
      const port = await availablePort();
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
        cwd: root,
        env: {
          ...startupEnv,
          PATH: process.env.PATH,
          PORT: String(port),
          ...(loopback ? { BIND_HOST: '127.0.0.1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      try {
        await until(() => responds(`http://127.0.0.1:${port}/health/live`), 'Node startup failed');
        const sockets = await command('ss', ['-H', '-ltn', `sport = :${port}`]);
        expect(sockets.code, sockets.stderr).toBe(0);
        const addresses = sockets.stdout
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/)[3]);
        expect(addresses).toEqual([`${loopback ? '127.0.0.1' : '0.0.0.0'}:${port}`]);
        if (!loopback) {
          expect(stderr).toMatch(/BIND_HOST.*unset|non-loopback/i);
          expect(stderr).not.toContain(config.tenantId);
          expect(stderr).not.toContain(startupEnv.DATABASE_URL);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
      }
    }
  }, 60_000);

  /** @id TEST-TUN-003 @verifies REQ-TUN-003 */
  it('TEST-TUN-003 rejects every unsafe socket/action policy row and stops only its proxy', async () => {
    expect((await command('/bin/sh', ['scripts/proxy.sh', 'invalid-action'])).code).toBe(2);
    const cases = [
      { tool: 'ss', output: '', code: 0, accepted: false },
      { tool: 'ss', output: 'LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\n', code: 0, accepted: true },
      { tool: 'ss', output: 'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*\n', code: 0, accepted: false },
      { tool: 'ss', output: 'LISTEN 0 128 [::]:3000 [::]:*\n', code: 0, accepted: false },
      { tool: 'ss', output: 'LISTEN 0 128 [::1]:3000 [::]:*\n', code: 0, accepted: false },
      { tool: 'ss', output: 'LISTEN 0 128 *:3000 *:*\n', code: 0, accepted: false },
      {
        tool: 'ss',
        output: 'LISTEN 0 128 [::ffff:127.0.0.1]:3000 [::]:*\n',
        code: 0,
        accepted: false,
      },
      {
        tool: 'ss',
        output: 'LISTEN 0 128 127.0.0.1:3000 *:*\nLISTEN 0 128 [::]:3000 *:*\n',
        code: 0,
        accepted: false,
      },
      { tool: 'ss', output: 'LISTEN 0 128 127.0.0.1:30000 *:*\n', code: 0, accepted: false },
      { tool: 'ss', output: 'LISTEN 0 128 127.0.0.1:3000 *:*\n', code: 7, accepted: false },
      {
        tool: 'netstat',
        output: 'tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN\n',
        code: 0,
        accepted: true,
      },
      { tool: '', output: '', code: 0, accepted: false },
    ];
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'aira-socket-policy-'));
      const capture = join(directory, 'docker.json');
      try {
        const capturedCalls = async () =>
          existsSync(capture)
            ? (await readFile(capture, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => z.array(z.string()).parse(JSON.parse(line)))
            : [];
        const tools: [string, string][] = [
          ['awk', '/usr/bin/awk'],
          ['dirname', '/usr/bin/dirname'],
          ['sh', '/bin/sh'],
        ];
        for (const [name, target] of tools) await symlink(target, join(directory, name));
        if (item.tool)
          await writeFile(
            join(directory, item.tool),
            `#!${process.execPath}\nif(process.argv.includes('-4')||process.argv.includes('-6'))process.exit(9);\nprocess.stdout.write(${JSON.stringify(item.output)});process.exit(${item.code});\n`,
            { mode: 0o755 },
          );
        await writeFile(
          join(directory, 'docker'),
          `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,
          { mode: 0o755 },
        );
        const env = { PATH: directory };
        const result = await command('/bin/sh', ['scripts/proxy.sh', 'up'], env);
        expect(result.code === 0, `${item.tool || 'missing tools'}: ${item.output}`).toBe(
          item.accepted,
        );
        if (!item.accepted) expect(result.stderr).toMatch(/loopback|listener|socket|tool/i);
        const expectedCalls = item.accepted
          ? [
              [
                'compose',
                '-p',
                'aira-nexus-proxy',
                '-f',
                'compose.proxy.yml',
                'up',
                '-d',
                '--wait',
                '--wait-timeout',
                '30',
                'nginx',
              ],
            ]
          : [];
        expect(await capturedCalls()).toEqual(expectedCalls);
        const stopped = await command('/bin/sh', ['scripts/proxy.sh', 'stop'], env);
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(await capturedCalls()).toEqual([
          ...expectedCalls,
          ['compose', '-p', 'aira-nexus-proxy', '-f', 'compose.proxy.yml', 'stop', 'nginx'],
        ]);
      } finally {
        await rm(directory, { recursive: true });
      }
    }
  }, 60_000);

  /** @id TEST-TUN-004 @verifies REQ-TUN-004 */
  it('TEST-TUN-004 inspects real nginx isolation and fails health for missing/unsafe/dead upstream', async () => {
    const proxy = await proxyFixture();
    try {
      const runtime = await proxy.inspect();
      expect(runtime.Config.Image).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(runtime.Config.User).not.toMatch(/^(?:|0(?::0)?|root)$/);
      expect(runtime.HostConfig.NetworkMode).toBe('host');
      expect(runtime.HostConfig.ReadonlyRootfs).toBe(true);
      expect(runtime.HostConfig.CapDrop).toContain('ALL');
      expect(
        runtime.HostConfig.SecurityOpt?.some((value) =>
          /^no-new-privileges(?::true)?$/.test(value),
        ),
      ).toBe(true);
      for (const path of ['/tmp', '/var/cache/nginx']) {
        expect(runtime.HostConfig.Tmpfs[path]).toMatch(/size=/);
        expect(runtime.HostConfig.Tmpfs[path]).toContain('nosuid');
      }
      for (const path of ['/etc/nginx/nginx.conf', '/usr/local/bin/aira-check-loopback.sh'])
        expect(runtime.Mounts.find((mount) => mount.Destination === path)?.RW).toBe(false);
      const uid = await command('docker', ['exec', proxy.id, 'id', '-u']);
      expect(uid.code, uid.stderr).toBe(0);
      expect(Number(uid.stdout.trim())).toBeGreaterThan(0);
      const sockets = await command('ss', ['-H', '-ltn', `sport = :${proxy.proxyPort}`]);
      expect(
        sockets.stdout
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/)[3]),
      ).toEqual([`127.0.0.1:${proxy.proxyPort}`]);
      await until(
        async () => (await proxy.inspect()).State.Health.Status === 'healthy',
        'Expected healthy proxy',
      );
      await proxy.closeUpstream();
      await until(
        async () => (await proxy.inspect()).State.Health.Status === 'unhealthy',
        'Missing listener must fail health',
      );
      for (const host of ['0.0.0.0', '127.0.0.1']) {
        const replacement = createServer((socket) => {
          socket.resume();
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
          );
        });
        replacement.listen(proxy.upstreamPort, host);
        await once(replacement, 'listening');
        try {
          const health = await command('docker', [
            'exec',
            proxy.id,
            'sh',
            '-c',
            proxy.healthCommand,
          ]);
          expect(health.code, `${host} must fail health`).not.toBe(0);
          if (host === '127.0.0.1') {
            const loopback = await command('docker', [
              'exec',
              proxy.id,
              'sh',
              '/usr/local/bin/aira-check-loopback.sh',
              String(proxy.upstreamPort),
            ]);
            expect(loopback.code, loopback.stderr).toBe(0);
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            replacement.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    } finally {
      await proxy.stop();
    }
  }, 60_000);
});
