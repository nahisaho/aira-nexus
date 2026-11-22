// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import type { BrowserAuth, UserAccount } from '../src/client/auth';
import { ApiError, createProjectsApi } from '../src/client/api';
import type { ProjectsApi } from '../src/client/api';
import type { Project } from '../src/shared/contracts';
import { BrowserAuthError } from '@azure/msal-browser';

afterEach(cleanup);
const makeProject = (name = '研究A'): Project => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name,
  version: 1,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
});
function setup(signedIn = false) {
  let account: UserAccount | null = signedIn ? { id: 'alice', name: '研究者A' } : null;
  let saved: Project[] = [];
  const auth: BrowserAuth = {
    account: () => account,
    signIn: vi.fn(async () => (account = { id: 'alice', name: '研究者A' })),
    accessToken: vi.fn(async () => 'unit-test-token'),
    signOut: vi.fn(async () => {
      account = null;
    }),
  };
  const api: ProjectsApi = {
    list: vi.fn(async () => [...saved]),
    create: vi.fn(async (name) => {
      const project = makeProject(name);
      saved = [project, ...saved];
      return project;
    }),
    rename: vi.fn(async (project, name) => {
      const updated = { ...project, name, version: project.version + 1 };
      saved = saved.map((p) => (p.id === project.id ? updated : p));
      return updated;
    }),
  };
  return { auth, api };
}

describe('research workbench foundation', () => {
  /** @id TEST-UI-004 @verifies REQ-UI-002 REQ-UI-003 */
  it('TEST-UI-004 sends bearer/version headers and rejects account changes during token acquisition', async () => {
    const fixture = setup(true);
    const fetcher = vi.fn(async () => Response.json(makeProject()));
    vi.stubGlobal('fetch', fetcher);
    try {
      const api = createProjectsApi(fixture.auth);
      expect((await api.create('研究A')).name).toBe('研究A');
      await api.rename(makeProject(), '更新');
      expect(fetcher).toHaveBeenLastCalledWith(
        `/api/projects/${makeProject().id}`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: '更新' }),
          headers: expect.objectContaining({
            Authorization: 'Bearer unit-test-token',
            'If-Match': '"1"',
          }),
        }),
      );
      fetcher.mockImplementationOnce(async () => new Response(null, { status: 409 }));
      await expect(api.rename(makeProject(), '更新')).rejects.toMatchObject({ status: 409 });
      vi.mocked(fixture.auth.accessToken).mockRejectedValueOnce(
        new BrowserAuthError('monitor_window_timeout'),
      );
      await expect(api.list()).rejects.toMatchObject({ status: 401 });
      let finish: (token: string) => void = () => {
        throw new Error('Token acquisition not started.');
      };
      vi.mocked(fixture.auth.accessToken).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      fetcher.mockImplementationOnce(async () => Response.json([]));
      const pending = api.list();
      const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
      await fixture.auth.signOut();
      finish('previous-session-token');
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** @id TEST-UI-005 @verifies REQ-UI-003 */
  it('TEST-UI-005 clears old-account content and discards a pending mutation on account switch', async () => {
    const user = userEvent.setup();
    const fixture = setup(true);
    let account: UserAccount = { id: 'alice', name: '研究者A' };
    let notify = () => {};
    fixture.auth.account = () => account;
    fixture.auth.subscribe = (listener) => {
      notify = listener;
      return () => {};
    };
    vi.mocked(fixture.api.list)
      .mockResolvedValueOnce([makeProject('本人Aの研究')])
      .mockResolvedValue([]);
    let finish: (project: Project) => void = () => {
      throw new Error('Mutation not started.');
    };
    vi.mocked(fixture.api.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<App {...fixture} />);
    await screen.findByRole('button', { name: '本人Aの研究' });
    await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
    await user.type(screen.getByLabelText('新しいプロジェクト名'), '遅延した作成結果');
    await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
    await act(async () => {
      account = { id: 'bob', name: '研究者B' };
      notify();
    });
    await screen.findByText('プロジェクトはまだありません。');
    await act(async () => {
      finish(makeProject('遅延した作成結果'));
    });
    expect(screen.queryByText('遅延した作成結果')).not.toBeInTheDocument();
    expect(screen.queryByText('本人Aの研究')).not.toBeInTheDocument();
  });
  /** @id TEST-UI-001 @verifies REQ-UI-001 */
  it('TEST-UI-001 gates private content and exposes three panes with keyboard tabs', async () => {
    const user = userEvent.setup();
    const fixture = setup();
    render(<App {...fixture} />);
    expect(screen.queryByRole('region', { name: 'プロジェクト管理' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Microsoft Entra ID でサインイン' }));
    expect(await screen.findByRole('region', { name: 'プロジェクト管理' })).toBeVisible();
    expect(screen.getByRole('region', { name: '研究ワークスペース' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'ファイルエクスプローラー' })).toBeVisible();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'AIチャット',
      'Notebook',
    ]);
    const chat = screen.getByRole('tab', { name: 'AIチャット' });
    chat.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Notebook' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Notebook' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Notebook' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('段階③');
  });

  /** @id TEST-UI-002 @verifies REQ-UI-002 */
  it('TEST-UI-002 keeps the center free of rename controls and renames through project settings using persisted API results', async () => {
    const user = userEvent.setup();
    const fixture = setup(true);
    const view = render(<App {...fixture} />);
    await screen.findByText('プロジェクトはまだありません。');
    await user.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
    await user.type(screen.getByLabelText('新しいプロジェクト名'), '研究テーマ');
    await user.click(screen.getByRole('button', { name: 'プロジェクトを作成' }));
    const projectList = screen.getByRole('list', { name: 'プロジェクト一覧' });
    expect(await within(projectList).findByRole('button', { name: '研究テーマ' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const center = screen.getByRole('region', { name: '研究ワークスペース' });
    expect(within(center).getByRole('heading', { name: '研究テーマ' })).toBeVisible();
    expect(within(center).queryByLabelText('選択中のプロジェクト名')).not.toBeInTheDocument();
    expect(within(center).queryByRole('button', { name: '名前を保存' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'プロジェクト設定: 研究テーマ' }));
    await user.click(screen.getByRole('menuitem', { name: 'プロジェクト設定' }));
    const dialog = await screen.findByRole('dialog');
    const rename = within(dialog).getByLabelText('プロジェクト名');
    await user.clear(rename);
    await user.type(rename, '変更したテーマ');
    await user.click(within(dialog).getByRole('button', { name: '変更を保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      await within(projectList).findByRole('button', { name: '変更したテーマ' }),
    ).toBeVisible();
    view.unmount();
    render(<App {...fixture} />);
    await user.click(await screen.findByRole('button', { name: '変更したテーマ' }));
    expect(screen.getByRole('heading', { name: '変更したテーマ' })).toBeVisible();
    expect(fixture.api.rename).toHaveBeenCalledWith(
      expect.objectContaining({ name: '研究テーマ', version: 1 }),
      '変更したテーマ',
      expect.any(AbortSignal),
    );
  });

  /** @id TEST-UI-003 @verifies REQ-UI-003 */
  it('TEST-UI-003 surfaces failures, disables future actions and rejects stale session results', async () => {
    const user = userEvent.setup();
    const fixture = setup(true);
    fixture.auth.invalidate = vi.fn();
    vi.mocked(fixture.api.list).mockResolvedValueOnce([makeProject()]);
    vi.mocked(fixture.api.rename).mockRejectedValue(
      new ApiError(409, '競合しました。再読み込みしてください。'),
    );
    const view = render(<App {...fixture} />);
    await user.click(await screen.findByRole('button', { name: '研究A' }));
    expect(screen.getByRole('textbox', { name: 'メッセージ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'プレビュー' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Notebook' }));
    expect(screen.getByRole('button', { name: 'セルを実行' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'プロジェクト設定: 研究A' }));
    await user.click(screen.getByRole('menuitem', { name: 'プロジェクト設定' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: '変更を保存' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('競合');
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('heading', { name: '研究A' })).toBeVisible();
    view.unmount();
    vi.mocked(fixture.api.list).mockRejectedValueOnce(
      new ApiError(401, '認証の有効期限が切れました。'),
    );
    const expiredView = render(<App {...fixture} />);
    expect(
      await screen.findByRole('button', { name: 'Microsoft Entra ID でサインイン' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: '研究A' })).not.toBeInTheDocument();
    expect(fixture.auth.invalidate).toHaveBeenCalledOnce();
    expiredView.unmount();
    const delayed = setup(true);
    let resolve: (value: Project[]) => void = () => {
      throw new Error('request not started');
    };
    vi.mocked(delayed.api.list).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<App {...delayed} />);
    await waitFor(() => expect(delayed.api.list).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'サインアウト' }));
    await screen.findByRole('button', { name: 'Microsoft Entra ID でサインイン' });
    await act(async () => {
      resolve([makeProject('前のユーザーの秘密')]);
    });
    expect(screen.queryByText('前のユーザーの秘密')).not.toBeInTheDocument();
  });
});
