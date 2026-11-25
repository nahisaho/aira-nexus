// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversionJobs } from '../src/client/components/conversion-jobs';
import type { ConversionJobsProps } from '../src/client/components/conversion-jobs';
import type { ConversionsApi } from '../src/client/conversions-api';
import { createConversionsApi } from '../src/client/conversions-api';
import type { ConversionPage, ConversionRequest } from '../src/shared/conversions';
import { ApiError } from '../src/client/api';
import type { BrowserAuth } from '../src/client/auth';
import { WorkspaceTabs } from '../src/client/components/workspace-tabs';
import type { WorkspaceTabsHandle } from '../src/client/components/workspace-tabs';
import { ProjectFiles } from '../src/client/components/project-files';
import type { FilesApi } from '../src/client/files-api';
import type { ProjectFile } from '../src/shared/files';

const projectId = '12345678-1234-4234-8234-123456789012';
const row: ConversionRequest = {
  id: '12345678-1234-4234-8234-123456789013',
  projectId,
  sourceId: '12345678-1234-4234-8234-123456789014',
  sourceName: 'synthetic.pdf',
  jobId: null,
  state: 'waiting',
  reason: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  artifacts: null,
};
function fixture(override: Partial<ConversionsApi> = {}) {
  const api: ConversionsApi = {
    capabilities: vi.fn(async () => ({ enabled: true })),
    list: vi.fn(async () => ({ items: [row], nextCursor: null })),
    request: vi.fn(async () => row),
    cancel: vi.fn(async (): Promise<ConversionRequest> => ({ ...row, state: 'cancelled' })),
    ...override,
  };
  const props: ConversionJobsProps = {
    api,
    projectId,
    scopeKey: 'owner:project',
    captureSession: () => () => true,
    onAuthenticationError: vi.fn(),
    onOpen: vi.fn(),
    t: (text) => text,
  };
  return { api, props };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** @id TEST-CJU-001 @verifies REQ-CJU-001 */
it('TEST-CJU-001 shows acknowledged project jobs without opening a file or navigating on upload', async () => {
  const { props } = fixture();
  render(<ConversionJobs {...props} />);
  await waitFor(() => expect(screen.queryByText('synthetic.pdf')).toBeVisible());
  expect(props.onOpen).not.toHaveBeenCalled();
});

/** @id TEST-CJU-002 @verifies REQ-CJU-002 */
it('TEST-CJU-002 waits for acknowledged cancellation and prevents duplicate writes', async () => {
  let resolve!: (value: ConversionRequest) => void;
  const { api, props } = fixture({
    cancel: vi.fn(
      () =>
        new Promise<ConversionRequest>((done) => {
          resolve = done;
        }),
    ),
  });
  render(<ConversionJobs {...props} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeVisible());
  const button = screen.getByRole('button', { name: 'キャンセル' });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.queryByText('キャンセル済み')).not.toBeInTheDocument();
  resolve({ ...row, state: 'cancelled' });
  expect(await screen.findByText('キャンセル済み')).toBeVisible();
  expect(api.cancel).toHaveBeenCalledTimes(1);
});

/** @id TEST-CJU-003 @verifies REQ-CJU-003 */
it('TEST-CJU-003 reports unavailable conversion without issuing a conversion request', async () => {
  const { api, props } = fixture({ capabilities: vi.fn(async () => ({ enabled: false })) });
  render(<ConversionJobs {...props} />);
  await waitFor(() =>
    expect(screen.queryByRole('alert')).toHaveTextContent('文書変換は現在利用できません。'),
  );
  expect(api.request).not.toHaveBeenCalled();
});

/** @id TEST-CJU-004 @verifies REQ-CJU-004 */
it('TEST-CJU-004 discards an old-scope401 and stops polling after unmount', async () => {
  let reject!: (cause: unknown) => void;
  let current = true;
  const { api, props } = fixture({
    list: vi.fn(
      () =>
        new Promise<ConversionPage>((_resolve, fail) => {
          reject = fail;
        }),
    ),
  });
  const view = render(<ConversionJobs {...props} captureSession={() => () => current} />);
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
  current = false;
  view.unmount();
  reject(new ApiError(401, 'old account'));
  await Promise.resolve();
  expect(props.onAuthenticationError).not.toHaveBeenCalled();
  const auth: BrowserAuth = {
    account: () => null,
    signIn: async () => ({ id: 'owner', name: 'Owner' }),
    accessToken: async () => 'synthetic',
    signOut: async () => {},
  };
  expect(() => createConversionsApi(auth)).not.toThrow();
});

/** @id TEST-CJU-005 @verifies REQ-CJU-005 */
it('TEST-CJU-005 translates labels but not filenames and exposes keyboard-focusable retry after failure', async () => {
  const { api, props } = fixture({
    list: vi.fn(async (): Promise<ConversionPage> => ({
      items: [{ ...row, state: 'failed', reason: 'page_limit' }],
      nextCursor: null,
    })),
  });
  const translate = (text: string) => (text === '再試行' ? 'Retry' : text);
  render(<ConversionJobs {...props} t={translate} />);
  await waitFor(() => expect(screen.queryByText('synthetic.pdf')).toBeVisible());
  const retry = screen.getByRole('button', { name: 'Retry' });
  retry.focus();
  await userEvent.keyboard('{Enter}');
  expect(api.request).toHaveBeenCalledTimes(1);
});

it('opens one Jobs tab while retaining file tabs and restores the current project on close/reopen', async () => {
  const ref = createRef<WorkspaceTabsHandle>();
  const user = userEvent.setup();
  render(
    <WorkspaceTabs
      ref={ref}
      scopeKey="synthetic-project"
      chat="Chat"
      notebook="Notebook"
      jobs="Acknowledged jobs"
      t={(text) => text}
      renderFile={(file) => <p>{file.name} body</p>}
    />,
  );
  act(() => ref.current?.openFile({ id: row.sourceId, name: row.sourceName }));
  expect(screen.getByText('synthetic.pdf body')).toBeVisible();
  expect(() => act(() => ref.current?.openJobs())).not.toThrow();
  act(() => ref.current?.openJobs());
  expect(screen.getAllByRole('tab', { name: 'ジョブ' })).toHaveLength(1);
  expect(screen.getByText('Acknowledged jobs')).toBeVisible();
  expect(screen.getByRole('tab', { name: row.sourceName })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'ジョブタブを閉じる' }));
  expect(screen.queryByRole('tab', { name: 'ジョブ' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: row.sourceName })).toBeVisible();
  act(() => ref.current?.openJobs());
  expect(screen.getByText('Acknowledged jobs')).toBeVisible();
});

it('file menu opens Jobs only after conversion acknowledgment and preserves download/trash actions', async () => {
  const user = userEvent.setup();
  const { api, props } = fixture();
  let acknowledge!: (value: ConversionRequest) => void;
  api.request = vi.fn(
    () =>
      new Promise<ConversionRequest>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const source: ProjectFile = {
    id: row.sourceId,
    name: row.sourceName,
    kind: 'pdf',
    size: 1,
    sha256: 'a'.repeat(64),
    createdAt: row.createdAt,
  };
  const files: FilesApi = {
    list: vi.fn(async () => ({
      items: [source],
      nextCursor: null,
      usedBytes: 1,
      reservedBytes: 0,
      limitBytes: 10000000000,
    })),
    upload: vi.fn(async () => source),
    content: vi.fn(async () => new Uint8Array([1])),
    setTrashed: vi.fn(async () => {}),
    emptyTrash: vi.fn(async () => {}),
  };
  const onOpenJobs = vi.fn();
  render(
    <ProjectFiles
      projectId={projectId}
      scopeKey={props.scopeKey}
      api={files}
      conversionsApi={api}
      onOpenJobs={onOpenJobs}
      onOpen={props.onOpen}
      onTrashed={vi.fn()}
      captureSession={props.captureSession}
      t={props.t}
      onAuthenticationError={props.onAuthenticationError}
      onUploadInterrupted={vi.fn()}
    />,
  );
  const menu = await screen.findByRole('button', { name: `ファイル操作: ${row.sourceName}` });
  await user.click(menu);
  expect(screen.getByRole('menuitem', { name: 'ダウンロード' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '削除' })).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: '変換' })).toBeVisible());
  await user.click(screen.getByRole('menuitem', { name: '変換' }));
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(onOpenJobs).not.toHaveBeenCalled();
  await act(async () => acknowledge(row));
  await waitFor(() => expect(onOpenJobs).toHaveBeenCalledTimes(1));
  expect(api.request).toHaveBeenCalledWith(
    projectId,
    source.id,
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(files.content).not.toHaveBeenCalled();
  expect(files.setTrashed).not.toHaveBeenCalled();
});

/** @id TEST-CJU-006 @verifies REQ-CJU-004 */
it('TEST-CJU-006 validates bounded authenticated protocol responses and binds writes to their project and source', async () => {
  let owner = 'owner';
  const auth: BrowserAuth = {
    account: () => ({ id: owner, name: owner }),
    accessToken: vi.fn(async () => 'synthetic-token'),
    signIn: async () => ({ id: owner, name: owner }),
    signOut: async () => {},
  };
  expect(() => createConversionsApi(auth)).not.toThrow();
  const api = createConversionsApi(auth);
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ items: [row], nextCursor: 'next_123' }),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const signal = new AbortController().signal;
    expect(await api.list(projectId, 'page_1', signal)).toEqual({
      items: [row],
      nextCursor: 'next_123',
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/projects/${projectId}/conversions?cursor=page_1`,
      expect.objectContaining({
        method: 'GET',
        signal,
        cache: 'no-store',
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token' }),
      }),
    );
    fetcher.mockImplementationOnce(async () => Response.json({ enabled: true }));
    expect(await api.capabilities(projectId)).toEqual({ enabled: true });
    fetcher.mockImplementationOnce(async () => Response.json(row, { status: 202 }));
    expect(await api.request(projectId, row.sourceId, 'retry:synthetic', signal)).toEqual(row);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/projects/${projectId}/files/${row.sourceId}/conversions`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Idempotency-Key': 'retry:synthetic',
        }),
      }),
    );
    fetcher.mockImplementationOnce(async () => Response.json(row));
    await api.cancel(projectId, row.id, signal);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/projects/${projectId}/conversions/${row.id}/cancel`,
      expect.objectContaining({ method: 'POST', signal }),
    );
    expect(fetcher.mock.calls.at(-1)?.[1]).not.toHaveProperty('body');
    const invalid = [
      { items: [{ ...row, state: 'invented' }], nextCursor: null },
      { items: [{ ...row, reason: 'secret stack trace' }], nextCursor: null },
      { items: [{ ...row, projectId: row.sourceId }], nextCursor: null },
      { items: [row, row], nextCursor: null },
      { items: [row], nextCursor: '../escape' },
      { items: [row], nextCursor: null, owner: 'other' },
      { items: [{ ...row, sourceName: '<unsafe>\n.pdf' }], nextCursor: null },
      { items: [{ ...row, artifacts: {} }], nextCursor: null },
    ];
    for (const value of invalid) {
      fetcher.mockImplementationOnce(async () => Response.json(value));
      await expect(api.list(projectId)).rejects.toBeInstanceOf(ApiError);
    }
    fetcher.mockImplementationOnce(async () => Response.json({ enabled: true, extra: true }));
    await expect(api.capabilities(projectId)).rejects.toMatchObject({ status: 503 });
    fetcher.mockImplementationOnce(async () => Response.json({ ...row, sourceId: row.id }));
    await expect(api.request(projectId, row.sourceId, 'key')).rejects.toMatchObject({
      status: 503,
    });
    fetcher.mockImplementationOnce(async () => Response.json({ ...row, id: row.sourceId }));
    await expect(api.cancel(projectId, row.id)).rejects.toMatchObject({ status: 503 });
    fetcher.mockImplementationOnce(async () => Response.json(row, { status: 201 }));
    await expect(api.cancel(projectId, row.id)).rejects.toMatchObject({ status: 503 });
    const count = fetcher.mock.calls.length;
    await expect(api.list('../project')).rejects.toBeInstanceOf(ApiError);
    await expect(api.list(projectId, '../cursor')).rejects.toBeInstanceOf(ApiError);
    await expect(api.request(projectId, row.sourceId, 'bad\nkey')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(count);
    fetcher.mockImplementationOnce(
      async () => new Response('private diagnostics', { status: 503 }),
    );
    await expect(api.list(projectId)).rejects.toMatchObject({
      status: 503,
      message: '文書変換は現在利用できません。',
    });
    fetcher.mockImplementationOnce(
      async () =>
        new Response(' '.repeat(512 * 1024 + 1), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(api.list(projectId)).rejects.toMatchObject({ status: 503 });
    let finish!: (value: ReadableStreamReadResult<Uint8Array>) => void;
    const cancel = vi.fn(async () => {});
    fetcher.mockImplementationOnce(async () => {
      const response = Response.json({});
      Object.defineProperty(response, 'body', {
        value: {
          getReader: () => ({
            read: () =>
              new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
                finish = resolve;
              }),
            cancel,
            releaseLock: vi.fn(),
          }),
        },
      });
      return response;
    });
    const pending = api.list(projectId);
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    owner = 'other-owner';
    finish({ done: true, value: undefined });
    await rejected;
    expect(cancel).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

/** @id TEST-CJU-007 @verifies REQ-CJU-004 REQ-CJU-005 */
it('TEST-CJU-007 polls only active panels at least one second apart without overlapping requests', async () => {
  vi.useFakeTimers();
  const flush = async () => {
    await act(async () => {
      for (let index = 0; index < 12; index++) await Promise.resolve();
    });
  };
  let finish!: (value: ConversionPage) => void;
  const { api, props } = fixture();
  const view = render(<ConversionJobs {...props} active={false} />);
  try {
    await flush();
    expect(api.list).not.toHaveBeenCalled();
    view.rerender(<ConversionJobs {...props} active />);
    await flush();
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(api.list).toHaveBeenCalledTimes(1);
    vi.mocked(api.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.list).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(api.list).mock.calls.at(-1)?.[2];
    view.rerender(<ConversionJobs {...props} active={false} />);
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      finish({ items: [{ ...row, sourceName: 'stale.pdf' }], nextCursor: null }),
    );
    expect(screen.queryByText('stale.pdf')).not.toBeInTheDocument();
    expect(screen.getByText(row.sourceName)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.list).toHaveBeenCalledTimes(2);
    view.rerender(<ConversionJobs {...props} active />);
    await flush();
    expect(api.list).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.list).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

/** @id TEST-CJU-008 @verifies REQ-CJU-004 */
it('TEST-CJU-008 rejects same-turn stale owner/project/epoch results and only forwards a current401', async () => {
  let epoch = 0;
  const pending: {
    resolve: (value: ConversionPage) => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
  }[] = [];
  const { api, props } = fixture({
    list: vi.fn<ConversionsApi['list']>(
      (_project, _cursor, signal) =>
        new Promise<ConversionPage>((resolve, reject) => {
          pending.push({ resolve, reject, signal });
        }),
    ),
  });
  const capture = () => {
    const saved = epoch;
    return () => epoch === saved;
  };
  const view = render(<ConversionJobs {...props} captureSession={capture} />);
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
  await act(async () => {
    epoch++;
    pending[0]!.reject(new ApiError(401, 'old epoch'));
  });
  expect(props.onAuthenticationError).not.toHaveBeenCalled();
  view.rerender(<ConversionJobs {...props} scopeKey="new-owner" captureSession={capture} />);
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => {
    view.rerender(
      <ConversionJobs
        {...props}
        projectId={row.sourceId}
        scopeKey="new-project"
        captureSession={capture}
      />,
    );
    pending[1]!.reject(new ApiError(401, 'old project'));
  });
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(3));
  expect(props.onAuthenticationError).not.toHaveBeenCalled();
  await act(async () => {
    pending[2]!.resolve({
      items: [{ ...row, projectId: row.sourceId, sourceName: 'new-owner.pdf' }],
      nextCursor: null,
    });
  });
  expect(await screen.findByText('new-owner.pdf')).toBeVisible();
  expect(screen.queryByText(row.sourceName)).not.toBeInTheDocument();
  view.unmount();
  const latest = fixture({ list: vi.fn(async () => Promise.reject(new ApiError(401, 'current'))) });
  render(<ConversionJobs {...latest.props} />);
  await waitFor(() => expect(latest.props.onAuthenticationError).toHaveBeenCalledTimes(1));
});

/** @id TEST-CJU-009 @verifies REQ-CJU-001 REQ-CJU-002 REQ-CJU-005 */
it('TEST-CJU-009 paginates acknowledged history and opens only available artifacts without translating filenames', async () => {
  const { english } = await import('../src/client/i18n');
  const file: ProjectFile = {
    id: '12345678-1234-4234-8234-123456789015',
    name: 'synthetic.md',
    size: 12,
    sha256: 'a'.repeat(64),
    kind: 'text',
    createdAt: row.createdAt,
  };
  const succeeded: ConversionRequest = {
    ...row,
    state: 'succeeded',
    artifacts: {
      markdown: { id: file.id, availability: 'available', file },
      json: { id: row.sourceId, availability: 'trashed', file: null },
    },
  };
  const { api, props } = fixture({
    list: vi.fn<ConversionsApi['list']>(async (_project, cursor) =>
      cursor
        ? {
            items: [
              {
                ...row,
                id: row.sourceId,
                state: 'failed',
                reason: 'page_limit',
                sourceName: '再試行',
              },
            ],
            nextCursor: null,
          }
        : { items: [succeeded], nextCursor: 'older' },
    ),
  });
  const translate = (text: string) => english[text as keyof typeof english] ?? text;
  const view = render(<ConversionJobs {...props} t={translate} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Open Markdown' }));
  expect(props.onOpen).toHaveBeenCalledWith(file);
  expect(screen.queryByRole('button', { name: 'Open JSON' })).not.toBeInTheDocument();
  expect(screen.getByText('Artifact unavailable')).toBeVisible();
  expect(screen.getByText('Succeeded')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Load more jobs' }));
  expect(await screen.findByText('再試行')).toBeVisible();
  expect(screen.getByText('The document exceeds the page limit.')).toBeVisible();
  expect(screen.getByText(row.sourceName)).toBeVisible();
  expect(api.list).toHaveBeenLastCalledWith(projectId, 'older', expect.any(AbortSignal));
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  view.rerender(<ConversionJobs {...props} />);
  expect(screen.getByRole('button', { name: 'Markdownを開く' })).toBeVisible();
  expect(screen.getByText('再試行', { selector: 'span' })).toBeVisible();
});

function menuFixture(source: ProjectFile, api: ConversionsApi, props: ConversionJobsProps) {
  const files: FilesApi = {
    list: vi.fn(async () => ({
      items: [source],
      nextCursor: null,
      usedBytes: source.size,
      reservedBytes: 0,
      limitBytes: 10000000000,
    })),
    upload: vi.fn(async () => source),
    content: vi.fn(async () => new Uint8Array([1])),
    setTrashed: vi.fn(async () => {}),
    emptyTrash: vi.fn(async () => {}),
  };
  const onOpenJobs = vi.fn();
  const element = (
    <ProjectFiles
      projectId={projectId}
      scopeKey={props.scopeKey}
      api={files}
      conversionsApi={api}
      onOpenJobs={onOpenJobs}
      onOpen={props.onOpen}
      onTrashed={vi.fn()}
      captureSession={props.captureSession}
      t={props.t}
      onAuthenticationError={props.onAuthenticationError}
      onUploadInterrupted={vi.fn()}
    />
  );
  return { files, onOpenJobs, element };
}

/** @id TEST-CJU-010 @verifies REQ-CJU-003 REQ-CJU-004 */
it('TEST-CJU-010 retains original menu operations for disabled, unsupported and oversized sources and accepts the exact size boundary', async () => {
  const user = userEvent.setup();
  for (const [name, size, enabled, reason] of [
    ['synthetic.pdf', 1, false, '文書変換は現在利用できません。'],
    ['synthetic.txt', 1, true, 'この形式は文書変換に対応していません。'],
    ['synthetic.pdf', 25000001, true, '文書変換は25MB以下のファイルに対応しています。'],
    ['synthetic.PDF', 25000000, true, null],
  ] as const) {
    const { api, props } = fixture({
      capabilities: vi.fn(async () => ({ enabled })),
    });
    const source: ProjectFile = {
      id: row.sourceId,
      name,
      kind: name.endsWith('txt') ? 'text' : 'pdf',
      size,
      sha256: 'a'.repeat(64),
      createdAt: row.createdAt,
    };
    const menu = menuFixture(source, api, props);
    const view = render(menu.element);
    await user.click(await screen.findByRole('button', { name: `ファイル操作: ${name}` }));
    expect(screen.getByRole('menuitem', { name: 'ダウンロード' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: '削除' })).not.toHaveAttribute('data-disabled');
    expect(await screen.findByRole('menuitem', { name: 'ジョブを開く' })).toBeVisible();
    if (reason) {
      expect(await screen.findByText(reason)).toBeVisible();
      expect(api.request).not.toHaveBeenCalled();
    } else {
      await user.click(await screen.findByRole('menuitem', { name: '変換' }));
      await waitFor(() => expect(menu.onOpenJobs).toHaveBeenCalledTimes(1));
      expect(api.request).toHaveBeenCalledTimes(1);
    }
    view.unmount();
  }
});

/** @id TEST-CJU-011 @verifies REQ-CJU-002 REQ-CJU-004 */
it('TEST-CJU-011 retains snapshots on failures, reuses retry idempotency and rejects duplicate writes synchronously', async () => {
  const failed: ConversionRequest = { ...row, state: 'failed', reason: 'conversion_failed' };
  const { api, props } = fixture({
    list: vi.fn(async () => ({ items: [failed], nextCursor: null })),
    request: vi
      .fn<ConversionsApi['request']>()
      .mockRejectedValueOnce(new ApiError(503, 'private stack trace'))
      .mockResolvedValueOnce({ ...row, id: row.sourceId }),
  });
  render(<ConversionJobs {...props} />);
  const retry = await screen.findByRole('button', { name: '再試行' });
  await act(async () => {
    retry.click();
    retry.click();
  });
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(screen.getByText('失敗')).toBeVisible();
  expect(screen.queryByText('private stack trace')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('文書変換は現在利用できません。');
  await userEvent.click(screen.getByRole('button', { name: '再試行' }));
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.request).mock.calls[0]?.[2]).toBe(vi.mocked(api.request).mock.calls[1]?.[2]);
  expect(await screen.findByText('待機中')).toBeVisible();
  expect(screen.getByText('失敗')).toBeVisible();
});

/** @id TEST-CJU-012 @verifies REQ-CJU-001 REQ-CJU-004 REQ-CJU-005 */
it('TEST-CJU-012 integrates Jobs with App, preserves file context and never opens Jobs for an automatic upload', async () => {
  const { App } = await import('./helpers/app');
  const user = userEvent.setup();
  let account: { id: string; name: string } | null = { id: 'owner', name: 'Owner' };
  const auth: BrowserAuth = {
    account: () => account,
    signIn: async () => ({ id: 'owner', name: 'Owner' }),
    signOut: async () => {
      account = null;
    },
    accessToken: async () => 'synthetic',
    invalidate: vi.fn(() => {
      account = null;
    }),
  };
  const { api, props } = fixture();
  const source: ProjectFile = {
    id: row.sourceId,
    name: row.sourceName,
    kind: 'pdf',
    size: 1,
    sha256: 'a'.repeat(64),
    createdAt: row.createdAt,
  };
  const menu = menuFixture(source, api, props);
  render(
    <App
      auth={auth}
      api={{
        list: async () => [
          {
            id: projectId,
            name: 'Synthetic project',
            version: 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        ],
        create: vi.fn(),
        rename: vi.fn(),
      }}
      filesApi={menu.files}
      conversionsApi={api}
    />,
  );
  await screen.findByRole('button', { name: `ファイルを開く: ${source.name}` });
  await user.upload(
    screen.getByLabelText('アップロードするファイル'),
    new File(['synthetic'], 'upload.pdf', { type: 'application/pdf' }),
  );
  await waitFor(() => expect(menu.files.upload).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('tab', { name: 'AIチャット' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab', { name: 'ジョブ' })).not.toBeInTheDocument();
  expect(api.request).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: `ファイル操作: ${source.name}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'ジョブを開く' }));
  expect(await screen.findByText(row.sourceName, { selector: 'span' })).toBeVisible();
  expect(screen.getByRole('tab', { name: 'ジョブ' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('button', { name: 'ジョブタブを閉じる' }));
  expect(screen.queryByRole('tab', { name: 'ジョブ' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: `ファイル操作: ${source.name}` }));
  await user.click(screen.getByRole('menuitem', { name: 'ジョブを開く' }));
  expect(await screen.findByText(row.sourceName, { selector: 'span' })).toBeVisible();
  vi.mocked(api.list).mockRejectedValueOnce(new ApiError(401, 'current'));
  await user.click(screen.getByRole('button', { name: 'ジョブを再読み込み' }));
  expect(
    await screen.findByRole('button', { name: 'Microsoft Entra ID でサインイン' }),
  ).toBeVisible();
  expect(auth.invalidate).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(row.sourceName)).not.toBeInTheDocument();
});

/** @id TEST-CJU-013 @verifies REQ-CJU-002 REQ-CJU-005 */
it('TEST-CJU-013 exposes exactly the allowed acknowledged action for every server state and safely retries unavailable loads', async () => {
  for (const [state, label, action] of [
    ['waiting', '待機中', 'キャンセル'],
    ['queued', 'キュー待ち', 'キャンセル'],
    ['running', '実行中', 'キャンセル'],
    ['cancel_requested', 'キャンセル要求済み', null],
    ['succeeded', '完了', null],
    ['failed', '失敗', '再試行'],
    ['cancelled', 'キャンセル済み', '再試行'],
  ] as const) {
    const { props } = fixture({
      list: vi.fn(async (): Promise<ConversionPage> => ({
        items: [
          {
            ...row,
            state,
            artifacts:
              state === 'succeeded'
                ? {
                    markdown: { id: row.sourceId, availability: 'missing', file: null },
                    json: { id: row.id, availability: 'trashed', file: null },
                  }
                : null,
          },
        ],
        nextCursor: null,
      })),
    });
    const view = render(<ConversionJobs {...props} />);
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'キャンセル' }) !== null).toBe(
      action === 'キャンセル',
    );
    expect(screen.queryByRole('button', { name: '再試行' }) !== null).toBe(action === '再試行');
    expect(screen.queryByRole('button', { name: /を開く$/ })).not.toBeInTheDocument();
    view.unmount();
  }
  const { api, props } = fixture({
    capabilities: vi
      .fn<ConversionsApi['capabilities']>()
      .mockRejectedValueOnce(new ApiError(503, 'private detail'))
      .mockResolvedValueOnce({ enabled: true }),
  });
  render(<ConversionJobs {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('文書変換は現在利用できません。');
  expect(api.list).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'ジョブを再読み込み' }));
  expect(await screen.findByText(row.sourceName)).toBeVisible();
});

/** @id TEST-CJU-014 @verifies REQ-CJU-002 REQ-CJU-004 REQ-CJU-005 */
it('TEST-CJU-014 keeps keyboard actions stable during polls, preempts stale reads and restores focus after acknowledgment', async () => {
  vi.useFakeTimers();
  let finishPoll!: (value: ConversionPage) => void;
  let finishWrite!: (value: ConversionRequest) => void;
  const { api, props } = fixture({
    list: vi.fn(async () => ({ items: [{ ...row }], nextCursor: null })),
    cancel: vi.fn(
      () =>
        new Promise<ConversionRequest>((resolve) => {
          finishWrite = resolve;
        }),
    ),
  });
  const view = render(<ConversionJobs {...props} />);
  try {
    await act(async () => {
      for (let index = 0; index < 12; index++) await Promise.resolve();
    });
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    cancel.focus();
    vi.mocked(api.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const pollSignal = vi.mocked(api.list).mock.calls.at(-1)?.[2];
    expect(cancel).toBeEnabled();
    expect(cancel).toHaveFocus();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => cancel.click());
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(pollSignal?.aborted).toBe(true);
    expect(cancel).toBeDisabled();
    await act(async () =>
      finishPoll({
        items: [{ ...row, sourceName: 'stale-poll.pdf' }],
        nextCursor: null,
      }),
    );
    expect(screen.queryByText('stale-poll.pdf')).not.toBeInTheDocument();
    await act(async () => finishWrite({ ...row, state: 'cancel_requested' }));
    expect(screen.getByText('キャンセル要求済み')).toBeVisible();
    expect(screen.getByRole('listitem')).toHaveFocus();
    await act(async () => screen.getByRole('button', { name: 'ジョブを再読み込み' }).click());
    vi.mocked(api.cancel).mockRejectedValueOnce(new ApiError(503, 'synthetic write failure'));
    const failedCancel = screen.getByRole('button', { name: 'キャンセル' });
    failedCancel.focus();
    await act(async () => failedCancel.click());
    expect(screen.getByRole('alert')).toBeVisible();
    failedCancel.blur();
    expect(document.body).toHaveFocus();
    await act(async () => screen.getByRole('button', { name: 'ジョブを再読み込み' }).click());
    expect(document.body).toHaveFocus();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

/** @id TEST-CJU-015 @verifies REQ-CJU-004 */
it('TEST-CJU-015 discards stale cancellation and retry acknowledgments and401 on owner, project, epoch and activity changes', async () => {
  for (const retry of [false, true]) {
    for (const change of ['owner', 'project', 'epoch', 'inactive'] as const) {
      for (const reject401 of [false, true]) {
        let current = true;
        let resolve!: (value: ConversionRequest) => void;
        let reject!: (cause: unknown) => void;
        const write = vi.fn(
          () =>
            new Promise<ConversionRequest>((done, fail) => {
              resolve = done;
              reject = fail;
            }),
        );
        const { api, props } = fixture({
          list: vi.fn(async () => ({
            items: [{ ...row, state: retry ? 'failed' : 'waiting' } as ConversionRequest],
            nextCursor: null,
          })),
          cancel: write,
          request: write,
        });
        const capture = () => () => current;
        const view = render(<ConversionJobs {...props} captureSession={capture} />);
        await userEvent.click(
          await screen.findByRole('button', {
            name: retry ? '再試行' : 'キャンセル',
          }),
        );
        expect(write).toHaveBeenCalledTimes(1);
        const signal = retry
          ? vi.mocked(api.request).mock.calls[0]?.[3]
          : vi.mocked(api.cancel).mock.calls[0]?.[2];
        await act(async () => {
          current = false;
          if (change !== 'epoch')
            view.rerender(
              <ConversionJobs
                {...props}
                captureSession={capture}
                scopeKey={change === 'owner' ? 'new-owner' : props.scopeKey}
                projectId={change === 'project' ? row.sourceId : projectId}
                active={change !== 'inactive'}
              />,
            );
          if (reject401) reject(new ApiError(401, 'stale write'));
          else resolve({ ...row, sourceName: 'stale-write.pdf', state: 'cancelled' });
        });
        expect(props.onAuthenticationError).not.toHaveBeenCalled();
        expect(screen.queryByText('stale-write.pdf')).not.toBeInTheDocument();
        expect(screen.queryByText('キャンセル済み')).not.toBeInTheDocument();
        expect(signal?.aborted).toBe(true);
        view.unmount();
      }
    }
  }
});

/** @id TEST-CJU-016 @verifies REQ-CJU-002 REQ-CJU-004 */
it('TEST-CJU-016 preserves history after a failed poll and resumes only after explicit reload', async () => {
  vi.useFakeTimers();
  const { api, props } = fixture();
  const view = render(<ConversionJobs {...props} />);
  try {
    await act(async () => {
      for (let index = 0; index < 12; index++) await Promise.resolve();
    });
    vi.mocked(api.list).mockRejectedValueOnce(new ApiError(503, 'private poll failure'));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('alert')).toHaveTextContent('文書変換は現在利用できません。');
    expect(screen.getByText(row.sourceName)).toBeVisible();
    expect(screen.queryByText('private poll failure')).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => screen.getByRole('button', { name: 'ジョブを再読み込み' }).click());
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.list).toHaveBeenCalledTimes(4);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
