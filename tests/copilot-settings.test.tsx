// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import type { BrowserAuth, UserAccount } from '../src/client/auth';
import type { ProjectsApi } from '../src/client/api';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});
/** @id TEST-CON-001 @verifies REQ-CON-001 */
it('TEST-CON-001 opens accessible bottom-left settings, starts device auth and discards closed/old-user responses', async () => {
  const user = userEvent.setup();
  let account: UserAccount | null = { id: 'alice', name: 'Researcher A' };
  let notify = () => {};
  const auth: BrowserAuth = {
    account: () => account,
    signIn: vi.fn(async () => ({ id: 'alice', name: 'A' })),
    signOut: vi.fn(async () => {
      account = null;
    }),
    accessToken: vi.fn(async () => 'synthetic-entra-token'),
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const api: ProjectsApi = { list: vi.fn(async () => []), create: vi.fn(), rename: vi.fn() };
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(
    Response.json({ configured: true, status: 'disconnected', attempt: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<App auth={auth} api={api} />);
  await screen.findByText('プロジェクトはまだありません。');
  expect(screen.queryByRole('button', { name: '設定' })).not.toBeNull();
  const trigger = screen.getByRole('button', { name: '設定' });
  expect(screen.getByRole('region', { name: 'プロジェクト管理' })).toContainElement(trigger);
  await user.click(trigger);
  expect(await screen.findByRole('dialog', { name: 'ユーザー設定' })).toBeVisible();
  await screen.findByText('未接続');
  let finish!: (response: Response) => void;
  let pendingSignal: AbortSignal | undefined;
  fetcher.mockImplementationOnce(async (_path, options) => {
    pendingSignal = options?.signal ?? undefined;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await user.click(screen.getByRole('button', { name: 'GitHub に接続' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(pendingSignal?.aborted).toBe(true);
  expect(trigger).toHaveFocus();
  await act(async () => {
    finish(
      Response.json({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'pending',
        userCode: 'OLD-CODE',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        nextPollAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
  });
  fetcher.mockResolvedValueOnce(
    Response.json({ configured: true, status: 'disconnected', attempt: null }),
  );
  await user.click(trigger);
  await screen.findByText('未接続');
  expect(screen.queryByText('OLD-CODE')).not.toBeInTheDocument();
  let finishSecondStart!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSecondStart = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'GitHub に接続' }));
  vi.useFakeTimers();
  await act(async () => {
    finishSecondStart(
      Response.json({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'pending',
        userCode: 'TEST-CODE',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        nextPollAt: new Date(Date.now() + 5000).toISOString(),
      }),
    );
  });
  expect(screen.getByText('TEST-CODE')).toBeVisible();
  expect(screen.getByRole('link', { name: 'GitHub で認証する' })).toHaveAttribute(
    'href',
    'https://github.com/login/device',
  );
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('device_code');
  fetcher.mockResolvedValueOnce(
    Response.json({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'approved',
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      nextPollAt: new Date(Date.now() + 5000).toISOString(),
    }),
  );
  fetcher.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByText('TEST-CODE')).not.toBeInTheDocument();
  const callsAfterApproval = fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(fetcher).toHaveBeenCalledTimes(callsAfterApproval);
  vi.useRealTimers();
  await user.keyboard('{Escape}');
  let finishStatus!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStatus = resolve;
      }),
  );
  await user.click(trigger);
  vi.useFakeTimers();
  await act(async () => {
    finishStatus(
      Response.json({
        configured: true,
        status: 'disconnected',
        attempt: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          state: 'pending',
          userCode: 'TEST-CODE',
          verificationUri: 'https://github.com/login/device',
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          nextPollAt: new Date(Date.now() + 5000).toISOString(),
        },
      }),
    );
  });
  expect(screen.getByText('TEST-CODE')).toBeVisible();
  let finishOldPoll!: (response: Response) => void;
  let pollSignal: AbortSignal | undefined;
  fetcher.mockImplementationOnce((_path, options) => {
    pollSignal = options?.signal ?? undefined;
    return new Promise((resolve) => {
      finishOldPoll = resolve;
    });
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(pollSignal?.aborted).toBe(false);
  await act(async () => {
    account = { id: 'bob', name: 'Researcher B' };
    notify();
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('TEST-CODE')).not.toBeInTheDocument();
  expect(pollSignal?.aborted).toBe(true);
  const callsAfterSwitch = fetcher.mock.calls.length;
  await act(async () => {
    finishOldPoll(
      Response.json({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'approved',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        nextPollAt: new Date(Date.now() + 5000).toISOString(),
      }),
    );
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(fetcher).toHaveBeenCalledTimes(callsAfterSwitch);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
