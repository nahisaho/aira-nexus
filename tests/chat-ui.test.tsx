// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectChat } from '../src/client/components/project-chat';
import { createChatApi } from '../src/client/chat-api';
import { ApiError } from '../src/client/api';
import { translate } from '../src/client/i18n';
import type { ChatEvent } from '../src/shared/chat';
import {
  chatFixture,
  delta,
  firstConversationId,
  model,
  preview,
  projectId,
  run,
  runId,
  secondConversationId,
  turn,
} from './helpers/chat';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderChat(options: Parameters<typeof chatFixture>[0] = {}) {
  const fixture = chatFixture(options);
  const onAuthenticationError = vi.fn();
  const view = render(
    <ProjectChat
      api={fixture.api}
      auth={fixture.auth}
      accountId={fixture.auth.account()?.id ?? 'alice'}
      projectId={projectId}
      scopeKey="alice-project-a"
      connectionEpoch={0}
      t={(text) => translate('ja', text)}
      onAuthenticationError={onAuthenticationError}
    />,
  );
  return { ...fixture, view, onAuthenticationError };
}

/** @id TEST-CHU-001 @verifies REQ-CHU-001 */
it('TEST-CHU-001 lists, creates and switches separate histories without cancelling another conversation', async () => {
  const user = userEvent.setup();
  const f = renderChat({
    turns: [turn('55555555-5555-4555-8555-555555555555', 1, 'user', 'First history')],
  });

  await screen.findByText('First history');
  await user.click(screen.getByRole('button', { name: '新しい会話' }));
  await screen.findByRole('button', { name: /77777777-7777-4777-8777-777777777777/ });
  expect(f.api.createConversation).toHaveBeenCalledWith(projectId, expect.any(AbortSignal));
  await user.click(screen.getByRole('button', { name: new RegExp(secondConversationId) }));
  await screen.findByText('Earlier answer');
  expect(f.api.cancelRun).not.toHaveBeenCalled();
  expect(f.api.getConversation).toHaveBeenCalledWith(
    projectId,
    secondConversationId,
    expect.any(AbortSignal),
  );
});

/** @id TEST-CHU-002 @verifies REQ-CHU-002 */
it('TEST-CHU-002 confirms account-only model discovery and each exact preview separately', async () => {
  const user = userEvent.setup();
  const f = renderChat();
  await screen.findByText('Earlier question');

  await user.click(screen.getByRole('button', { name: 'モデルを更新' }));
  expect(f.api.discoverModels).not.toHaveBeenCalled();
  const discovery = screen.getByRole('dialog', { name: /モデル一覧の取得/ });
  await user.click(within(discovery).getByRole('button', { name: 'モデル一覧を取得する' }));
  await screen.findByRole('option', { name: model.name });
  expect(f.api.discoverModels).toHaveBeenCalledTimes(1);

  await user.selectOptions(screen.getByRole('combobox', { name: 'モデル' }), model.id);
  await user.type(screen.getByRole('textbox', { name: 'メッセージ' }), 'exact user text');
  await user.click(screen.getByRole('button', { name: 'プレビュー' }));
  const confirmation = await screen.findByRole('dialog', { name: /送信内容の確認/ });
  expect(within(confirmation).getByText('exact preview prompt')).toBeTruthy();
  expect(within(confirmation).getByText(/upstream|外部/)).toBeTruthy();
  expect(f.api.createPreview).toHaveBeenCalledWith(
    projectId,
    firstConversationId,
    { text: 'exact user text', modelId: model.id },
    expect.any(AbortSignal),
  );
  expect(f.api.confirmPreview).not.toHaveBeenCalled();

  vi.mocked(f.api.confirmPreview).mockRejectedValueOnce(new Error('response lost'));
  await user.click(within(confirmation).getByRole('button', { name: '送信を確認' }));
  const recover = await within(confirmation).findByRole('button', { name: '同じ送信を回復' });
  await user.click(recover);
  await waitFor(() => expect(f.api.confirmPreview).toHaveBeenCalledTimes(2));
  const firstCall = vi.mocked(f.api.confirmPreview).mock.calls[0]!;
  const secondCall = vi.mocked(f.api.confirmPreview).mock.calls[1]!;
  const [sentProject, sentConversation, body, key, signal] = firstCall;
  expect(sentProject).toBe(projectId);
  expect(sentConversation).toBe(firstConversationId);
  expect(body).toEqual({
    previewId: preview.previewId,
    snapshotHash: preview.snapshotHash,
    confirmed: true,
  });
  expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(secondCall.slice(0, 4)).toEqual(firstCall.slice(0, 4));
  await waitFor(() => expect(f.api.listTurns).toHaveBeenCalledTimes(2));

  let resolvePreview: (value: typeof preview) => void = () => {
    throw new Error('Preview request was not started.');
  };
  vi.mocked(f.api.createPreview).mockImplementationOnce(
    () => new Promise((resolve) => (resolvePreview = resolve)),
  );
  await user.type(screen.getByRole('textbox', { name: 'メッセージ' }), 'next question');
  await user.click(screen.getByRole('button', { name: 'プレビュー' }));
  await waitFor(() => expect(f.api.createPreview).toHaveBeenCalledTimes(2));
  const pendingSignal = vi.mocked(f.api.createPreview).mock.calls[1]![3];
  await user.click(screen.getByRole('button', { name: new RegExp(secondConversationId) }));
  await screen.findByText('Earlier answer');
  expect(pendingSignal.aborted).toBe(true);
  await act(async () => resolvePreview(preview));
  expect(screen.queryByRole('dialog', { name: /送信内容の確認/ })).toBeNull();

  const fetcher = vi.fn(async () =>
    Response.json({ models: [model], expiresAt: '2026-11-21T00:05:00.000Z' }),
  );
  vi.stubGlobal('fetch', fetcher);
  const http = createChatApi(f.auth);
  await expect(http.discoverModels(projectId, new AbortController().signal)).resolves.toEqual([
    model,
  ]);
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/projects/${projectId}/chat/models`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic' }),
    }),
  );
  fetcher.mockResolvedValueOnce(
    Response.json({ models: [{ ...model, extra: true }], expiresAt: '2026-11-21T00:05:00.000Z' }),
  );
  await expect(http.discoverModels(projectId, new AbortController().signal)).rejects.toThrow();
  fetcher.mockResolvedValueOnce(Response.json(run({ state: 'queued' })));
  await http.confirmPreview(
    projectId,
    firstConversationId,
    { previewId: preview.previewId, snapshotHash: preview.snapshotHash, confirmed: true },
    key,
    new AbortController().signal,
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/projects/${projectId}/chat/conversations/${firstConversationId}/runs`,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        previewId: preview.previewId,
        snapshotHash: preview.snapshotHash,
        confirmed: true,
      }),
      headers: expect.objectContaining({ 'Idempotency-Key': key }),
    }),
  );
});

/** @id TEST-CHU-003 @verifies REQ-CHU-003 */
it('TEST-CHU-003 replays only contiguous events after the canonical snapshot and keeps partial output while cancellation is pending', async () => {
  const user = userEvent.setup();
  const f = renderChat({ activeRun: run({ answer: 'A', lastSequence: 1, state: 'running' }) });
  await screen.findByText('A');
  await waitFor(() => expect(f.api.subscribe).toHaveBeenCalledTimes(1));
  const subscribe = vi.mocked(f.api.subscribe).mock.calls[0]!;
  expect(subscribe[2]).toBe(1);
  subscribe[3](delta(2, 'B'));
  subscribe[3](delta(2, 'B'));
  await screen.findByText('AB');
  subscribe[3](delta(4, 'gap'));
  await screen.findByText(/イベントの順序を確認できません/);
  vi.mocked(f.api.cancelRun).mockResolvedValueOnce(
    run({ answer: 'AB', lastSequence: 2, state: 'cancel_requested' }),
  );
  await user.click(screen.getByRole('button', { name: '生成をキャンセル' }));
  await screen.findByText(/キャンセルを確認しています/);
  expect(f.api.cancelRun).toHaveBeenCalledWith(projectId, runId, expect.any(AbortSignal));
  expect(screen.getByText('AB')).toBeTruthy();

  const fetcher = vi.fn(
    async () =>
      new Response(
        [
          `id: 2\ndata: ${JSON.stringify({ id: `${runId}:2`, runId, sequence: 2, type: 'delta', text: 'B' })}\n\n`,
          `id: 3\ndata: ${JSON.stringify({ id: `${runId}:3`, runId, sequence: 3, type: 'status', state: 'succeeded' })}\n\n`,
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const http = createChatApi(f.auth);
  const received: ChatEvent[] = [];
  await http.subscribe(
    projectId,
    runId,
    1,
    (event) => received.push(event),
    new AbortController().signal,
  );
  expect(received.map((event) => event.sequence)).toEqual([2, 3]);
  expect(received[1]?.state).toBe('succeeded');
  fetcher.mockResolvedValueOnce(
    new Response(
      `data: ${JSON.stringify({ id: `${runId}:4`, runId, sequence: 4, type: 'delta', text: 'gap' })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  await expect(
    http.subscribe(projectId, runId, 1, () => {}, new AbortController().signal),
  ).rejects.toThrow('sequence has a gap');
  fetcher.mockResolvedValueOnce(
    new Response(
      `data: ${JSON.stringify({ id: `${runId}:99`, runId, sequence: 2, type: 'status', state: 'succeeded' })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  await expect(
    http.subscribe(projectId, runId, 1, () => {}, new AbortController().signal),
  ).rejects.toThrow('ID does not match its sequence');
});

/** @id TEST-CHU-004 @verifies REQ-CHU-004 */
it('TEST-CHU-004 fences late owner/project results, reports 401, and renders provider text inertly', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const f = renderChat({
    activeRun: run({ state: 'succeeded', answer: payload, lastSequence: 1 }),
  });
  const view = f.view;
  await screen.findByText(payload);
  expect(document.querySelector('img')).toBeNull();
  expect(Object.keys(localStorage)).toEqual([]);

  vi.mocked(f.api.getRun).mockResolvedValueOnce(
    run({ state: 'succeeded', answer: 'fresh', lastSequence: 1 }),
  );
  view.rerender(
    <ProjectChat
      api={f.api}
      auth={f.auth}
      accountId="alice"
      projectId={projectId}
      scopeKey="alice-project-a"
      connectionEpoch={1}
      t={(text) => translate('ja', text)}
      onAuthenticationError={f.onAuthenticationError}
    />,
  );
  expect(screen.queryByText(payload)).toBeNull();
  await screen.findByText('fresh');

  f.switchAccount('bob');
  vi.mocked(f.api.listConversations).mockRejectedValueOnce(new ApiError(401, 'expired'));
  view.rerender(
    <ProjectChat
      api={f.api}
      auth={f.auth}
      accountId="bob"
      projectId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      scopeKey="bob-project-b"
      connectionEpoch={2}
      t={(text) => translate('ja', text)}
      onAuthenticationError={f.onAuthenticationError}
    />,
  );
  expect(screen.queryByText('fresh')).toBeNull();
  await waitFor(() =>
    expect(f.onAuthenticationError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 })),
  );
});
