import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createLocalJWKSet, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/server/app.js';
import { readConfig, publicConfig } from '../src/server/config.js';
import { createTokenVerifier } from '../src/server/identity.js';
import { ProjectRepository } from '../src/server/projects.js';
import { alice, config, identityFixture } from './helpers/identity.js';

function application(verifyToken: ReturnType<typeof createTokenVerifier>) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  return createApp({ config, verifyToken, projects: new ProjectRepository(pool) });
}

describe('Entra API boundary', () => {
  /** @id TEST-ID-001 @verifies REQ-ID-001 */
  it('TEST-ID-001 accepts signed access tokens and rejects invalid identities', async () => {
    const fixture = await identityFixture();
    const app = application(fixture.verify);
    const request = (token?: string) =>
      app.request('/api/me', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    const valid = await request(await fixture.sign());
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ tenantId: config.tenantId, objectId: alice });
    const invalid = [
      undefined,
      'not-a-token',
      await fixture.sign({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await fixture.sign({ nbf: Math.floor(Date.now() / 1000) + 60 }),
      await fixture.sign({ iss: 'https://attacker.invalid' }),
      await fixture.sign({ aud: 'https://graph.microsoft.com' }),
      await fixture.sign({ tid: '66666666-6666-4666-8666-666666666666' }),
      await fixture.sign({ oid: '../../other-user' }),
      await fixture.sign({ ver: '1.0' }),
      await fixture.sign({ roles: ['admin'] }, ['scp']),
      ...(await Promise.all(
        ['tid', 'oid', 'exp', 'iat', 'nbf', 'azp', 'ver'].map((claim) => fixture.sign({}, [claim])),
      )),
    ];
    const forged = await generateKeyPair('RS256');
    invalid.push(
      await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign(forged.privateKey),
    );
    for (const token of invalid) {
      const response = await request(token);
      expect(response.status, token ? 'invalid signed token' : 'missing token').toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      const body = await response.text();
      expect(body).toContain('UNAUTHENTICATED');
      if (token) expect(body).not.toContain(token);
    }
  });

  /** @id TEST-ID-002 @verifies REQ-ID-002 */
  it('TEST-ID-002 enforces delegated scope/client and distinguishes key outages', async () => {
    const fixture = await identityFixture();
    const app = application(fixture.verify);
    for (const overrides of [{ scp: 'other_scope' }, { azp: config.apiClientId }]) {
      expect(
        (
          await app.request('/api/me', {
            headers: { Authorization: `Bearer ${await fixture.sign(overrides)}` },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await fixture.verify(await fixture.sign({ scp: 'openid access_as_user profile' }))).ok,
    ).toBe(true);
    const unavailable = createTokenVerifier(config, async () => {
      throw new TypeError('key service unavailable with sensitive internal detail');
    });
    const outage = await application(unavailable).request('/api/me', {
      headers: { Authorization: `Bearer ${await fixture.sign()}` },
    });
    expect(outage.status).toBe(503);
    expect(await outage.text()).not.toContain('sensitive internal detail');
    const missingKey = createTokenVerifier(config, createLocalJWKSet({ keys: [] }));
    expect(
      (
        await application(missingKey).request('/api/me', {
          headers: { Authorization: `Bearer ${await fixture.sign()}` },
        })
      ).status,
    ).toBe(401);
  });

  /** @id TEST-ID-003 @verifies REQ-ID-003 */
  it('TEST-ID-003 rejects invalid startup settings and emits only safe configuration', async () => {
    const env = {
      ENTRA_TENANT_ID: config.tenantId,
      ENTRA_API_CLIENT_ID: config.apiClientId,
      ENTRA_SPA_CLIENT_ID: config.spaClientId,
      PUBLIC_ORIGIN: config.publicOrigin,
      DATABASE_URL: config.databaseUrl,
    };
    expect(() => readConfig(env)).not.toThrow();
    expect(readConfig(env)).toEqual(config);
    for (const key of Object.keys(env)) expect(() => readConfig({ ...env, [key]: '' })).toThrow();
    for (const overrides of [
      { ENTRA_TENANT_ID: 'common' },
      { ENTRA_API_CLIENT_ID: 'invalid' },
      { DATABASE_URL: 'https://db.invalid/path' },
      { PUBLIC_ORIGIN: 'http://intranet.example' },
      { PUBLIC_ORIGIN: 'https://user:password@example.org' },
      { PUBLIC_ORIGIN: 'https://example.org/path' },
      { PORT: '0' },
    ])
      expect(() => readConfig({ ...env, ...overrides })).toThrow();
    expect(readConfig({ ...env, PUBLIC_ORIGIN: 'https://research.example.org' }).publicOrigin).toBe(
      'https://research.example.org',
    );
    const response = await application((await identityFixture()).verify).request('/api/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicConfig(config));
    expect(JSON.stringify(publicConfig(config))).not.toContain(config.databaseUrl);
  });

  /** @id TEST-ID-004 @verifies REQ-ID-004 */
  it('TEST-ID-004 separates liveness from database readiness without disclosing failures', async () => {
    const pool = new Pool({ connectionString: config.databaseUrl });
    const projects = new ProjectRepository(pool);
    const ready = vi.spyOn(projects, 'ready').mockResolvedValue();
    const app = createApp({ config, verifyToken: (await identityFixture()).verify, projects });
    expect((await app.request('/health/live')).status).toBe(200);
    expect((await app.request('/health/ready')).status).toBe(200);
    ready.mockRejectedValue(new Error(config.databaseUrl));
    const response = await app.request('/health/ready');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(config.databaseUrl);
    expect((await app.request('/health/live')).status).toBe(200);
    await pool.end();
  });
});
