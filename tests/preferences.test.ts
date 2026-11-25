import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { createTokenVerifier } from '../src/server/identity.js';
import { ProjectRepository } from '../src/server/projects.js';
import { PreferencesRepository } from '../src/server/preferences.js';
import { alice, bob, config, identityFixture } from './helpers/identity.js';
import { testDatabase } from './helpers/database.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let identity: Awaited<ReturnType<typeof identityFixture>>;
beforeAll(async () => {
  db = await testDatabase();
  identity = await identityFixture();
});
afterAll(async () => {
  await db?.close();
});
const owner = { tenantId: config.tenantId, objectId: alice };
async function fixture() {
  const preferences = new PreferencesRepository(db.pool);
  const app = createApp({
    config,
    projects: new ProjectRepository(db.pool),
    verifyToken: identity.verify,
    preferences,
  });
  const bearer = await identity.sign();
  const request = (
    method = 'GET',
    body?: string,
    token = bearer,
    contentType = 'application/json',
  ) =>
    app.request('/api/settings/preferences', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      ...(body === undefined ? {} : { body }),
    });
  return { preferences, app, request };
}
/** @id TEST-PREF-001 @verifies REQ-PREF-001 */
it('TEST-PREF-001 persists owner preferences, defaults and concurrent independent fields', async () => {
  const f = await fixture();
  const read = await f.request();
  expect(read.status).toBe(200);
  expect(read.headers.get('Cache-Control')).toBe('no-store');
  expect(await read.json()).toEqual({ language: 'ja', theme: 'light' });
  const replies = await Promise.all([
    f.request('PATCH', JSON.stringify({ language: 'en' })),
    f.request('PATCH', JSON.stringify({ theme: 'dark' })),
  ]);
  expect(replies.map((r) => r.status)).toEqual([200, 200]);
  const reopened = new PreferencesRepository(db.pool);
  expect(await reopened.get(owner)).toEqual({ language: 'en', theme: 'dark' });
  expect(await reopened.get({ ...owner, objectId: bob })).toEqual({
    language: 'ja',
    theme: 'light',
  });
  expect(await reopened.get({ ...owner, tenantId: bob })).toEqual({
    language: 'ja',
    theme: 'light',
  });
  expect(await (await f.request('PATCH', JSON.stringify({ language: 'ja' }))).json()).toEqual({
    language: 'ja',
    theme: 'dark',
  });
  const foreign = await identity.sign({ oid: bob });
  expect(await (await f.request('GET', undefined, foreign)).json()).toEqual({
    language: 'ja',
    theme: 'light',
  });
});
/** @id TEST-PREF-002 @verifies REQ-PREF-002 */
it('TEST-PREF-002 rejects invalid input and identity fields without modifying stored values', async () => {
  const f = await fixture();
  expect((await f.app.request('/api/settings/preferences')).status).toBe(401);
  await f.preferences.patch(owner, { language: 'en', theme: 'dark' });
  for (const body of [
    '{}',
    'null',
    '[]',
    '{',
    '{"language":"fr"}',
    '{"theme":"system"}',
    '{"language":null}',
    '{"theme":false}',
    `{"language":"ja","objectId":"${bob}"}`,
    '{"language":"en","extra":1}',
  ]) {
    expect((await f.request('PATCH', body)).status, body).toBe(400);
  }
  expect((await f.request('PATCH', '{"theme":"light"}', undefined, 'text/plain')).status).toBe(400);
  expect((await f.request('PATCH', 'x'.repeat(16385))).status).toBe(413);
  expect(await f.preferences.get(owner)).toEqual({ language: 'en', theme: 'dark' });
});

function textSizeConfig(flag?: string, tenantId = config.tenantId) {
  return readConfig({
    ENTRA_TENANT_ID: tenantId,
    ENTRA_API_CLIENT_ID: config.apiClientId,
    ENTRA_SPA_CLIENT_ID: config.spaClientId,
    PUBLIC_ORIGIN: config.publicOrigin,
    DATABASE_URL: config.databaseUrl,
    ...(flag === undefined ? {} : { TEXT_SIZE_ENABLED: flag }),
  });
}

async function textSizeHttp(flag?: string, tenantId = config.tenantId) {
  const activeConfig = textSizeConfig(flag, tenantId);
  const app = createApp({
    config: activeConfig,
    projects: new ProjectRepository(db.pool),
    preferences: new PreferencesRepository(db.pool),
    verifyToken: createTokenVerifier(activeConfig, createLocalJWKSet({ keys: [identity.jwk] })),
  });
  const tokenFor = (objectId = alice) =>
    identity.sign({
      tid: tenantId,
      oid: objectId,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    });
  const bearer = await tokenFor();
  const request = (
    method = 'GET',
    body?: string,
    token = bearer,
    contentType = 'application/json',
  ) =>
    app.request('/api/settings/text-size', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      ...(body === undefined ? {} : { body }),
    });
  return { app, request, tokenFor };
}

async function provisionTextSizeStorage() {
  // Schema-state fixture only, not evidence that migration 008 exists or ran.
  await db.pool.query(`CREATE TABLE IF NOT EXISTS user_text_preferences (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    size text NOT NULL CHECK (size IN ('large','medium','small','extra-small')),
    PRIMARY KEY (tenant_id,object_id)
  )`);
  await db.pool.query('DELETE FROM user_text_preferences');
}

/** @id TEST-FONT-001 @verifies REQ-FONT-001 */
it('TEST-FONT-001 persists strict text size by verified tenant/object and preserves legacy partial updates', async () => {
  expect(
    (await db.pool.query("SELECT to_regclass('user_text_preferences') AS name")).rows[0].name,
  ).toBe('user_text_preferences');
  expect(
    (
      await db.pool.query(
        "SELECT name FROM schema_migrations WHERE name='008_user_text_preferences.sql'",
      )
    ).rowCount,
  ).toBe(1);
  await provisionTextSizeStorage();
  const f = await textSizeHttp('true');
  const absent = await f.request();
  expect(absent.status).toBe(200);
  expect(absent.headers.get('Cache-Control')).toBe('no-store');
  expect(await absent.json()).toEqual({ size: 'large' });
  const sizes = ['extra-small', 'large', 'medium', 'small'];
  for (const from of sizes) {
    for (const size of sizes) {
      expect((await f.request('PATCH', JSON.stringify({ size: from }))).status).toBe(200);
      const patched = await f.request('PATCH', JSON.stringify({ size }));
      expect(patched.status, `${from} -> ${size}`).toBe(200);
      expect(await patched.json()).toEqual({ size });
      expect(await new PreferencesRepository(db.pool).getTextSize(owner)).toEqual({ size });
    }
  }
  const reopened = await textSizeHttp('true');
  expect(await (await reopened.request()).json()).toEqual({ size: 'small' });
  const otherObject = await f.tokenFor(bob);
  expect(await (await f.request('GET', undefined, otherObject)).json()).toEqual({ size: 'large' });
  expect((await f.request('PATCH', '{"size":"medium"}', otherObject)).status).toBe(200);
  const otherTenant = await textSizeHttp('true', bob);
  expect(await (await otherTenant.request()).json()).toEqual({ size: 'large' });
  expect((await otherTenant.request('PATCH', '{"size":"large"}')).status).toBe(200);
  expect(await (await f.request()).json()).toEqual({ size: 'small' });
  expect(await (await f.request('GET', undefined, otherObject)).json()).toEqual({ size: 'medium' });

  expect((await f.app.request('/api/settings/text-size')).status).toBe(401);
  expect((await f.request('PATCH', '{"size":"large"}', 'invalid-token')).status).toBe(401);
  for (const body of [
    '{}',
    'null',
    '[]',
    '{',
    '{"size":"LARGE"}',
    '{"size":"EXTRA-SMALL"}',
    '{"size":"extra_small"}',
    '{"size":"x-small"}',
    '{"size":"default"}',
    '{"size":null}',
    '{"size":false}',
    '{"size":1}',
    '{"language":"en"}',
    '{"size":"large","theme":"dark"}',
    `{"size":"large","tenantId":"${bob}"}`,
    `{"size":"large","objectId":"${bob}"}`,
    '{"size":"large","extra":1}',
  ]) {
    expect((await f.request('PATCH', body)).status, body).toBe(400);
  }
  expect((await f.request('PATCH', '{"size":"large"}', undefined, 'text/plain')).status).toBe(400);
  const valid = '{"size":"small"}';
  const atLimit = valid + ' '.repeat(16384 - Buffer.byteLength(valid));
  expect((await f.request('PATCH', atLimit)).status).toBe(200);
  expect((await f.request('PATCH', atLimit + ' ')).status).toBe(413);
  expect((await f.request('PATCH', 'x'.repeat(16385))).status).toBe(413);
  expect(await (await f.request()).json()).toEqual({ size: 'small' });
  expect(await (await otherTenant.request()).json()).toEqual({ size: 'large' });
  expect(await (await f.request('GET', undefined, otherObject)).json()).toEqual({ size: 'medium' });

  const legacy = await fixture();
  const replies = await Promise.all([
    legacy.request('PATCH', '{"language":"en"}'),
    legacy.request('PATCH', '{"theme":"dark"}'),
    f.request('PATCH', '{"size":"medium"}'),
  ]);
  expect(replies.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(await (await legacy.request()).json()).toEqual({ language: 'en', theme: 'dark' });
  expect(await (await f.request()).json()).toEqual({ size: 'medium' });
  expect((await legacy.request('PATCH', '{"size":"small"}')).status).toBe(400);
});

/** @id TEST-FONT-002 @verifies REQ-FONT-002 */
it('TEST-FONT-002 gates absent/false flags, validates invalid flags and logs sanitized missing-008 failures', async () => {
  await provisionTextSizeStorage();
  const enabled = await textSizeHttp('true');
  const available = await enabled.request('PATCH', '{"size":"small"}');
  expect(available.status).toBe(200);
  expect(await available.json()).toEqual({ size: 'small' });
  expect(textSizeConfig()).toEqual(config);
  expect(textSizeConfig('false')).toEqual(textSizeConfig());
  for (const flag of [undefined, 'false']) {
    const disabled = await textSizeHttp(flag);
    for (const method of ['GET', 'PATCH']) {
      const response = await disabled.request(
        method,
        method === 'PATCH' ? '{"size":"medium"}' : undefined,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'TEXT_SIZE_UNAVAILABLE',
          message: expect.stringMatching(/unavailable/i),
          requestId: response.headers.get('X-Request-ID'),
        },
      });
    }
  }
  expect(await (await enabled.request()).json()).toEqual({ size: 'small' });
  for (const flag of ['', 'TRUE', '1', 'yes', ' false ']) {
    expect(() => textSizeConfig(flag), flag).toThrow(/TEXT_SIZE_ENABLED/);
  }
  const legacy = await fixture();
  expect((await legacy.request()).status).toBe(200);

  await db.pool.query('ALTER TABLE user_text_preferences RENAME TO fixture_text_size_saved');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const method of ['GET', 'PATCH']) {
      const response = await enabled.request(
        method,
        method === 'PATCH' ? '{"size":"large"}' : undefined,
      );
      expect(response.status).toBe(500);
      const requestId = response.headers.get('X-Request-ID');
      expect(requestId).toBeTruthy();
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: expect.any(String),
          requestId,
        },
      });
      expect(log).toHaveBeenCalled();
      const logged = log.mock.calls.flat().join(' ');
      expect(logged).toContain(requestId);
      for (const output of [body, logged]) {
        expect(output).not.toMatch(/SELECT|INSERT|relation|user_text_preferences|postgresql:/i);
        expect(output).not.toContain(config.tenantId);
        expect(output).not.toContain(alice);
      }
      log.mockClear();
    }
  } finally {
    log.mockRestore();
    await db.pool.query('ALTER TABLE fixture_text_size_saved RENAME TO user_text_preferences');
  }
  expect(await (await enabled.request()).json()).toEqual({ size: 'small' });
});
