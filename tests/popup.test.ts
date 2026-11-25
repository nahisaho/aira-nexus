import { expect, it } from 'vitest';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server/app.js';
import { ProjectRepository } from '../src/server/projects.js';
import { config } from './helpers/identity.js';

/** @id TEST-POP-001 @verifies REQ-POP-001 */
it('TEST-POP-001 relaxes only successful exact popup callbacks without changing other security controls', async () => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const application = () =>
    createApp({
      config,
      verifyToken: async () => ({ ok: false, status: 401, code: 'UNAUTHENTICATED' }),
      projects: new ProjectRepository(pool),
    });
  const app = application();
  app.get('/auth-redirect.html', serveStatic({ path: './public/auth-redirect.html' }));
  app.get('/', (c) => c.html('<!doctype html><title>Ordinary page</title>'));
  const otherPaths = [
    '/Auth-redirect.html',
    '/auth-redirect.html/',
    '/auth-redirect.html.extra',
    '/prefix/auth-redirect.html',
    '/auth%2Dredirect.html',
    '/%61uth-redirect.html',
    '/auth-redirect.html%2F',
  ];
  for (const path of otherPaths) app.get(path, (c) => c.html('<title>Not the callback</title>'));
  app.on(['POST', 'PUT', 'OPTIONS'], '/auth-redirect.html', (c) => c.text('Not a callback read'));
  const strict = 'same-origin-allow-popups';
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com; frame-src https://login.microsoftonline.com ${config.publicOrigin}/markdown-renderer.html; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  const unchangedHeaders = (response: Response) => {
    expect(response.headers.get('content-security-policy')).toBe(csp);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  };
  try {
    const callback = await readFile(
      new URL('../public/auth-redirect.html', import.meta.url),
      'utf8',
    );
    expect(callback).not.toMatch(/<script\b/i);
    expect(callback).toMatch(/<body>\s*<\/body>/);
    for (const path of ['/auth-redirect.html', '/auth-redirect.html?test=synthetic']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await app.request(path, { method });
        expect(response.status, `${method} ${path}`).toBe(200);
        expect(response.headers.get('cross-origin-opener-policy'), `${method} ${path}`).toBe(
          'unsafe-none',
        );
        expect(response.headers.get('content-type')).toContain('text/html');
        unchangedHeaders(response);
        expect(await response.text()).toBe(method === 'HEAD' ? '' : callback);
      }
    }
    for (const path of [...otherPaths, '/', '/api/config', '/?next=/auth-redirect.html']) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cross-origin-opener-policy'), path).toBe(strict);
      unchangedHeaders(response);
    }
    for (const method of ['POST', 'PUT', 'OPTIONS']) {
      const response = await app.request('/auth-redirect.html', { method });
      expect(response.status, method).toBe(200);
      expect(response.headers.get('cross-origin-opener-policy'), method).toBe(strict);
    }
    for (const path of ['/api/me', '/api/me?next=/auth-redirect.html']) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('cross-origin-opener-policy')).toBe(strict);
    }
    for (const method of ['GET', 'HEAD']) {
      const missing = await application().request('/auth-redirect.html', { method });
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cross-origin-opener-policy')).toBe(strict);
    }
    for (const status of [204, 302, 400, 500] as const) {
      const unsuccessful = application();
      unsuccessful.get('/auth-redirect.html', (c) => c.body(null, status));
      const response = await unsuccessful.request('/auth-redirect.html');
      expect(response.status).toBe(status);
      expect(response.headers.get('cross-origin-opener-policy')).toBe(strict);
    }
  } finally {
    await pool.end();
  }
});
