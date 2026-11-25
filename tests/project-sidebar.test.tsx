// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import type { BrowserAuth, UserAccount } from '../src/client/auth';
import type { ProjectsApi } from '../src/client/api';
import { ApiError } from '../src/client/api';
import type { Project } from '../src/shared/contracts';
import type { FilesApi } from '../src/client/files-api';
import type { ProjectPinsApi } from '../src/client/project-pins-api';
import { ProjectPinsUnavailable } from '../src/client/project-pins-api';
import { createProjectOrderApi } from '../src/client/project-order-api';
import { ResizableWorkspace } from '../src/client/components/resizable-workspace';
import { createProjectManagementApi } from '../src/client/project-management-api';
import type { ManagedProject, ProjectManagementApi } from '../src/client/project-management-api';
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/test-only-pdf-worker.mjs',
}));

const pointerMethods = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'] as const;
const originalPointerMethods = pointerMethods.map((key) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pointerMethods.forEach((key, index) => {
    const descriptor = originalPointerMethods[index];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  });
});
const alpha: Project = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Alpha',
  version: 1,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
};
const beta: Project = {
  ...alpha,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Beta',
  updatedAt: '2026-11-13T00:00:00.000Z',
};
function fixture() {
  let account: UserAccount = { id: 'alice', name: 'Synthetic owner' };
  let notify = () => {};
  let pinned = [alpha.id];
  const auth: BrowserAuth = {
    account: () => account,
    signIn: async () => account,
    signOut: async () => {},
    accessToken: async () => 'unit-only',
    invalidate: vi.fn(),
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const api: ProjectsApi = {
    list: vi.fn(async () =>
      account.id === 'alice'
        ? [beta, alpha]
        : [{ ...beta, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Other owned project' }],
    ),
    create: vi.fn(async (name) => ({
      ...alpha,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name,
      updatedAt: '2026-11-14T00:00:00.000Z',
    })),
    rename: vi.fn(async (project, name) => ({ ...project, name, version: project.version + 1 })),
  };
  const pinsApi: ProjectPinsApi = {
    list: vi.fn(async () => (account.id === 'alice' ? [...pinned] : [])),
    set: vi.fn(async (id, value) => {
      pinned = value
        ? [id, ...pinned.filter((item) => item !== id)]
        : pinned.filter((item) => item !== id);
      return [...pinned];
    }),
  };
  return {
    auth,
    api,
    pinsApi,
    managementApi: undefined as ProjectManagementApi | undefined,
    switchAccount: () => {
      account = { id: 'bob', name: 'Other owner' };
      notify();
    },
    acknowledge: (ids: string[]) => {
      pinned = ids;
    },
    refreshAccount: () => notify(),
  };
}

function managementTransport(f: ReturnType<typeof fixture>, enabled = true) {
  f.managementApi = createProjectManagementApi(f.auth);
  const records: { project: Project; description: string; trashedAt: string | null }[] = [
    alpha,
    beta,
  ].map((project) => ({
    project,
    description: '',
    trashedAt: null,
  }));
  const requests: { path: string; method: string; body: unknown; version: string | null }[] = [];
  f.api.list = vi.fn(async () =>
    records.filter((item) => item.trashedAt === null).map((item) => item.project),
  );
  let delay:
    ((path: string, method: string, body: unknown) => Promise<Response> | undefined) | undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      input instanceof Request ? input : new URL(input.toString(), window.location.origin),
      init,
    );
    const path = new URL(request.url, window.location.origin).pathname;
    const body: unknown = request.method === 'GET' ? undefined : await request.json();
    requests.push({ path, method: request.method, body, version: request.headers.get('If-Match') });
    const waiting = delay?.(path, request.method, body);
    if (waiting) return waiting;
    if (path === '/api/project-management/capabilities') return Response.json({ enabled });
    if (path === '/api/project-order/capabilities') return Response.json({ enabled: false });
    if (path === '/api/settings/text-size')
      return Response.json(
        {
          error: {
            code: 'TEXT_SIZE_UNAVAILABLE',
            message: 'Text size disabled.',
            requestId: 'fixture',
          },
        },
        { status: 503 },
      );
    if (!enabled)
      return Response.json(
        {
          error: {
            code: 'PROJECT_MANAGEMENT_UNAVAILABLE',
            message: 'Management disabled.',
            requestId: 'fixture',
          },
        },
        { status: 503 },
      );
    if (path === '/api/project-management/trash')
      return Response.json({
        items: records.filter((item) => item.trashedAt !== null),
      });
    if (path === '/api/project-management/projects' && request.method === 'POST') {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('name' in body) ||
        typeof body.name !== 'string' ||
        !('description' in body) ||
        typeof body.description !== 'string'
      )
        throw new Error('Invalid fixture create.');
      const created = {
        project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: body.name },
        description: body.description,
        trashedAt: null,
      };
      records.push(created);
      return Response.json(created, { status: 201 });
    }
    const match = /^\/api\/project-management\/projects\/([^/]+)(?:\/(trash|restore))?$/.exec(path);
    const record = records.find((item) => item.project.id === match?.[1]);
    if (!record) throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
    if (request.method === 'GET') return Response.json(record);
    if (request.headers.get('If-Match') !== `"${record.project.version}"`)
      return Response.json(
        {
          error: { code: 'VERSION_CONFLICT', message: 'Synthetic conflict.', requestId: 'fixture' },
        },
        { status: 409 },
      );
    if (request.method === 'PATCH') {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('name' in body) ||
        typeof body.name !== 'string' ||
        !('description' in body) ||
        typeof body.description !== 'string'
      )
        throw new Error('Invalid fixture patch.');
      record.project = { ...record.project, name: body.name };
      record.description = body.description;
    } else {
      record.trashedAt = match?.[2] === 'trash' ? '2026-11-14T00:00:00.000Z' : null;
    }
    record.project = { ...record.project, version: record.project.version + 1 };
    return Response.json(record);
  });
  vi.stubGlobal('fetch', transport);
  return {
    requests,
    transport,
    delay: (callback: typeof delay) => {
      delay = callback;
    },
    records,
  };
}

async function openProjectMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `プロジェクト設定: ${name}` }));
  return screen.findByRole('menu');
}

async function openProjectSettings(user: ReturnType<typeof userEvent.setup>, name: string) {
  const menu = await openProjectMenu(user, name);
  await user.click(within(menu).getByRole('menuitem', { name: 'プロジェクト設定' }));
  return screen.findByRole('dialog', { name: 'プロジェクト設定' });
}

async function openProjectArchive(user: ReturnType<typeof userEvent.setup>, name: string) {
  const menu = await openProjectMenu(user, name);
  await user.click(within(menu).getByRole('menuitem', { name: 'アーカイブ' }));
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(screen.queryByRole('alertdialog', { hidden: true })).toBeNull();
}

/** @id TEST-DLG-001 @verifies REQ-DLG-001 */
it('TEST-DLG-001 creates only acknowledged name/description through a cancellable labelled modal', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(<App {...f} />);
  await screen.findByRole('button', { name: 'Alpha' });
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  expect(screen.queryByRole('dialog', { name: '新しいプロジェクト' })).not.toBeNull();
  const dialog = screen.getByRole('dialog', { name: '新しいプロジェクト' });
  await user.type(within(dialog).getByLabelText('新しいプロジェクト名'), 'Gamma');
  await user.type(within(dialog).getByLabelText('プロジェクトの説明'), 'Plain\nmultiline');
  let finish: (response: Response) => void = () => {
    throw new Error('No pending create.');
  };
  remote.delay((path, method) =>
    path.endsWith('/projects') && method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  await user.click(within(dialog).getByRole('button', { name: 'プロジェクトを作成' }));
  expect(screen.queryByRole('heading', { name: 'Gamma' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'プロジェクトを作成' })).toBeDisabled();
  remote.records.push({
    project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Gamma' },
    description: 'Plain\nmultiline',
    trashedAt: null,
  });
  await act(async () =>
    finish(
      Response.json(
        {
          project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Gamma' },
          description: 'Plain\nmultiline',
          trashedAt: null,
        },
        { status: 201 },
      ),
    ),
  );
  expect(await screen.findByRole('heading', { name: 'Gamma' })).toBeVisible();
  expect(remote.requests.filter((item) => item.method === 'POST')).toEqual([
    expect.objectContaining({ body: { name: 'Gamma', description: 'Plain\nmultiline' } }),
  ]);
  expect(f.api.create).not.toHaveBeenCalled();
  remote.delay(undefined);
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Never created');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '新しいプロジェクト' })).toHaveFocus();
});

/** @id TEST-DLG-002 @verifies REQ-DLG-002 */
it('TEST-DLG-002 opens separate row settings without selecting, and preserves acknowledged data on conflicts', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(<App {...f} />);
  await screen.findByRole('button', { name: 'Alpha' });
  await user.click(screen.getByRole('button', { name: 'Alpha' }));
  await screen.findByRole('heading', { name: 'Alpha' });
  const action = screen.queryByRole('button', { name: 'プロジェクト設定: Beta' });
  expect(action).not.toBeNull();
  if (!action) throw new Error('Missing settings action after assertion.');
  await user.click(action);
  expect(screen.queryByRole('dialog')).toBeNull();
  const menu = await screen.findByRole('menu');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['プロジェクト設定', 'ピン留めする', 'アーカイブ']);
  await user.click(within(menu).getByRole('menuitem', { name: 'プロジェクト設定' }));
  const dialog = await screen.findByRole('dialog', { name: 'プロジェクト設定' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /ピン留め|ごみ箱|アーカイブ/ })).toBeNull();
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '変更を保存' })).toBeEnabled(),
  );
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(screen.getByRole('heading', { name: 'Alpha', hidden: true })).toBeVisible();
  await user.clear(within(dialog).getByLabelText('プロジェクト名'));
  await user.type(within(dialog).getByLabelText('プロジェクト名'), 'Renamed Beta');
  await user.type(within(dialog).getByLabelText('プロジェクトの説明'), 'Description');
  remote.delay((_path, method) =>
    method === 'PATCH'
      ? Promise.resolve(
          Response.json(
            {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Conflict fixture.',
                requestId: 'fixture',
              },
            },
            { status: 409 },
          ),
        )
      : undefined,
  );
  await user.click(within(dialog).getByRole('button', { name: '変更を保存' }));
  expect(await within(dialog).findByRole('alert')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Renamed Beta' })).toBeNull();
  expect(within(dialog).getByLabelText('プロジェクト名')).toHaveValue('Renamed Beta');
  remote.delay(undefined);
  await user.click(within(dialog).getByRole('button', { name: '変更を保存' }));
  expect(await screen.findByRole('button', { name: 'Renamed Beta' })).toBeVisible();
  expect(remote.requests.find((item) => item.method === 'PATCH')).toMatchObject({
    version: '"1"',
    body: { name: 'Renamed Beta', description: 'Description' },
  });
  expect(screen.getByRole('heading', { name: 'Alpha' })).toBeVisible();
});

/** @id TEST-DLG-003 @verifies REQ-DLG-003 */
it('TEST-DLG-003 archives from one menu activation without confirmation, clears selected files after acknowledgement and restores pins', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  const bytes = new TextEncoder().encode('retained');
  const file = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'retained.txt',
    kind: 'text' as const,
    size: bytes.length,
    sha256: '0'.repeat(64),
    createdAt: alpha.createdAt,
  };
  const filesApi: FilesApi = {
    emptyTrash: async () => {
      throw new Error('Test empty trash is not configured.');
    },
    setTrashed: async () => {
      throw new Error('No fixture file trash mutation.');
    },
    list: async () => ({
      items: [file],
      nextCursor: null,
      usedBytes: file.size,
      reservedBytes: 0,
      limitBytes: 10000000000,
    }),
    content: async () => bytes,
    upload: async () => {
      throw new Error('No fixture upload.');
    },
  };
  render(<App {...f} filesApi={filesApi} />);
  await screen.findByRole('button', { name: 'Alpha' });
  const trash = screen.queryByRole('button', { name: 'アーカイブ' });
  expect(trash).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Alpha' }));
  await user.click(await screen.findByRole('button', { name: 'ファイルを開く: retained.txt' }));
  expect(screen.getByRole('tab', { name: 'retained.txt' })).toBeVisible();
  await openProjectArchive(user, 'Alpha');
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull());
  expect(
    remote.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/trash')),
  ).toHaveLength(1);
  expect(screen.queryByRole('tab', { name: 'retained.txt' })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '新しいプロジェクト' })).toHaveFocus(),
  );
  await user.click(screen.getByRole('button', { name: 'アーカイブ' }));
  const dialog = await screen.findByRole('dialog', { name: 'アーカイブ' });
  expect(within(dialog).queryByRole('button', { name: /完全に削除|purge/i })).toBeNull();
  await user.click(await within(dialog).findByRole('button', { name: '復元: Alpha' }));
  await user.keyboard('{Escape}');
  expect(
    await within(screen.getByRole('list', { name: 'ピン留め' })).findByRole('button', {
      name: 'Alpha',
    }),
  ).toBeVisible();
});

/** @id TEST-DLG-004 @verifies REQ-DLG-004 */
it('TEST-DLG-004 fences same-owner new epochs and stale401, traps focus and exposes disabled management separately', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(<App {...f} />);
  await screen.findByRole('button', { name: 'Alpha' });
  for (const [action, acknowledged] of [
    ['ピン留めを外す', 'ピン留めする'],
    ['ピン留めする', 'ピン留めを外す'],
  ]) {
    const menu = await openProjectMenu(user, 'Alpha');
    await user.click(within(menu).getByRole('menuitem', { name: action }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `${acknowledged}: Alpha` })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'プロジェクト設定: Alpha' })).toHaveFocus(),
    );
  }
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  expect(screen.queryByRole('dialog')).not.toBeNull();
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText('新しいプロジェクト名'), 'Old epoch');
  let finish: (response: Response) => void = () => {
    throw new Error('No pending request.');
  };
  remote.delay((_path, method) =>
    method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  await user.click(within(dialog).getByRole('button', { name: 'プロジェクトを作成' }));
  await user.keyboard('{Tab}{Tab}{Tab}{Tab}{Tab}');
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => {
    f.refreshAccount();
    finish(
      Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'Old epoch401', requestId: 'fixture' } },
        { status: 401 },
      ),
    );
  });
  expect(f.auth.invalidate).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Old epoch' })).toBeNull();
  cleanup();
  const disabled = fixture();
  managementTransport(disabled, false);
  render(<App {...disabled} />);
  await screen.findByRole('button', { name: 'Alpha' });
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  expect(await screen.findByLabelText('プロジェクトの説明')).toBeDisabled();
  expect(screen.getByText('プロジェクト設定は現在利用できません。')).toBeVisible();
  await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Legacy name');
  await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
  expect(disabled.api.create).toHaveBeenCalledWith('Legacy name', expect.any(AbortSignal));
});

it('dialog readiness retries failed capability and detail reads without downgrading or disabling independent pins', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  let capabilitiesFail = true,
    detailFail = true;
  remote.delay((path, method) => {
    if (path.endsWith('/capabilities') && capabilitiesFail)
      return Promise.resolve(Response.json({}, { status: 500 }));
    if (path.endsWith(`/projects/${beta.id}`) && method === 'GET' && detailFail)
      return Promise.resolve(Response.json({}, { status: 500 }));
  });
  render(<App {...f} />);
  await user.click(await screen.findByRole('button', { name: 'ピン留めする: Beta' }));
  expect(f.pinsApi.set).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Blocked');
  expect(screen.getByRole('button', { name: 'プロジェクトを作成' })).toBeDisabled();
  expect(screen.queryByText('プロジェクト設定は現在利用できません。')).toBeNull();
  capabilitiesFail = false;
  await user.click(screen.getByRole('button', { name: 'プロジェクト設定を再読み込み' }));
  await waitFor(() => expect(screen.getByLabelText('プロジェクトの説明')).toBeEnabled());
  await user.keyboard('{Escape}');
  await openProjectSettings(user, 'Beta');
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '変更を保存' })).toBeDisabled();
  detailFail = false;
  await user.click(screen.getByRole('button', { name: 'プロジェクト設定を再読み込み' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '変更を保存' })).toBeEnabled());
  await user.keyboard('{Escape}');
  const menu = await openProjectMenu(user, 'Beta');
  await user.click(within(menu).getByRole('menuitem', { name: 'ピン留めを外す' }));
  await waitFor(() =>
    expect(f.pinsApi.set).toHaveBeenLastCalledWith(beta.id, false, expect.any(AbortSignal)),
  );
});

it('direct archive detail failures retain the project and retry inline without any popup', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  let detailFail = true;
  remote.delay((path, method) => {
    if (path.endsWith(`/projects/${beta.id}`) && method === 'GET' && detailFail)
      return Promise.resolve(Response.json({}, { status: 500 }));
  });
  render(<App {...f} />);
  await screen.findByRole('button', { name: 'Beta' });
  await openProjectArchive(user, 'Beta');
  await screen.findByRole('alert');
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(screen.getByRole('button', { name: 'Beta' })).toBeVisible();
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'プロジェクト設定: Beta' })).toHaveFocus(),
  );
  detailFail = false;
  await user.click(screen.getByRole('button', { name: 'アーカイブを再試行' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(1);
});

it('a direct archive detail response from an old session cannot start its write', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  let finish: (response: ManagedProject) => void = () => {
    throw new Error('No pending detail read.');
  };
  const management = f.managementApi;
  if (!management) throw new Error('Missing fixture management client.');
  const get = vi.fn(
    () =>
      new Promise<ManagedProject>((resolve) => {
        finish = resolve;
      }),
  );
  const transition = vi.fn(management.transition);
  f.managementApi = { ...management, get, transition };
  render(<App {...f} />);
  await screen.findByRole('button', { name: 'Beta' });
  await openProjectArchive(user, 'Beta');
  await waitFor(() => expect(get).toHaveBeenCalledWith(beta.id, expect.any(AbortSignal)));
  await act(async () => {
    f.refreshAccount();
    finish({ project: beta, description: '', trashedAt: null });
  });
  expect(transition).not.toHaveBeenCalled();
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  expect(f.auth.invalidate).not.toHaveBeenCalled();
  expect(remote.records.find((item) => item.project.id === beta.id)?.trashedAt).toBeNull();
});

it('dialog validation retains invalid input, accepts Unicode boundaries and reloads a conflict without optimistic selection', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(<App {...f} />);
  await user.click(await screen.findByRole('button', { name: '新しいプロジェクト' }));
  const name = screen.getByLabelText('新しいプロジェクト名');
  const description = screen.getByLabelText('プロジェクトの説明');
  fireEvent.change(name, { target: { value: 'x'.repeat(101) } });
  await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(name).toHaveValue('x'.repeat(101));
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  fireEvent.change(name, { target: { value: '😀'.repeat(100) } });
  fireEvent.change(description, { target: { value: '😀'.repeat(2001) } });
  await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
  expect(remote.requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  fireEvent.change(description, { target: { value: '😀'.repeat(2000) } });
  await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await openProjectSettings(user, 'Beta');
  await waitFor(() => expect(screen.getByRole('button', { name: '変更を保存' })).toBeEnabled());
  remote.records[1]!.project = { ...beta, name: 'Server Beta', version: 2 };
  await user.click(screen.getByRole('button', { name: '変更を保存' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'プロジェクト設定を再読み込み' }));
  await waitFor(() => expect(screen.getByLabelText('プロジェクト名')).toHaveValue('Server Beta'));
  await user.click(screen.getByRole('button', { name: '変更を保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(remote.requests.filter((item) => item.method === 'PATCH').at(-1)?.version).toBe('"2"');
});

it('dialog cancellation aborts pending requests, ignores stale success and restores trigger focus in English', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(
    <App
      {...f}
      preferencesApi={{
        get: async () => ({ language: 'en', theme: 'light' }),
        patch: async () => ({ language: 'en', theme: 'light' }),
      }}
    />,
  );
  const trigger = await screen.findByRole('button', { name: 'New project' });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'New project' });
  await user.type(within(dialog).getByLabelText('New project name'), 'Cancelled');
  let finish: (value: Response) => void = () => {
    throw new Error('Not pending');
  };
  remote.delay((_path, method) =>
    method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
  const request = remote.transport.mock.calls
    .map(
      ([input, init]) =>
        new Request(
          input instanceof Request ? input : new URL(input.toString(), window.location.origin),
          init,
        ),
    )
    .find((item) => item.method === 'POST');
  expect(request?.signal.aborted).toBe(true);
  await act(async () =>
    finish(
      Response.json({
        project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Cancelled' },
        description: '',
        trashedAt: null,
      }),
    ),
  );
  expect(screen.queryByRole('heading', { name: 'Cancelled' })).toBeNull();
  expect(f.auth.invalidate).not.toHaveBeenCalled();
});

it('archive busy errors preserve the project and acknowledgement alone removes it', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const remote = managementTransport(f);
  render(<App {...f} />);
  await user.click(await screen.findByRole('button', { name: 'Alpha' }));
  remote.delay((path) =>
    path.endsWith('/trash')
      ? Promise.resolve(
          Response.json(
            {
              error: { code: 'PROJECT_BUSY', message: 'Fixture busy', requestId: 'fixture' },
            },
            { status: 409 },
          ),
        )
      : undefined,
  );
  await openProjectArchive(user, 'Alpha');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '実行中の処理があるため、アーカイブできません。',
  );
  expect(screen.getByRole('heading', { name: 'Alpha', hidden: true })).toBeInTheDocument();
  let finish: (value: Response) => void = () => {
    throw new Error('Not pending');
  };
  remote.delay((path) =>
    path.endsWith('/trash')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  await user.click(screen.getByRole('button', { name: 'アーカイブを再試行' }));
  await waitFor(() =>
    expect(
      remote.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/trash')),
    ).toHaveLength(2),
  );
  expect(screen.getByRole('heading', { name: 'Alpha', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('アーカイブ中…');
  expect(screen.getByRole('button', { name: 'プロジェクト設定: Alpha' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'プロジェクト設定: Alpha' }));
  expect(
    remote.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/trash')),
  ).toHaveLength(2);
  screen.getByRole('button', { name: 'プロジェクトを検索' }).focus();
  const record = remote.records[0]!;
  record.trashedAt = '2026-11-14T00:00:00.000Z';
  record.project = { ...record.project, version: 2 };
  await act(async () => finish(Response.json(record)));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull());
  expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
  expect(screen.getByRole('button', { name: 'プロジェクトを検索' })).toHaveFocus();
});

it('disabled management preserves legacy rename and explicit archive/pin unavailability', async () => {
  const user = userEvent.setup(),
    f = fixture();
  managementTransport(f, false);
  f.pinsApi.list = vi.fn(async () => {
    throw new ProjectPinsUnavailable();
  });
  render(<App {...f} />);
  await screen.findByText('ピン留めは現在利用できません。');
  const menu = await openProjectMenu(user, 'Alpha');
  expect(within(menu).getByRole('menuitem', { name: 'アーカイブ' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect(within(menu).getByRole('menuitem', { name: 'ピン留めする' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await user.click(within(menu).getByRole('menuitem', { name: 'プロジェクト設定' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '変更を保存' })).toBeEnabled(),
  );
  expect(within(dialog).getByLabelText('プロジェクトの説明')).toBeDisabled();
  expect(within(dialog).queryByRole('button', { name: /ピン留め|ごみ箱|アーカイブ/ })).toBeNull();
  await user.clear(within(dialog).getByLabelText('プロジェクト名'));
  await user.type(within(dialog).getByLabelText('プロジェクト名'), 'Legacy renamed');
  await user.click(within(dialog).getByRole('button', { name: '変更を保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(f.api.rename).toHaveBeenCalledWith(alpha, 'Legacy renamed', expect.any(AbortSignal));
  expect(await screen.findByRole('button', { name: 'Legacy renamed' })).toBeVisible();
});

it.each(['success', '401'] as const)(
  'dialog ignores non-cooperative old-epoch %s without releasing a newer write',
  async (outcome) => {
    const user = userEvent.setup(),
      f = fixture();
    managementTransport(f);
    const pending: {
      resolve: (value: { project: Project; description: string; trashedAt: null }) => void;
      reject: (error: unknown) => void;
      signal: AbortSignal;
    }[] = [];
    f.managementApi = {
      ...f.managementApi!,
      create: async (_name, _description, signal) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject, signal });
        }),
    };
    render(<App {...f} />);
    await user.click(await screen.findByRole('button', { name: '新しいプロジェクト' }));
    await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Old epoch');
    await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
    await act(async () => f.refreshAccount());
    expect(pending[0]!.signal.aborted).toBe(true);
    await user.click(await screen.findByRole('button', { name: '新しいプロジェクト' }));
    await user.type(screen.getByLabelText('新しいプロジェクト名'), 'New epoch');
    await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
    const result = (name: string) => ({
      project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name },
      description: '',
      trashedAt: null,
    });
    await act(async () => {
      if (outcome === 'success') pending[0]!.resolve(result('Old epoch'));
      else pending[0]!.reject(new ApiError(401, 'Old epoch401'));
    });
    expect(f.auth.invalidate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'プロジェクトを作成' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Old epoch', hidden: true })).toBeNull();
    await act(async () => pending[1]!.resolve(result('New epoch')));
    expect(await screen.findByRole('heading', { name: 'New epoch' })).toBeVisible();
    cleanup();
  },
);

it('dialog shares a synchronous write guard with background pins before React rerenders', async () => {
  const user = userEvent.setup(),
    f = fixture();
  managementTransport(f);
  let finish: (value: { project: Project; description: string; trashedAt: null }) => void = () => {
    throw new Error('No pending create');
  };
  const create = vi.fn(
    async () =>
      new Promise<{
        project: Project;
        description: string;
        trashedAt: null;
      }>((resolve) => {
        finish = resolve;
      }),
  );
  f.managementApi = { ...f.managementApi!, create };
  render(<App {...f} />);
  const pin = await screen.findByRole('button', { name: 'ピン留めする: Beta' });
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Guarded');
  const form = screen.getByLabelText('新しいプロジェクト名').closest('form');
  if (!form) throw new Error('Missing create form');
  await act(async () => {
    fireEvent.submit(form);
    fireEvent.click(pin);
    fireEvent.submit(form);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(f.pinsApi.set).not.toHaveBeenCalled();
  await act(async () =>
    finish({
      project: { ...alpha, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Guarded' },
      description: '',
      trashedAt: null,
    }),
  );
  expect(await screen.findByRole('heading', { name: 'Guarded' })).toBeVisible();
});

/** @id TEST-SID-008 @verifies REQ-SID-008 */
it.each([
  { position: 'upper', clientY: 110 },
  { position: 'center', clientY: 120 },
  { position: 'lower', clientY: 130 },
])(
  'TEST-SID-008 reorders both directions onto the $position of a row only after acknowledgement, without selecting or crossing groups',
  async ({ clientY }) => {
    const user = userEvent.setup(),
      f = fixture();
    const gamma = {
      ...beta,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Gamma',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
    f.api.list = vi.fn(async () => [gamma, beta, alpha]);
    let snapshot = { version: 1, pinned: [alpha.id], recent: [gamma.id, beta.id] };
    let finish: (response: Response) => void = () => {
      throw new Error('No pending reorder.');
    };
    const moves: unknown[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
          input instanceof Request ? input : new URL(input.toString(), window.location.origin),
          init,
        ),
        path = new URL(request.url, window.location.origin).pathname;
      if (path === '/api/project-order/capabilities') return Response.json({ enabled: true });
      if (path === '/api/project-management/capabilities') return Response.json({ enabled: false });
      if (path === '/api/settings/text-size')
        return Response.json(
          {
            error: { code: 'TEXT_SIZE_UNAVAILABLE', message: 'Disabled', requestId: 'fixture' },
          },
          { status: 503 },
        );
      if (path !== '/api/project-order') throw new Error(`Unexpected fixture ${path}`);
      if (request.method === 'GET') return Response.json(snapshot);
      moves.push(await request.json());
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal('fetch', transport);
    render(<App {...f} orderApi={createProjectOrderApi(f.auth)} />);
    await screen.findByRole('button', { name: 'Gamma' });
    expect(screen.queryAllByRole('button', { name: /上へ移動|下へ移動/ })).toHaveLength(0);
    const recent = () => screen.getByRole('list', { name: '最近のプロジェクト' });
    const names = () =>
      within(recent())
        .getAllByRole('button', { name: /^(Beta|Gamma)$/ })
        .map((node) => node.textContent);
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      clearData: () => data.clear(),
      effectAllowed: 'move',
      dropEffect: 'move',
      get types() {
        return [...data.keys()];
      },
    };
    const handle = (name: string) => screen.getByRole('button', { name: `並べ替え: ${name}` });
    const row = (name: string) => {
      const target = screen.getByRole('button', { name }).closest('li');
      if (!target) throw new Error('No drop row.');
      return target;
    };
    const dropOn = (name: string) => {
      const target = row(name);
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40));
      const drop = createEvent.drop(target, { dataTransfer });
      Object.defineProperty(drop, 'clientY', { value: clientY });
      fireEvent(target, drop);
    };
    await waitFor(() => expect(handle('Beta')).toBeEnabled());
    expect(handle('Beta')).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.drop(row('Alpha'), { dataTransfer });
    expect(moves).toEqual([]);
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.drop(row('Beta'), { dataTransfer });
    expect(moves).toEqual([]);
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.dragEnd(handle('Beta'));
    fireEvent.drop(row('Gamma'), { dataTransfer });
    expect(moves).toEqual([]);
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.dragOver(row('Gamma'), { dataTransfer });
    dropOn('Gamma');
    expect(names()).toEqual(['Gamma', 'Beta']);
    expect(screen.getByRole('heading', { name: 'Gamma' })).toBeVisible();
    expect(handle('Beta')).toBeDisabled();
    snapshot = { ...snapshot, version: 2, recent: [beta.id, gamma.id] };
    await waitFor(() => expect(moves).toHaveLength(1));
    await act(async () => finish(Response.json(snapshot)));
    expect(names()).toEqual(['Beta', 'Gamma']);
    expect(moves).toEqual([{ group: 'recent', projectId: beta.id, beforeId: gamma.id }]);
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.dragOver(row('Gamma'), { dataTransfer });
    dropOn('Gamma');
    expect(names()).toEqual(['Beta', 'Gamma']);
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1]).toEqual({ group: 'recent', projectId: beta.id, beforeId: null });
    snapshot = { ...snapshot, version: 3, recent: [gamma.id, beta.id] };
    await act(async () => finish(Response.json(snapshot)));
    expect(names()).toEqual(['Gamma', 'Beta']);
    expect(screen.getByRole('heading', { name: 'Gamma' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'プロジェクトを検索' }));
    await user.type(screen.getByRole('searchbox'), 'Beta');
    expect(screen.getByRole('button', { name: '並べ替え: Beta' })).toBeDisabled();
    expect(screen.getByText('検索中は並べ替えできません。')).toBeVisible();
    fireEvent.dragStart(handle('Beta'), { dataTransfer });
    fireEvent.drop(row('Beta'), { dataTransfer });
    expect(moves).toHaveLength(2);
  },
);
/** @id TEST-SID-004 @verifies REQ-SID-003 REQ-SID-004 */
it('TEST-SID-004 searches stable groups, waits for server pins and rejects failed or old-session updates', async () => {
  const user = userEvent.setup();
  const f = fixture();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  let view = render(<App {...f} />);
  await screen.findByRole('button', { name: 'Beta' });
  expect(screen.queryByRole('button', { name: 'プロジェクトを検索' })).not.toBeNull();
  const pinned = () => screen.getByRole('list', { name: 'ピン留め' });
  const recent = () => screen.getByRole('list', { name: '最近のプロジェクト' });
  expect(await within(pinned()).findByRole('button', { name: 'Alpha' })).toBeVisible();
  expect(within(recent()).queryByRole('button', { name: 'Alpha' })).toBeNull();
  for (const [name, pinAction] of [
    ['Alpha', 'ピン留めを外す'],
    ['Beta', 'ピン留めする'],
  ]) {
    const row = screen.getByRole('button', { name }).closest('li');
    if (!row) throw new Error('Missing project row.');
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual([`並べ替え: ${name}`, name, `${pinAction}: ${name}`, `プロジェクト設定: ${name}`]);
  }
  await user.click(screen.getByRole('button', { name: 'プロジェクトを検索' }));
  const search = screen.getByRole('searchbox', { name: 'プロジェクト名で検索' });
  expect(search).toHaveFocus();
  await user.type(search, '  ALP  ');
  expect(within(pinned()).getByRole('button', { name: 'Alpha' })).toBeVisible();
  expect(within(recent()).queryByRole('button', { name: 'Beta' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeVisible();
  await user.clear(search);
  await user.type(search, 'no match');
  expect(screen.getAllByText('一致するプロジェクトがありません。').length).toBeGreaterThan(0);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'プロジェクトを検索' })).toHaveFocus();
  let finish: ((ids: string[]) => void) | undefined;
  vi.mocked(f.pinsApi.set).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'ピン留めする: Beta' }));
  expect(within(recent()).getByRole('button', { name: 'Beta' })).toBeVisible();
  await act(async () => {
    f.acknowledge([beta.id, alpha.id]);
    finish!([beta.id, alpha.id]);
  });
  expect(
    within(pinned())
      .getAllByRole('button', { name: /^(Alpha|Beta)$/ })
      .map((node) => node.textContent),
  ).toEqual(['Beta', 'Alpha']);
  expect(within(recent()).queryByRole('button', { name: 'Beta' })).toBeNull();
  view.unmount();
  view = render(<App {...f} />);
  await within(pinned()).findByRole('button', { name: 'Beta' });
  await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
  expect(screen.getByLabelText('新しいプロジェクト名')).toHaveFocus();
  await user.type(screen.getByLabelText('新しいプロジェクト名'), 'Gamma');
  await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
  expect(await screen.findByRole('heading', { name: 'Gamma' })).toBeVisible();
  expect(screen.queryByLabelText('新しいプロジェクト名')).toBeNull();
  vi.mocked(f.pinsApi.set).mockRejectedValueOnce(new ApiError(500, 'synthetic failure'));
  await user.click(screen.getByRole('button', { name: 'ピン留めする: Gamma' }));
  expect(
    await within(screen.getByRole('region', { name: 'プロジェクト管理' })).findByRole('alert'),
  ).toHaveTextContent('ピン留め');
  expect(within(pinned()).getByRole('button', { name: 'Beta' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'ピン留めする: Gamma' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'ピン留めを再読み込み' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'ピン留めする: Gamma' })).toBeEnabled(),
  );
  const calls = vi.mocked(f.pinsApi.list).mock.calls.length;
  fireEvent.focus(window);
  await waitFor(() => expect(f.pinsApi.list).toHaveBeenCalledTimes(calls + 1));
  vi.mocked(f.pinsApi.list).mockRejectedValueOnce(new ProjectPinsUnavailable());
  fireEvent.focus(window);
  expect(await screen.findByText('ピン留めは現在利用できません。')).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: 'プロジェクト管理' })).queryByRole('alert'),
  ).toBeNull();
  const unavailableCalls = vi.mocked(f.pinsApi.list).mock.calls.length;
  fireEvent.focus(window);
  expect(f.pinsApi.list).toHaveBeenCalledTimes(unavailableCalls);
  view.unmount();
  const stale = fixture();
  render(<App {...stale} />);
  await screen.findByRole('button', { name: 'ピン留めを外す: Alpha' });
  let rejectOld: ((cause: Error) => void) | undefined;
  vi.mocked(stale.pinsApi.set).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'ピン留めを外す: Alpha' }));
  await act(async () => {
    stale.switchAccount();
    rejectOld!(new ApiError(401, 'Old session expired'));
  });
  expect(stale.auth.invalidate).not.toHaveBeenCalled();
  await screen.findByRole('button', { name: 'Other owned project' });
  expect(screen.queryByRole('button', { name: 'Microsoft Entra ID でサインイン' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
  expect(storage).not.toHaveBeenCalled();
  cleanup();
  const staleRead = fixture();
  render(<App {...staleRead} />);
  await screen.findByRole('button', { name: 'ピン留めを外す: Alpha' });
  let rejectRead: ((cause: Error) => void) | undefined;
  vi.mocked(staleRead.pinsApi.list).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  fireEvent.focus(window);
  await act(async () => {
    staleRead.switchAccount();
    rejectRead!(new ApiError(401, 'Old read session expired'));
  });
  expect(staleRead.auth.invalidate).not.toHaveBeenCalled();
  await screen.findByRole('button', { name: 'Other owned project' });
  cleanup();
  const english = fixture();
  render(
    <App
      {...english}
      preferencesApi={{
        get: async () => ({ language: 'en', theme: 'light' }),
        patch: async (changes) => ({ language: 'en', theme: 'light', ...changes }),
      }}
    />,
  );
  expect(await screen.findByRole('button', { name: 'Search projects' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'New project' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Pinned' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeVisible();
  vi.mocked(english.pinsApi.list).mockRejectedValueOnce(new ProjectPinsUnavailable());
  fireEvent.focus(window);
  expect(await screen.findByText('Project pins are currently unavailable.')).toBeVisible();
  vi.mocked(english.pinsApi.list).mockRejectedValueOnce(new ApiError(401, 'Session expired'));
  await user.click(screen.getByRole('button', { name: 'Reload project pins' }));
  await screen.findByRole('button', { name: /Microsoft Entra ID/ });
  expect(english.auth.invalidate).toHaveBeenCalledOnce();
});

/** @id TEST-SID-005 @verifies REQ-SID-005 */
it('TEST-SID-005 collapses only the left pane with focus and preserves tabs, widths and project scope', async () => {
  const user = userEvent.setup();
  const f = fixture();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1400, 800),
  );
  const file = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'notes.docx',
    size: 1,
    sha256: '0'.repeat(64),
    kind: 'download' as const,
    createdAt: alpha.createdAt,
  };
  render(
    <App
      {...f}
      filesApi={{
        emptyTrash: async () => {
          throw new Error('Test empty trash is not configured.');
        },
        setTrashed: async () => {
          throw new Error('No synthetic file trash mutation configured.');
        },
        list: async () => ({
          items: [file],
          nextCursor: null,
          usedBytes: 1,
          reservedBytes: 0,
          limitBytes: 10000000000,
        }),
        upload: async () => {
          throw new Error('No synthetic upload configured.');
        },
        content: async () => {
          throw new Error('No synthetic download requested.');
        },
      }}
    />,
  );
  await screen.findByRole('button', { name: 'Beta' });
  expect(screen.queryByRole('button', { name: '左ペインを折りたたむ' })).not.toBeNull();
  const left = screen.getByRole('separator', { name: '左ペインの幅を変更' });
  const right = screen.getByRole('separator', { name: '右ペインの幅を変更' });
  fireEvent.keyDown(left, { key: 'ArrowRight' });
  await user.click(await screen.findByRole('button', { name: 'ファイルを開く: notes.docx' }));
  expect(screen.getByRole('tab', { name: /notes.docx/ })).toHaveAttribute('aria-selected', 'true');
  const main = screen.getByRole('main');
  const expanded = main.style.gridTemplateColumns;
  await user.click(screen.getByRole('button', { name: '左ペインを折りたたむ' }));
  expect(screen.queryByRole('region', { name: 'プロジェクト管理' })).toBeNull();
  expect(screen.queryByRole('separator', { name: '左ペインの幅を変更' })).toBeNull();
  expect(main.style.gridTemplateColumns).toBe('minmax(480px,1fr) 8px 264px');
  const expand = screen.getByRole('button', { name: '左ペインを展開' });
  expect(expand).toHaveFocus();
  expect(screen.getByRole('tab', { name: /notes.docx/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeVisible();
  expect(right).toHaveAttribute('aria-valuenow', '264');
  fireEvent.keyDown(right, { key: 'End' });
  expect(right).toHaveAttribute('aria-valuenow', String(1400 - 496 - 270));
  fireEvent.keyDown(right, { key: 'ArrowRight' });
  const rightValue = right.getAttribute('aria-valuenow');
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: '左ペインを折りたたむ' })).toHaveFocus();
  expect(screen.getByRole('separator', { name: '左ペインの幅を変更' })).toHaveAttribute(
    'aria-valuenow',
    '270',
  );
  expect(right).toHaveAttribute('aria-valuenow', rightValue);
  expect(main.style.gridTemplateColumns).toContain('270px 8px');
  expect(expanded).toContain('270px 8px');
  await user.click(screen.getByRole('button', { name: '左ペインを折りたたむ' }));
  await act(async () => f.switchAccount());
  await screen.findByRole('button', { name: 'Other owned project' });
  expect(screen.getByRole('region', { name: 'プロジェクト管理' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '左ペインを展開' })).toBeNull();
  cleanup();
  const captured = new Map<HTMLElement, number>();
  const release = vi.fn(function (this: HTMLElement) {
    captured.delete(this);
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value: function (this: HTMLElement, id: number) {
        captured.set(this, id);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: function (this: HTMLElement, id: number) {
        return captured.get(this) === id;
      },
    },
    releasePointerCapture: { configurable: true, value: release },
  });
  const layout = (leftCollapsed: boolean) => (
    <ResizableWorkspace
      {...{ scopeKey: 'capture-spike', t: (text: string) => text, leftCollapsed }}
    >
      <section>Left</section>
      <section>Center</section>
      <section>Right</section>
    </ResizableWorkspace>
  );
  const captureView = render(layout(false));
  const handle = screen.getByRole('separator', { name: '左ペインの幅を変更' });
  for (const [type, x] of [
    ['pointerdown', 260],
    ['pointermove', 340],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } });
    fireEvent(handle, event);
  }
  expect(handle).toHaveAttribute('aria-valuenow', '340');
  captureView.rerender(layout(true));
  expect(release).toHaveBeenCalledWith(7);
  expect(screen.getByRole('main')).not.toHaveClass('select-none');
  captureView.rerender(layout(false));
  expect(screen.getByRole('separator', { name: '左ペインの幅を変更' })).toHaveAttribute(
    'aria-valuenow',
    '260',
  );
});
