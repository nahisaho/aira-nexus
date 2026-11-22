// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import { ApiError } from '../src/client/api';
import type { BrowserAuth, UserAccount } from '../src/client/auth';
import type { ProjectsApi } from '../src/client/api';
import type { PreferencesApi } from '../src/client/preferences-api';
import { createTextSizeApi } from '../src/client/preferences-api';
import type { UserPreferences } from '../src/shared/preferences';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(initial: UserPreferences = { language: 'ja', theme: 'light' }) {
  let saved = { ...initial };
  let account: UserAccount | null = { id: 'alice', name: '研究者A' };
  let notify = () => {};
  const auth: BrowserAuth = {
    account: () => account,
    signIn: vi.fn(),
    signOut: vi.fn(),
    invalidate: vi.fn(() => {
      account = null;
    }),
    accessToken: vi.fn(async () => 'synthetic-token'),
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const api: ProjectsApi = {
    list: vi.fn(async () => [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: '日本語の研究',
        version: 1,
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
    ]),
    create: vi.fn(),
    rename: vi.fn(),
  };
  const preferencesApi: PreferencesApi = {
    get: vi.fn(async () => ({ ...saved })),
    patch: vi.fn(async (changes) => {
      saved = { ...saved, ...changes };
      return { ...saved };
    }),
  };
  const fetcher = vi.fn(async () =>
    Response.json({ configured: false, status: 'disconnected', attempt: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  return {
    auth,
    api,
    preferencesApi,
    fetcher,
    switchAccount: () => {
      account = { id: 'bob', name: 'B' };
      notify();
    },
    changeAccount: (next: UserAccount | null) => {
      account = next;
      notify();
    },
  };
}
/** @id TEST-PREF-003 @verifies REQ-PREF-003 */
it('TEST-PREF-003 localizes all panes/errors, themes the modal, preserves names and reloads saved preferences', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const view = render(<App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} />);
  await screen.findByText('日本語の研究', { selector: 'h1' });
  await user.click(screen.getByRole('button', { name: '設定' }));
  expect(screen.getByRole('combobox', { name: '言語' })).toHaveValue('ja');
  await user.selectOptions(screen.getByRole('combobox', { name: '言語' }), 'en');
  expect(await screen.findByRole('dialog', { name: 'User settings' })).toBeVisible();
  expect(document.documentElement.lang).toBe('en');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), 'dark');
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.api.list).toHaveBeenCalledTimes(1);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('region', { name: 'Project management' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Research workspace' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'File explorer' })).toBeVisible();
  expect(screen.getByText('日本語の研究', { selector: 'h1' })).toBeVisible();
  vi.mocked(f.api.create).mockRejectedValueOnce(
    new ApiError(409, '競合しました。再読み込みしてから変更してください。 受付番号: request-123'),
  );
  await user.click(screen.getByRole('button', { name: 'New project' }));
  await user.type(screen.getByRole('textbox', { name: 'New project name' }), 'New');
  await user.click(screen.getByRole('button', { name: 'Create project' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('request-123');
  expect(screen.getByRole('alert')).toHaveTextContent('Conflict');
  view.unmount();
  render(<App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} />);
  await screen.findByRole('button', { name: 'Settings' });
  expect(document.documentElement.dataset.theme).toBe('dark');
});
/** @id TEST-PREF-004 @verifies REQ-PREF-004 */
it('TEST-PREF-004 reports load/save failures and discards an aborted previous-owner save', async () => {
  const f = fixture();
  const user = userEvent.setup();
  vi.mocked(f.preferencesApi.get).mockRejectedValueOnce(new Error('synthetic unavailable'));
  render(<App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} />);
  await screen.findByText('日本語の研究', { selector: 'h1' });
  await user.click(screen.getByRole('button', { name: '設定' }));
  expect(await screen.findByText('設定を取得できませんでした。再試行してください。')).toBeVisible();
  expect(screen.getByRole('combobox', { name: '言語' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '設定を再読み込み' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: '言語' })).toBeEnabled());
  vi.mocked(f.preferencesApi.patch).mockRejectedValueOnce(new Error('synthetic unavailable'));
  await user.selectOptions(screen.getByRole('combobox', { name: '言語' }), 'en');
  expect(await screen.findByText('設定を保存できませんでした。再試行してください。')).toBeVisible();
  expect(document.documentElement.lang).toBe('ja');
  let finish!: (value: UserPreferences) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(f.preferencesApi.patch).mockImplementationOnce((_changes, active) => {
    signal = active;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await user.selectOptions(screen.getByRole('combobox', { name: '言語' }), 'en');
  await waitFor(() => expect(f.preferencesApi.patch).toHaveBeenCalledTimes(2));
  await act(async () => f.switchAccount());
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ language: 'en', theme: 'dark' }));
  expect(document.documentElement.lang).toBe('ja');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
/** @id TEST-PREF-005 @verifies REQ-PREF-005 */
it('TEST-PREF-005 always exposes a disabled GitHub authentication button with a translated reason', async () => {
  const f = fixture({ language: 'en', theme: 'light' });
  const user = userEvent.setup();
  render(<App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} />);
  const settings = await screen.findByRole('button', { name: 'Settings' });
  await user.click(settings);
  expect(await screen.findByRole('button', { name: 'Authenticate with GitHub' })).toBeDisabled();
  expect(
    screen.getByText('An administrator has not configured GitHub authentication.'),
  ).toBeVisible();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

function textSizeFixture() {
  const f = fixture({ language: 'en', theme: 'light' });
  const reads: Array<() => Promise<Response>> = [];
  const writes: Array<() => Promise<Response>> = [];
  const requests: Array<{
    method: string;
    body: string;
    owner: string | undefined;
    signal: AbortSignal | null | undefined;
    authorization: string | null;
  }> = [];
  vi.mocked(f.auth.accessToken).mockImplementation(
    async () => `test-token-${f.auth.account()?.id}`,
  );
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      .pathname;
    if (path !== '/api/settings/text-size') return f.fetcher();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push({
      method,
      body: String(init?.body ?? ''),
      owner: f.auth.account()?.id,
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    const reply = (method === 'PATCH' ? writes : reads).shift();
    return reply ? reply() : Response.json({ size: 'large' });
  });
  vi.stubGlobal('fetch', fetcher);
  return { ...f, reads, writes, requests, textSizeApi: createTextSizeApi(f.auth) };
}

function pendingTextResponse(queue: Array<() => Promise<Response>>) {
  let finish!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  queue.push(() => promise);
  return finish;
}

const textSizeControl = () =>
  screen.getByRole<HTMLSelectElement>('combobox', {
    name: /text size|文字(?:の)?(?:サイズ|大きさ)/i,
  });
const textSizeRetry = () => screen.getByRole('button', { name: /retry|reload|再試行|再読み込み/i });
const textFailure = (status = 500, code = 'INTERNAL_ERROR') =>
  Response.json(
    { error: { code, message: 'Synthetic text-size failure.', requestId: 'font-request-123' } },
    { status, headers: { 'X-Request-ID': 'font-request-123' } },
  );

/** @id TEST-FONT-003 @verifies REQ-FONT-003 */
it('TEST-FONT-003 offers four accessible sizes and applies only server acknowledgements to App and its settings portal', async () => {
  const f = textSizeFixture();
  const user = userEvent.setup();
  const browserWrites = [
    vi.spyOn(Storage.prototype, 'setItem'),
    vi.spyOn(Storage.prototype, 'removeItem'),
  ];
  render(
    <App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} textSizeApi={f.textSizeApi} />,
  );
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  const control = textSizeControl();
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveValue('large');
  for (const name of ['Large', 'Medium', 'Small', 'Extra small']) {
    expect(within(control).queryByRole('option', { name })).toBeInTheDocument();
  }
  const root = document.documentElement;
  expect(root.dataset.textSize).toBe('large');
  const dialog = screen.getByRole('dialog', { name: 'User settings' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  const workspace = () =>
    screen
      .getAllByRole('region', { hidden: true })
      .find((element) => element.getAttribute('aria-label') === 'Research workspace') ?? null;
  const region = workspace();
  expect(root).toContainElement(dialog);
  expect(root).toContainElement(region);
  const previousRegion = region;
  const originalStyle = root.getAttribute('style');
  const finish = pendingTextResponse(f.writes);
  await user.selectOptions(control, 'extra-small');
  await waitFor(() => expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1));
  expect(control).toBeDisabled();
  expect(control).toHaveValue('large');
  expect(root.dataset.textSize).toBe('large');
  expect(JSON.parse(f.requests.at(-1)?.body ?? '{}')).toEqual({ size: 'extra-small' });
  expect(f.requests.at(-1)?.authorization).toBe('Bearer test-token-alice');
  await act(async () => finish(Response.json({ size: 'medium' })));
  await waitFor(() => expect(control).toHaveValue('medium'));
  expect(root.dataset.textSize).toBe('medium');
  expect(workspace()).toBe(previousRegion);
  expect(screen.getByRole('dialog', { name: 'User settings' })).toBe(dialog);
  expect(root.getAttribute('style')).toBe(originalStyle);
  expect(screen.getByText('日本語の研究', { selector: 'h1' })).toBeVisible();
  for (const size of ['extra-small', 'small', 'large']) {
    f.writes.push(async () => Response.json({ size }));
    await user.selectOptions(control, size);
    await waitFor(() => expect(root.dataset.textSize).toBe(size));
    expect(control).toHaveValue(size);
  }
  expect(f.api.list).toHaveBeenCalledTimes(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  for (const spy of browserWrites) expect(spy).not.toHaveBeenCalled();
});

/** @id TEST-FONT-004 @verifies REQ-FONT-004 */
it('TEST-FONT-004 retries failed reads/writes, resets current 401 and fences stale same-turn epoch outcomes', async () => {
  const f = textSizeFixture();
  const user = userEvent.setup();
  const browserWrites = vi.spyOn(Storage.prototype, 'setItem');
  const initialRead = pendingTextResponse(f.reads);
  render(
    <App auth={f.auth} api={f.api} preferencesApi={f.preferencesApi} textSizeApi={f.textSizeApi} />,
  );
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  expect(textSizeControl()).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeVisible();
  expect(document.documentElement.dataset.textSize).toBe('large');
  await act(async () => initialRead(Response.json({ size: 'small' })));
  await waitFor(() => expect(textSizeControl()).toBeEnabled());
  expect(document.documentElement.dataset.textSize).toBe('small');

  const failedWrite = pendingTextResponse(f.writes);
  await user.selectOptions(textSizeControl(), 'extra-small');
  await waitFor(() => expect(textSizeControl()).toBeDisabled());
  expect(document.documentElement.dataset.textSize).toBe('small');
  await act(async () => failedWrite(textFailure()));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(document.documentElement.dataset.textSize).toBe('small');
  expect(textSizeControl()).toHaveValue('small');
  expect(textSizeRetry()).toBeEnabled();
  // A retry may reload before permitting a resubmission, or resubmit the failed write.
  f.reads.push(async () => Response.json({ size: 'small' }));
  f.writes.push(async () => Response.json({ size: 'extra-small' }));
  await user.click(textSizeRetry());
  await waitFor(() => expect(textSizeControl()).toBeEnabled());
  if (textSizeControl().value !== 'extra-small')
    await user.selectOptions(textSizeControl(), 'extra-small');
  await waitFor(() => expect(document.documentElement.dataset.textSize).toBe('extra-small'));
  expect(f.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body))).toEqual([
    { size: 'extra-small' },
    { size: 'extra-small' },
  ]);
  f.reads.length = 0;

  f.reads.push(async () => textFailure());
  await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
  expect(document.documentElement.dataset.textSize).toBe('large');
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(textSizeControl()).toBeDisabled();
  expect(screen.getByText(/unsaved|未保存/i)).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeVisible();
  f.reads.push(async () => Response.json({ size: 'small' }));
  await user.click(textSizeRetry());
  await waitFor(() => expect(textSizeControl()).toBeEnabled());
  expect(document.documentElement.dataset.textSize).toBe('small');

  for (const outcome of [
    () => Response.json({ size: 'medium' }),
    () => textFailure(),
    () => textFailure(401, 'UNAUTHENTICATED'),
  ]) {
    const staleWrite = pendingTextResponse(f.writes);
    await user.selectOptions(textSizeControl(), 'medium');
    await waitFor(() => expect(textSizeControl()).toBeDisabled());
    const request = f.requests.at(-1);
    expect(request?.method).toBe('PATCH');
    const nextRead = pendingTextResponse(f.reads);
    // Resolve in the account-notification turn, before React's effect cleanup.
    await act(async () => {
      f.changeAccount({ id: 'bob', name: 'B' });
      staleWrite(outcome());
    });
    expect(request?.signal?.aborted).toBe(true);
    expect(document.documentElement.dataset.textSize).toBe('large');
    expect(f.auth.invalidate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => nextRead(Response.json({ size: 'small' })));
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(textSizeControl()).toHaveValue('small'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  }

  for (const outcome of [
    () => Response.json({ size: 'medium' }),
    () => textFailure(),
    () => textFailure(401, 'UNAUTHENTICATED'),
  ]) {
    const staleRead = pendingTextResponse(f.reads);
    await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
    await waitFor(() => expect(f.requests.at(-1)?.owner).toBe('alice'));
    const request = f.requests.at(-1);
    expect(request?.method).toBe('GET');
    const nextRead = pendingTextResponse(f.reads);
    await act(async () => {
      f.changeAccount({ id: 'bob', name: 'B' });
      staleRead(outcome());
    });
    expect(request?.signal?.aborted).toBe(true);
    expect(f.auth.invalidate).not.toHaveBeenCalled();
    await act(async () => nextRead(Response.json({ size: 'small' })));
    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe('small'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  }

  const unavailable = pendingTextResponse(f.reads);
  await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
  await act(async () => unavailable(textFailure(503, 'TEXT_SIZE_UNAVAILABLE')));
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  expect(textSizeControl()).toBeDisabled();
  expect(
    screen.getByText(/text.*unavailable|unavailable.*text|文字.*利用できません/i),
  ).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Authenticate with GitHub' })).toBeVisible();

  const currentUnauthorized = pendingTextResponse(f.reads);
  await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
  await act(async () => currentUnauthorized(textFailure(401, 'UNAUTHENTICATED')));
  expect(await screen.findByRole('button', { name: /sign in|サインイン/i })).toBeVisible();
  expect(f.auth.invalidate).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.textSize).toBe('large');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  f.reads.push(async () => Response.json({ size: 'small' }));
  await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await waitFor(() => expect(textSizeControl()).toBeEnabled());
  const unauthorizedWrite = pendingTextResponse(f.writes);
  await user.selectOptions(textSizeControl(), 'medium');
  await waitFor(() => expect(textSizeControl()).toBeDisabled());
  await act(async () => unauthorizedWrite(textFailure(401, 'UNAUTHENTICATED')));
  expect(await screen.findByRole('button', { name: /sign in|サインイン/i })).toBeVisible();
  expect(f.auth.invalidate).toHaveBeenCalledTimes(2);
  expect(document.documentElement.dataset.textSize).toBe('large');

  f.reads.push(async () => Response.json({ size: 'small' }));
  await act(async () => f.changeAccount({ id: 'alice', name: '研究者A' }));
  await waitFor(() => expect(document.documentElement.dataset.textSize).toBe('small'));
  await act(async () => f.changeAccount(null));
  expect(document.documentElement.dataset.textSize).toBe('large');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sign in|サインイン/i })).toBeVisible();
  expect(browserWrites).not.toHaveBeenCalled();
});
