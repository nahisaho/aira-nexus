// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserAuth } from '../src/client/auth';
import { createProjectOrderApi } from '../src/client/project-order-api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** @id TEST-SID-010 @verifies REQ-SID-008 REQ-SID-009 */
it('TEST-SID-010 validates entire acknowledged order and capability, preserves CAS and fences late body parsing', async () => {
  let account = { id: 'alice', name: 'Owner' };
  const auth: BrowserAuth = {
    account: () => account,
    signIn: async () => account,
    signOut: async () => {},
    accessToken: async () => 'unit-only',
  };
  const api = createProjectOrderApi(auth);
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const snapshot = { version: 4, pinned: [a], recent: [b] };
  const fetcher = vi.fn(async () => Response.json({ enabled: true }));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.capabilities()).resolves.toBe(true);
  fetcher.mockImplementation(async () => Response.json(snapshot));
  await expect(api.get()).resolves.toEqual(snapshot);
  await expect(api.move(3, { group: 'recent', projectId: b, beforeId: null })).resolves.toEqual(
    snapshot,
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/project-order',
    expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({ 'If-Match': '"3"' }),
      body: JSON.stringify({ group: 'recent', projectId: b, beforeId: null }),
    }),
  );
  for (const body of [
    { ...snapshot, unknown: true },
    { ...snapshot, pinned: [a, a] },
    { ...snapshot, pinned: [a, a.toUpperCase()] },
    { ...snapshot, pinned: [a.toUpperCase()], recent: [a] },
    { ...snapshot, recent: [a] },
    { ...snapshot, version: 2147483648 },
    { ...snapshot, recent: ['invalid'] },
    { version: 1, pinned: [] },
  ]) {
    fetcher.mockImplementation(async () => Response.json(body));
    await expect(api.get()).rejects.toMatchObject({ status: 502 });
  }
  fetcher.mockImplementation(async () => Response.json({ enabled: false, extra: true }));
  await expect(api.capabilities()).rejects.toMatchObject({ status: 502 });
  fetcher.mockImplementation(async () =>
    Response.json({ error: { code: 'PROJECT_ORDER_UNAVAILABLE' } }, { status: 503 }),
  );
  await expect(api.get()).rejects.toMatchObject({ name: 'ProjectOrderUnavailable' });
  fetcher.mockImplementation(async () =>
    Response.json({ error: { code: 'OTHER_UNAVAILABLE' } }, { status: 503 }),
  );
  await expect(api.get()).rejects.toMatchObject({ name: 'ApiError', status: 503 });
  let finish: ((value: unknown) => void) | undefined;
  fetcher.mockImplementation(async () => {
    const response = Response.json(snapshot);
    response.json = () => new Promise((resolve) => (finish = resolve));
    return response;
  });
  const late = api.get();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  account = { id: 'bob', name: 'Other owner' };
  finish!(snapshot);
  await expect(late).rejects.toMatchObject({ status: 401 });
});
