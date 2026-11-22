// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import { FileViewer, ProjectFiles } from '../src/client/components/project-files';
import type { ProjectFile, FilePage } from '../src/shared/files';
import type { FilesApi } from '../src/client/files-api';
import type { BrowserAuth, UserAccount } from '../src/client/auth';
import type { ProjectsApi } from '../src/client/api';
import { translate } from '../src/client/i18n';
import { ApiError } from '../src/client/api';
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/test-only-pdf-worker.mjs',
}));
const pdf = vi.hoisted(() => ({
  load: vi.fn(),
  loadingDestroy: vi.fn(),
  workerDestroy: vi.fn(),
  terminate: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(),
  cleanup: vi.fn(),
  getPage: vi.fn(),
}));
vi.mock('pdfjs-dist', () => ({
  getDocument: pdf.load,
  PDFWorker: class {
    static create() {
      return new this();
    }
    destroy = pdf.workerDestroy;
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const bytes = new TextEncoder().encode('研究 <script>window.bad=true</script>\n');
const file: ProjectFile = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: '研究.txt',
  size: bytes.length,
  sha256: '0'.repeat(64),
  kind: 'text',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const page = (items: ProjectFile[], nextCursor: string | null = null): FilePage => ({
  items,
  nextCursor,
  usedBytes: items.reduce((sum, f) => sum + f.size, 0),
  reservedBytes: 0,
  limitBytes: 10000000000,
});
function fileApi() {
  return {
    list: vi.fn<FilesApi['list']>(async () => page([file])),
    upload: vi.fn<FilesApi['upload']>(async () => file),
    content: vi.fn<FilesApi['content']>(async () => bytes),
    emptyTrash: vi.fn<(projectId: string, signal?: AbortSignal) => Promise<void>>(async () => {}),
    setTrashed: vi.fn<
      (projectId: string, id: string, trashed: boolean, signal?: AbortSignal) => Promise<void>
    >(async () => {}),
  };
}
function fixture() {
  let account: UserAccount | null = { id: 'alice', name: 'Researcher' };
  let notify = () => {};
  const auth: BrowserAuth = {
    account: () => account,
    accessToken: vi.fn(async () => 'synthetic'),
    signIn: vi.fn(async () => ({ id: 'alice', name: 'Researcher' })),
    signOut: vi.fn(async () => {
      account = null;
    }),
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const project = (id: string, name: string) => ({
    id,
    name,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const projects = [
    project('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Project A'),
    project('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Project B'),
  ];
  const api: ProjectsApi = { list: vi.fn(async () => projects), create: vi.fn(), rename: vi.fn() };
  const files = fileApi();
  const view = render(<App auth={auth} api={api} filesApi={files} />);
  return {
    files,
    view,
    projects,
    switchAccount: () =>
      act(() => {
        account = { id: 'bob', name: 'Other' };
        notify();
      }),
  };
}
function dragTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...values.keys()];
    },
    setData: vi.fn((type: string, value: string) => {
      values.set(type, value);
    }),
    getData: vi.fn((type: string) => values.get(type) ?? ''),
  };
}
/** @id TEST-FTD-001 @verifies REQ-FTD-001 */
it('TEST-FTD-001 drops one file into reversible trash, closes only on success and retains failures', async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Project A' }, { timeout: 5000 });
  const open = await screen.findByRole(
    'button',
    { name: 'ファイルを開く: 研究.txt' },
    { timeout: 5000 },
  );
  const row = open.closest('li')!;
  const trash = screen.getByRole('button', { name: 'ゴミ箱' });
  await user.click(open);
  expect(await screen.findByRole('tab', { name: file.name })).toBeVisible();
  expect(row).toHaveAttribute('draggable', 'true');
  let rejectWrite: (cause: unknown) => void = () => {
    throw Error('No pending trash');
  };
  f.files.setTrashed.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  const transfer = dragTransfer();
  fireEvent.dragStart(row, { dataTransfer: transfer });
  expect(transfer.effectAllowed).toBe('move');
  expect(fireEvent.dragOver(trash, { dataTransfer: transfer })).toBe(false);
  expect(transfer.dropEffect).toBe('move');
  expect(transfer.getData).not.toHaveBeenCalled();
  expect(trash).toHaveClass('ring-2');
  fireEvent.dragLeave(trash);
  expect(trash).not.toHaveClass('ring-2');
  fireEvent.dragOver(trash, { dataTransfer: transfer });
  fireEvent.drop(trash, { dataTransfer: transfer });
  expect(f.files.setTrashed).toHaveBeenCalledExactlyOnceWith(
    f.projects[0]!.id,
    file.id,
    true,
    expect.any(AbortSignal),
  );
  expect(trash).not.toHaveClass('ring-2');
  expect(trash).toBeDisabled();
  expect(row).toHaveAttribute('draggable', 'false');
  fireEvent.drop(trash, { dataTransfer: transfer });
  expect(f.files.setTrashed).toHaveBeenCalledTimes(1);
  expect(open).toBeVisible();
  expect(screen.getByRole('tab', { name: file.name })).toBeVisible();
  await act(async () => rejectWrite(new ApiError(503, 'Retry dragged file')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Retry dragged file');
  expect(open).toBeVisible();
  expect(screen.getByRole('tab', { name: file.name })).toBeVisible();
  const retry = dragTransfer();
  fireEvent.dragStart(row, { dataTransfer: retry });
  fireEvent.dragOver(trash, { dataTransfer: retry });
  fireEvent.drop(trash, { dataTransfer: retry });
  await waitFor(() => expect(open).not.toBeInTheDocument());
  expect(screen.queryByRole('tab', { name: file.name })).toBeNull();
  expect(f.files.setTrashed).toHaveBeenCalledTimes(2);
  expect(f.files.emptyTrash).not.toHaveBeenCalled();
  expect(f.files.upload).not.toHaveBeenCalled();
  await user.click(trash);
  const restore = await screen.findByRole('button', { name: 'ファイルを復元: 研究.txt' });
  const trashRow = restore.closest('li')!;
  expect(trashRow).toHaveAttribute('draggable', 'false');
  const ignored = dragTransfer();
  expect(fireEvent.dragStart(trashRow, { dataTransfer: ignored })).toBe(false);
  fireEvent.drop(screen.getByRole('button', { name: 'ファイルに戻る' }), { dataTransfer: retry });
  expect(f.files.setTrashed).toHaveBeenCalledTimes(2);
});

/** @id TEST-FTD-002 @verifies REQ-FTD-002 */
it('TEST-FTD-002 rejects external, mismatched, canceled, busy and old-session drags but accepts a fresh local control', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const source = () =>
    screen.getByRole('button', { name: 'ファイルを開く: 研究.txt' }).closest('li')!;
  const target = () => screen.getByRole('button', { name: 'ゴミ箱' });
  await screen.findByRole('heading', { name: 'Project A' }, { timeout: 5000 });
  await screen.findByRole('button', { name: 'ファイルを開く: 研究.txt' }, { timeout: 5000 });
  const forged = dragTransfer();
  forged.setData('application/x-aira-project-file', file.id);
  expect(fireEvent.dragOver(target(), { dataTransfer: forged })).toBe(true);
  fireEvent.drop(target(), { dataTransfer: forged });
  fireEvent.drop(target(), {
    dataTransfer: { types: ['Files'], files: [new File(['x'], 'os.txt')] },
  });
  const mismatch = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: mismatch });
  mismatch.setData(mismatch.types[0]!, 'unknown-file');
  fireEvent.drop(target(), { dataTransfer: mismatch });
  const canceled = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: canceled });
  fireEvent.dragOver(target(), { dataTransfer: canceled });
  fireEvent.dragEnd(source(), { dataTransfer: canceled });
  expect(target()).not.toHaveClass('ring-2');
  fireEvent.drop(target(), { dataTransfer: canceled });
  expect(f.files.setTrashed).not.toHaveBeenCalled();
  const loading = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: loading });
  let finishList: (result: FilePage) => void = () => {
    throw Error('No pending list');
  };
  f.files.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishList = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  expect(source()).toHaveAttribute('draggable', 'false');
  fireEvent.drop(target(), { dataTransfer: loading });
  expect(f.files.setTrashed).not.toHaveBeenCalled();
  await act(async () => finishList(page([file])));
  const uploading = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: uploading });
  let finishUpload: (result: ProjectFile) => void = () => {
    throw Error('No pending upload');
  };
  f.files.upload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
  );
  await user.upload(screen.getByLabelText('アップロードするファイル'), new File(['x'], 'new.txt'));
  expect(source()).toHaveAttribute('draggable', 'false');
  fireEvent.drop(target(), { dataTransfer: uploading });
  expect(f.files.setTrashed).not.toHaveBeenCalled();
  await act(async () => finishUpload(file));
  await waitFor(() => expect(source()).toHaveAttribute('draggable', 'true'));
  const oldProject = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: oldProject });
  await user.click(screen.getByRole('button', { name: 'Project B' }));
  await screen.findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  fireEvent.drop(target(), { dataTransfer: oldProject });
  expect(f.files.setTrashed).not.toHaveBeenCalled();
  const oldAccount = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: oldAccount });
  f.switchAccount();
  await screen.findByRole('heading', { name: 'Project A' });
  await screen.findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  fireEvent.drop(target(), { dataTransfer: oldAccount });
  expect(f.files.setTrashed).not.toHaveBeenCalled();
  const valid = dragTransfer();
  fireEvent.dragStart(source(), { dataTransfer: valid });
  fireEvent.drop(target(), { dataTransfer: valid });
  await waitFor(() =>
    expect(f.files.setTrashed).toHaveBeenCalledExactlyOnceWith(
      f.projects[0]!.id,
      file.id,
      true,
      expect.any(AbortSignal),
    ),
  );
});
/** @id TEST-FTB-001 @verifies REQ-FTB-001 */
it('TEST-FTB-001 places upload/reload icons beside the heading and retains picker, retry and disabled behavior', async () => {
  const api = fileApi();
  const user = userEvent.setup();
  const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const component = (id: string | null, language: 'ja' | 'en' = 'ja') => (
    <ProjectFiles
      scopeKey={JSON.stringify(['alice', id])}
      projectId={id}
      api={api}
      t={(text) => translate(language, text)}
      captureSession={() => () => true}
      onOpen={vi.fn()}
      onTrashed={vi.fn()}
      onAuthenticationError={vi.fn()}
      onUploadInterrupted={vi.fn()}
    />
  );
  const view = render(component(null));
  const emptyActions = screen.getByRole('group', { name: 'ファイル操作' });
  expect(
    within(emptyActions).getByRole('button', { name: 'ファイルをアップロード' }),
  ).toBeDisabled();
  expect(
    within(emptyActions).getByRole('button', { name: 'ファイル一覧を再読み込み' }),
  ).toBeDisabled();
  view.rerender(component(projectId));
  await screen.findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  const actions = screen.getByRole('group', { name: 'ファイル操作' });
  const heading = screen.getByRole('heading', { name: 'ファイル' });
  expect(heading.parentElement).toContainElement(actions);
  const upload = within(actions).getByRole('button', { name: 'ファイルをアップロード' });
  const reload = within(actions).getByRole('button', { name: 'ファイル一覧を再読み込み' });
  expect(screen.getAllByRole('button', { name: 'ファイル一覧を再読み込み' })).toHaveLength(1);
  expect(screen.queryByText('ファイル一覧を再読み込み')).toBeNull();
  expect(upload.textContent).toBe('');
  expect(reload.textContent).toBe('');
  const input = screen.getByLabelText('アップロードするファイル');
  expect(input).not.toBeVisible();
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {});
  await user.click(upload);
  expect(picker).toHaveBeenCalledOnce();
  picker.mockRestore();
  let finishUpload: (result: ProjectFile) => void = () => {
    throw Error('No pending upload');
  };
  api.upload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
  );
  const selected = new File(['header upload'], 'header.txt', { type: 'text/plain' });
  await user.upload(input, selected);
  expect(api.upload).toHaveBeenCalledWith(projectId, selected, expect.any(AbortSignal));
  expect(upload).toBeDisabled();
  expect(reload).toBeDisabled();
  await act(async () => finishUpload(file));
  await waitFor(() => expect(reload).toBeEnabled());
  let finishList: (result: FilePage) => void = () => {
    throw Error('No pending list');
  };
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishList = resolve;
      }),
  );
  const reads = api.list.mock.calls.length;
  await user.click(reload);
  expect(api.list).toHaveBeenCalledTimes(reads + 1);
  expect(reload).toBeDisabled();
  await act(async () => finishList(page([file])));
  expect(reload).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'ゴミ箱' }));
  await screen.findByRole('button', { name: 'ファイルを復元: 研究.txt' });
  expect(screen.queryByRole('button', { name: 'ファイルをアップロード' })).toBeNull();
  expect(screen.getByRole('button', { name: 'ごみ箱を空にする' })).toBeEnabled();
  expect(reload).toBeEnabled();
  view.rerender(component(projectId, 'en'));
  expect(screen.getByRole('button', { name: 'Empty trash' })).toHaveAttribute(
    'title',
    'Empty trash',
  );
  await user.click(screen.getByRole('button', { name: 'Back to files' }));
  await screen.findByRole('button', { name: 'Open file: 研究.txt' });
  expect(screen.getByRole('button', { name: 'Upload files' })).toHaveAttribute(
    'title',
    'Upload files',
  );
  expect(screen.getByRole('button', { name: 'Reload file list' })).toHaveAttribute(
    'title',
    'Reload file list',
  );
  expect(screen.getByLabelText('File to upload')).not.toBeVisible();
});

/** @id TEST-FTP-001 @verifies REQ-FTP-001 */
it('TEST-FTP-001 confirms empty trash, reconciles success/errors and fences project changes', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const trashFile = { ...file, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'trashed.txt' };
  await screen.findByRole('heading', { name: 'Project A' });
  let trash = [trashFile];
  f.files.list.mockImplementation(async (_project, _cursor, _signal, trashed) => ({
    ...page(trashed ? trash : [file]),
    usedBytes: file.size + trash.reduce((sum, item) => sum + item.size, 0),
  }));
  expect(screen.queryByRole('button', { name: 'ごみ箱を空にする' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'ゴミ箱' }));
  await screen.findByRole('button', { name: 'ファイルを復元: trashed.txt' });
  const empty = screen.getByRole('button', { name: 'ごみ箱を空にする' });
  expect(screen.queryByRole('button', { name: 'ファイルをアップロード' })).toBeNull();
  await user.click(empty);
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('この操作は取り消せません。');
  await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
  expect(f.files.emptyTrash).not.toHaveBeenCalled();
  expect(empty).toHaveFocus();
  let finish: () => void = () => {
    throw Error('No pending empty-trash');
  };
  f.files.emptyTrash.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(empty);
  await user.click(screen.getByRole('button', { name: '完全に削除する' }));
  expect(f.files.emptyTrash).toHaveBeenCalledExactlyOnceWith(
    f.projects[0]!.id,
    expect.any(AbortSignal),
  );
  expect(empty).toBeDisabled();
  expect(screen.getByRole('button', { name: 'ファイル一覧を再読み込み' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'ファイルを復元: trashed.txt' })).toBeDisabled();
  trash = [];
  await act(async () => finish());
  await screen.findByText('ごみ箱のファイルを完全削除しました。');
  expect(empty).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'ファイルを復元: trashed.txt' })).toBeNull();
  trash = [trashFile];
  await user.click(screen.getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  await screen.findByRole('button', { name: 'ファイルを復元: trashed.txt' });
  f.files.emptyTrash.mockRejectedValueOnce(new ApiError(503, 'Partial deletion: retry'));
  await user.click(empty);
  await user.click(screen.getByRole('button', { name: '完全に削除する' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Partial deletion: retry');
  expect(screen.queryByText('ごみ箱のファイルを完全削除しました。')).toBeNull();
  expect(screen.getByRole('button', { name: 'ファイルを復元: trashed.txt' })).toBeVisible();
  await waitFor(() => expect(empty).toBeEnabled());
  f.files.emptyTrash.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(empty);
  await user.click(screen.getByRole('button', { name: '完全に削除する' }));
  const signal = f.files.emptyTrash.mock.calls.at(-1)?.[1];
  await user.click(screen.getByRole('button', { name: 'Project B' }));
  expect(signal?.aborted).toBe(true);
  await screen.findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'ファイルを開く: 研究.txt' })).toBeVisible();
  expect(screen.queryByText('ごみ箱のファイルを完全削除しました。')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

/** @id TEST-FEX-001 @verifies REQ-FEX-001 */
it('TEST-FEX-001 shows sorted filename-only rows and opens actions separately from the central viewer', async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Project A' });
  const explorer = await screen.findByRole('region', { name: 'ファイルエクスプローラー' });
  const items = [
    { ...file, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'zulu.txt' },
    { ...file, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'alpha.txt' },
    { ...file, name: 'Alpha.txt' },
  ];
  f.files.list.mockResolvedValueOnce(page(items, 'page-two'));
  await user.click(within(explorer).getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  await screen.findByRole('button', { name: 'ファイルを開く: Alpha.txt' });
  const rows = within(explorer).getAllByRole('listitem');
  expect(
    rows.map((row) => within(row).getByRole('button', { name: /^ファイルを開く:/ }).textContent),
  ).toEqual(['Alpha.txt', 'alpha.txt', 'zulu.txt']);
  expect(rows.map((row) => row.textContent)).toEqual(['Alpha.txt', 'alpha.txt', 'zulu.txt']);
  expect(items.map((item) => item.name)).toEqual(['zulu.txt', 'alpha.txt', 'Alpha.txt']);
  expect(within(explorer).queryByRole('button', { name: /^ファイルをダウンロード:/ })).toBeNull();
  const actions = within(rows[0]!).getByRole('button', { name: 'ファイル操作: Alpha.txt' });
  actions.focus();
  await user.keyboard('{ArrowDown}');
  expect(await screen.findByRole('menuitem', { name: 'ダウンロード' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '削除' })).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'Alpha.txt' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(actions).toHaveFocus();
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:verified-download');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe('Alpha.txt');
    expect(this.href).toBe('blob:verified-download');
  });
  await user.click(actions);
  await user.click(screen.getByRole('menuitem', { name: 'ダウンロード' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(f.files.content).toHaveBeenLastCalledWith(
    f.projects[0]!.id,
    items[2],
    expect.any(AbortSignal),
  );
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-download'));
  expect(screen.queryByRole('tab', { name: 'Alpha.txt' })).toBeNull();
  await user.click(within(rows[0]!).getByRole('button', { name: 'ファイルを開く: Alpha.txt' }));
  expect(await screen.findByRole('tab', { name: 'Alpha.txt' })).toHaveAttribute(
    'data-state',
    'active',
  );
  expect(
    within(screen.getByRole('group', { name: '中央ペイン' })).getByText('Alpha.txt', {
      selector: 'h2',
    }),
  ).toBeVisible();
  f.files.list.mockResolvedValueOnce(
    page([{ ...file, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Beta.txt' }]),
  );
  await user.click(within(explorer).getByRole('button', { name: 'さらにファイルを読み込む' }));
  await screen.findByRole('button', { name: 'ファイルを開く: Beta.txt' });
  expect(
    within(explorer)
      .getAllByRole('listitem')
      .map((row) => row.textContent),
  ).toEqual(['Alpha.txt', 'alpha.txt', 'Beta.txt', 'zulu.txt']);
});

/** @id TEST-FEX-003 @verifies REQ-FEX-003 */
it('TEST-FEX-003 trashes only after success, closes its tab, restores from trash and fences old requests', async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Project A' });
  const explorer = await screen.findByRole('region', { name: 'ファイルエクスプローラー' });
  const open = await within(explorer).findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  await user.click(open);
  let rejectWrite: (cause: unknown) => void = () => {
    throw Error('No write');
  };
  f.files.setTrashed.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  await user.click(within(explorer).getByRole('button', { name: 'ファイル操作: 研究.txt' }));
  await user.click(screen.getByRole('menuitem', { name: '削除' }));
  expect(open).toBeVisible();
  expect(screen.getByRole('tab', { name: '研究.txt' })).toBeVisible();
  expect(within(explorer).getByRole('button', { name: 'ゴミ箱' })).toBeDisabled();
  await act(async () => rejectWrite(new ApiError(503, 'Retry trash')));
  expect(await within(explorer).findByRole('alert')).toHaveTextContent('Retry trash');
  expect(open).toBeVisible();
  expect(screen.getByRole('tab', { name: '研究.txt' })).toBeVisible();
  let finishList: (result: FilePage) => void = () => {
    throw Error('No list');
  };
  f.files.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishList = resolve;
      }),
  );
  await user.click(within(explorer).getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  const oldList = f.files.list.mock.calls.at(-1)?.[2];
  await user.click(within(explorer).getByRole('button', { name: 'ファイル操作: 研究.txt' }));
  await user.click(screen.getByRole('menuitem', { name: '削除' }));
  await waitFor(() =>
    expect(within(explorer).queryByRole('button', { name: 'ファイルを開く: 研究.txt' })).toBeNull(),
  );
  expect(oldList?.aborted).toBe(true);
  expect(screen.queryByRole('tab', { name: '研究.txt' })).toBeNull();
  await act(async () => finishList(page([file])));
  expect(within(explorer).queryByRole('button', { name: 'ファイルを開く: 研究.txt' })).toBeNull();
  f.files.list.mockResolvedValueOnce(page([file]));
  await user.click(within(explorer).getByRole('button', { name: 'ゴミ箱' }));
  const restore = await within(explorer).findByRole('button', { name: 'ファイルを復元: 研究.txt' });
  expect(f.files.list).toHaveBeenLastCalledWith(
    f.projects[0]!.id,
    undefined,
    expect.any(AbortSignal),
    true,
  );
  expect(within(explorer).queryByRole('button', { name: 'ファイルを開く: 研究.txt' })).toBeNull();
  await user.click(restore);
  await waitFor(() => expect(restore).not.toBeInTheDocument());
  expect(f.files.setTrashed).toHaveBeenLastCalledWith(
    f.projects[0]!.id,
    file.id,
    false,
    expect.any(AbortSignal),
  );
  f.files.list.mockResolvedValueOnce(page([file]));
  await user.click(within(explorer).getByRole('button', { name: 'ファイルに戻る' }));
  await within(explorer).findByRole('button', { name: 'ファイルを開く: 研究.txt' });
  expect(screen.queryByRole('tab', { name: '研究.txt' })).toBeNull();
  let finishWrite: () => void = () => {
    throw Error('No late write');
  };
  f.files.setTrashed.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
  );
  await user.click(within(explorer).getByRole('button', { name: 'ファイル操作: 研究.txt' }));
  await user.click(screen.getByRole('menuitem', { name: '削除' }));
  const oldWrite = f.files.setTrashed.mock.calls.at(-1)?.[3];
  await user.click(screen.getByRole('button', { name: 'Project B' }));
  expect(oldWrite?.aborted).toBe(true);
  const nextExplorer = screen.getByRole('region', { name: 'ファイルエクスプローラー' });
  await user.click(
    await within(nextExplorer).findByRole('button', { name: 'ファイルを開く: 研究.txt' }),
  );
  await act(async () => finishWrite());
  expect(screen.getByRole('tab', { name: '研究.txt' })).toHaveAttribute('data-state', 'active');
  expect(
    within(nextExplorer).getByRole('button', { name: 'ファイルを開く: 研究.txt' }),
  ).toBeVisible();
  f.files.setTrashed.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
  );
  await user.click(within(nextExplorer).getByRole('button', { name: 'ファイル操作: 研究.txt' }));
  await user.click(screen.getByRole('menuitem', { name: '削除' }));
  await act(async () => {
    f.switchAccount();
    rejectWrite(new ApiError(401, 'Old account'));
  });
  await screen.findByRole('heading', { name: 'Project A' });
  expect(screen.getByRole('button', { name: 'サインアウト' })).toBeVisible();
});

/** @id TEST-SVC-005 @verifies REQ-SVC-007 */
it('TEST-SVC-005 integrates the actual explorer and tabs, paginates/uploads and fences old-scope requests', async () => {
  const f = fixture(),
    user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Project A' });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'ファイルを開く: 研究.txt' })).toBeInTheDocument(),
  );
  const explorer = screen.getByRole('region', { name: 'ファイルエクスプローラー' });
  await user.click(within(explorer).getByRole('button', { name: 'ファイルを開く: 研究.txt' }));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'AIチャット',
    'Notebook',
    '研究.txt',
  ]);
  expect(
    await screen.findByText('研究 <script>window.bad=true</script>', { exact: false }),
  ).toBeVisible();
  await user.click(within(explorer).getByRole('button', { name: 'ファイルを開く: 研究.txt' }));
  expect(screen.getAllByRole('tab', { name: '研究.txt' })).toHaveLength(1);
  const reads = f.files.content.mock.calls.length;
  f.files.list.mockResolvedValueOnce(page([{ ...file, name: 'renamed.txt' }]));
  await user.click(within(explorer).getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  await user.click(await screen.findByRole('button', { name: 'ファイルを開く: renamed.txt' }));
  expect(screen.getAllByRole('tab', { name: 'renamed.txt' })).toHaveLength(1);
  expect(f.files.content).toHaveBeenCalledTimes(reads);
  const added = { ...file, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'new.csv' };
  f.files.list.mockResolvedValueOnce(page([file, added], 'next-page'));
  await user.click(within(explorer).getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  await screen.findByRole('button', { name: 'さらにファイルを読み込む' });
  f.files.list.mockResolvedValueOnce(
    page([{ ...added, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'last.json' }]),
  );
  await user.click(screen.getByRole('button', { name: 'さらにファイルを読み込む' }));
  expect(f.files.list).toHaveBeenLastCalledWith(
    f.projects[0]!.id,
    'next-page',
    expect.any(AbortSignal),
  );
  const chosen = new File(['a,b\n1,2'], 'new.csv', { type: 'text/csv' });
  await user.upload(within(explorer).getByLabelText('アップロードするファイル'), chosen);
  expect(f.files.upload).toHaveBeenCalledWith(f.projects[0]!.id, chosen, expect.any(AbortSignal));
  let finish: (result: ProjectFile) => void = () => {
    throw Error('Missing pending upload');
  };
  f.files.upload.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.upload(
    within(explorer).getByLabelText('アップロードするファイル'),
    new File(['late'], 'late.txt'),
  );
  const oldSignal = f.files.upload.mock.calls.at(-1)?.[2];
  await user.click(screen.getByRole('button', { name: 'Project B' }));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish({ ...added, name: 'late.txt' }));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'AIチャット',
    'Notebook',
  ]);
  expect(
    screen.queryByRole('button', { name: 'ファイルを開く: late.txt' }),
  ).not.toBeInTheDocument();
  let finishList: (result: FilePage) => void = () => {
    throw Error('Missing pending list');
  };
  f.files.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishList = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'ファイル一覧を再読み込み' }));
  const oldListSignal = f.files.list.mock.calls.at(-1)?.[2];
  f.switchAccount();
  expect(oldListSignal?.aborted).toBe(true);
  await act(async () => finishList(page([{ ...file, name: 'old-owner.txt' }])));
  expect(
    screen.queryByRole('button', { name: 'ファイルを開く: old-owner.txt' }),
  ).not.toBeInTheDocument();
});
const viewer = (api: FilesApi, metadata = file, language: 'ja' | 'en' = 'ja') => (
  <FileViewer
    scopeKey="alice:project"
    projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    file={metadata}
    api={api}
    t={(text) => translate(language, text)}
    onAuthenticationError={() => {}}
  />
);
/** @id TEST-SVC-006 @verifies REQ-SVC-008 */
it('TEST-SVC-006 displays escaped UTF8 and inert bounded images, rejects active SVG and refuses limits before fetch', async () => {
  const api = fileApi(),
    view = render(viewer(api));
  await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
  await waitFor(() =>
    expect(document.querySelector('pre')).toHaveTextContent(
      '研究 <script>window.bad=true</script>',
    ),
  );
  expect(document.querySelector('pre script')).toBeNull();
  view.rerender(viewer(api, { ...file, name: 'renamed.txt' }, 'en'));
  expect(api.content).toHaveBeenCalledTimes(1);
  expect(screen.getByText('renamed.txt')).toBeVisible();
  view.unmount();
  const markdownBytes = new TextEncoder().encode('## Markdown heading\n\n**Rendered** text');
  api.content.mockResolvedValueOnce(markdownBytes);
  const markdown = render(
    viewer(api, {
      ...file,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      name: 'research.md',
      size: markdownBytes.length,
    }),
  );
  await waitFor(() => expect(api.content).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(screen.queryByRole('heading', { name: 'Markdown heading', level: 2 })).not.toBeNull();
  expect(markdown.container.querySelector('strong')).toHaveTextContent('Rendered');
  markdown.unmount();
  for (const [kind, size] of [
    ['text', 1000001],
    ['svg', 1000001],
    ['png', 10000001],
  ] as const) {
    const limited = fileApi(),
      v = render(viewer(limited, { ...file, kind, size }));
    await screen.findByRole('alert');
    expect(limited.content).not.toHaveBeenCalled();
    v.unmount();
  }
  const invalid = fileApi();
  invalid.content.mockResolvedValue(new Uint8Array([0xff, 0xff]));
  const iv = render(viewer(invalid));
  await screen.findByRole('alert');
  invalid.content.mockRejectedValueOnce(new Error('Synthetic download failure'));
  await userEvent.setup().click(screen.getByRole('button', { name: 'ダウンロード' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('ファイル操作に失敗しました'),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('UTF-8');
  iv.unmount();
  const metric = fileApi();
  metric.content.mockResolvedValue(
    new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm"/>',
    ),
  );
  const metricView = render(viewer(metric, { ...file, kind: 'svg', name: 'metric.svg' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('SVGの寸法指定に対応していません');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  metricView.unmount();
  const badSvg = [
    '<svg width="2" height="2"><script>alert(1)</script></svg>',
    '<svg width="2" height="2" onload="alert(1)"/>',
    '<svg width="2" height="2"><foreignObject><p>HTML</p></foreignObject></svg>',
    '<svg width="2" height="2"><image href="https://example.invalid/x.png"/></svg>',
    '<svg width="2" height="2"><use href="https://example.invalid/x.svg#x"/></svg>',
    '<svg width="2" height="2"><style>@import "https://example.invalid/x.css";</style></svg>',
    '<svg width="2" height="2"><rect style="fill:url(https://example.invalid/x)"/></svg>',
    String.raw`<svg width="2" height="2"><rect fill="u\72l(https://example.invalid/x)"/></svg>`,
    '<!DOCTYPE svg [<!ENTITY x "x">]><svg width="2" height="2"/>',
    '<svg width="1000000" height="1000000"/>',
    '<svg width="2" height="2" viewBox="0,,0,2,2"/>',
    '<svg width="2" height="2" viewBox="0 0 0x2 2"/>',
    '<svg/>',
  ];
  for (const source of badSvg) {
    const xml = source.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const unsafe = fileApi();
    unsafe.content.mockResolvedValue(new TextEncoder().encode(xml));
    const v = render(viewer(unsafe, { ...file, kind: 'svg', name: 'image.svg', size: xml.length }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    v.unmount();
  }
  const safeSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><style>rect{fill:red}</style><defs><path id="p" d="M0 0h2v2H0z"/></defs><use href="#p"/></svg>';
  for (const xml of [
    safeSvg,
    safeSvg.replace('height="2"', 'height="2" viewBox="0 0 2 2"'),
    safeSvg.replace('width="2" height="2"', 'viewBox="0,0,2e0,2E+0"'),
  ]) {
    const safe = fileApi();
    safe.content.mockResolvedValue(new TextEncoder().encode(xml));
    const sv = render(viewer(safe, { ...file, kind: 'svg', name: 'safe.svg', size: xml.length }));
    const image = await screen.findByRole('img', { name: 'safe.svg' });
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    fireEvent.load(image);
    sv.unmount();
  }
  const huge = Buffer.from('89504e470d0a1a0a0000000d494844520000138800001388', 'hex');
  const hugeApi = fileApi();
  hugeApi.content.mockResolvedValue(huge);
  const pv = render(viewer(hugeApi, { ...file, kind: 'png', name: 'huge.png', size: huge.length }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  pv.unmount();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngApi = fileApi();
  pngApi.content.mockResolvedValue(png);
  const validPng = render(
    viewer(pngApi, { ...file, kind: 'png', name: 'valid.png', size: png.length }),
  );
  const decoded = await screen.findByRole('img', { name: 'valid.png' });
  expect(decoded.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  fireEvent.load(decoded);
  validPng.unmount();
});
/** @id TEST-SVC-007 @verifies REQ-SVC-009 */
it('TEST-SVC-007 renders bounded PDF pages with dedicated inert workers and tears down on close/error/timeout', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      terminate = pdf.terminate;
    },
  );
  pdf.loadingDestroy.mockResolvedValue(undefined);
  pdf.render.mockReturnValue({ promise: Promise.resolve(), cancel: pdf.cancel });
  pdf.getPage.mockImplementation(async () => ({
    getViewport: () => ({ width: 200, height: 100 }),
    render: pdf.render,
    cleanup: pdf.cleanup,
  }));
  const document = { numPages: 2, getPage: pdf.getPage };
  pdf.load.mockReturnValue({ promise: Promise.resolve(document), destroy: pdf.loadingDestroy });
  const api = fileApi();
  const metadata = { ...file, name: 'document.pdf', kind: 'pdf' as const, size: bytes.length };
  const view = render(viewer(api, metadata));
  await waitFor(() => expect(pdf.load).toHaveBeenCalled());
  expect(pdf.load.mock.calls.at(-1)?.[0]).toMatchObject({
    enableXfa: false,
    useWasm: false,
    disableFontFace: true,
    useWorkerFetch: false,
  });
  await waitFor(() => expect(pdf.render).toHaveBeenCalled());
  await userEvent.setup().click(screen.getByRole('button', { name: '次のページ' }));
  expect(pdf.getPage).toHaveBeenLastCalledWith(2);
  const workerLoads = pdf.load.mock.calls.length;
  const localeTerminations = pdf.terminate.mock.calls.length;
  view.rerender(viewer(api, metadata, 'en'));
  expect(api.content).toHaveBeenCalledTimes(1);
  expect(pdf.load).toHaveBeenCalledTimes(workerLoads);
  expect(pdf.terminate).toHaveBeenCalledTimes(localeTerminations);
  view.unmount();
  await waitFor(() => expect(pdf.loadingDestroy).toHaveBeenCalled());
  expect(pdf.workerDestroy).toHaveBeenCalled();
  expect(pdf.terminate).toHaveBeenCalled();
  const limited = fileApi(),
    lv = render(viewer(limited, { ...metadata, size: 25000001 }));
  await screen.findByRole('alert');
  expect(limited.content).not.toHaveBeenCalled();
  lv.unmount();
  pdf.render.mockClear();
  pdf.load.mockReturnValueOnce({
    promise: Promise.resolve({ ...document, numPages: 201 }),
    destroy: pdf.loadingDestroy,
  });
  const pages = render(viewer(fileApi(), metadata));
  await screen.findByRole('alert');
  expect(pdf.render).not.toHaveBeenCalled();
  pages.unmount();
  pdf.getPage.mockResolvedValueOnce({
    getViewport: () => ({ width: 100000, height: 100000 }),
    render: pdf.render,
    cleanup: pdf.cleanup,
  });
  const huge = render(viewer(fileApi(), metadata));
  await screen.findByRole('alert');
  expect(pdf.render).not.toHaveBeenCalled();
  huge.unmount();
  pdf.load.mockImplementationOnce(() => ({
    promise: Promise.reject(Object.assign(new Error('protected'), { name: 'PasswordException' })),
    destroy: pdf.loadingDestroy,
  }));
  const encrypted = render(viewer(fileApi(), metadata));
  await screen.findByRole('alert');
  encrypted.unmount();
  const calls = pdf.load.mock.calls.length;
  pdf.load.mockReturnValueOnce({ promise: new Promise(() => {}), destroy: pdf.loadingDestroy });
  vi.useFakeTimers();
  const stalled = render(viewer(fileApi(), metadata));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(pdf.load).toHaveBeenCalledTimes(calls + 1);
  const destroyed = pdf.loadingDestroy.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('30秒');
  expect(pdf.loadingDestroy).toHaveBeenCalledTimes(destroyed + 1);
  stalled.unmount();
  let rejectRender: (error: Error) => void = () => {
    throw new Error('Render task was not started');
  };
  const renderCancel = vi.fn(() => rejectRender(new Error('Rendering cancelled')));
  pdf.render.mockReturnValueOnce({
    promise: new Promise((_, reject) => {
      rejectRender = reject;
    }),
    cancel: renderCancel,
  });
  const pageStalled = render(viewer(fileApi(), metadata));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const beforeRenderTimeout = pdf.loadingDestroy.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('30秒');
  expect(renderCancel).toHaveBeenCalled();
  expect(pdf.loadingDestroy).toHaveBeenCalledTimes(beforeRenderTimeout + 1);
  pageStalled.unmount();
  vi.useRealTimers();
});
