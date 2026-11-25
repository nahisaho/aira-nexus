import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserAuth } from '../src/client/auth';
import { createProjectPinsApi, ProjectPinsUnavailable } from '../src/client/project-pins-api';
import { ApiError } from '../src/client/api';

afterEach(() => vi.unstubAllGlobals());
/** @id TEST-SID-003 @verifies REQ-SID-003 */
it('TEST-SID-003 validates pin replies, preserves authorization and rejects unsafe paths or stale body reads', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let account = { id: 'alice', name: 'Synthetic owner' };
  const auth: BrowserAuth = {
    account: () => account,
    accessToken: async () => 'synthetic-unit-token',
    signIn: async () => account,
    signOut: async () => {},
  };
  const fetcher = vi.fn(async () => Response.json({ projectIds: [id] }));
  vi.stubGlobal('fetch', fetcher);
  const api = createProjectPinsApi(auth);
  await expect(api.list()).resolves.toEqual([id]);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/project-pins',
    expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-unit-token' }),
    }),
  );
  for (const pinned of [true, false]) {
    await expect(api.set(id, pinned)).resolves.toEqual([id]);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/projects/${id}/pin`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ pinned }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  }
  await expect(api.set('../other', true)).rejects.toBeInstanceOf(ApiError);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const body of [
    { projectIds: [id, id] },
    { projectIds: ['invalid'] },
    { projectIds: [], extra: true },
    {},
  ]) {
    fetcher.mockResolvedValueOnce(Response.json(body));
    await expect(api.list()).rejects.toMatchObject({ status: 502 });
  }
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'PROJECT_PINS_UNAVAILABLE' } }, { status: 503 }),
  );
  await expect(api.list()).rejects.toBeInstanceOf(ProjectPinsUnavailable);
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'IDENTITY_UNAVAILABLE' } }, { status: 503 }),
  );
  await expect(api.list()).rejects.not.toBeInstanceOf(ProjectPinsUnavailable);
  for (const status of [401, 403, 503]) {
    fetcher.mockResolvedValueOnce(new Response(null, { status }));
    await expect(api.list()).rejects.toMatchObject({ status });
  }
  fetcher.mockResolvedValueOnce(new Response('not JSON'));
  await expect(api.list()).rejects.toMatchObject({ status: 502 });
  let completeBody: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      completeBody = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ projectIds: [id] })));
        controller.close();
      };
    },
  });
  let fetched: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const delayedResponse = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  const readBody = delayedResponse.json.bind(delayedResponse);
  vi.spyOn(delayedResponse, 'json').mockImplementation(() => {
    fetched!();
    return readBody();
  });
  fetcher.mockResolvedValueOnce(delayedResponse);
  const pending = api.list();
  const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
  await received;
  account = { id: 'bob', name: 'Another synthetic owner' };
  completeBody!();
  await rejected;
});
