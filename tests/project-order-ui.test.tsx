// @vitest-environment jsdom
import { createRef } from 'react';
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
import { ProjectSidebar } from '../src/client/components/project-sidebar';
import type { ProjectOrderApi } from '../src/client/project-order-api';
import { ApiError } from '../src/client/api';
import type { ProjectOrderSnapshot } from '../src/shared/project-order';

afterEach(cleanup);

/** @id TEST-SID-011 @verifies REQ-SID-008 */
it('TEST-SID-011 keeps confirmed order on errors, blocks shared writes and fences same-turn session successes and 401s', async () => {
  const user = userEvent.setup();
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const projects = [a, b].map((id, i) => ({
    id,
    name: ['A', 'B'][i]!,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  let epoch = 0;
  let locked = false;
  let finish: (value: ProjectOrderSnapshot) => void = () => {};
  let fail: (cause: unknown) => void = () => {};
  let snapshot = { version: 1, pinned: [] as string[], recent: [a, b] };
  const orderApi: ProjectOrderApi = {
    capabilities: vi.fn(async () => true),
    get: vi.fn(async () => snapshot),
    move: vi.fn(
      () =>
        new Promise<ProjectOrderSnapshot>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    ),
  };
  const pinsApi = {
    list: vi.fn(async () => [] as string[]),
    set: vi.fn(async () => [] as string[]),
  };
  const select = vi.fn();
  const authentication = vi.fn();
  const unusedRequest = async (): Promise<never> => {
    throw new Error('Management is disabled in this ordering fixture.');
  };
  render(
    <ProjectSidebar
      auth={{
        account: () => ({ id: 'owner', name: 'Owner' }),
        signIn: async () => ({ id: 'owner', name: 'Owner' }),
        accessToken: unusedRequest,
        signOut: async () => {},
      }}
      api={{ list: async () => projects, create: unusedRequest, rename: unusedRequest }}
      managementApi={{
        capabilities: async () => false,
        get: unusedRequest,
        create: unusedRequest,
        update: unusedRequest,
        trash: unusedRequest,
        transition: unusedRequest,
      }}
      projects={projects}
      selectedId={a}
      loading={false}
      busy={false}
      pinsApi={pinsApi}
      orderApi={orderApi}
      captureSession={() => {
        const captured = epoch;
        return () => captured === epoch;
      }}
      beginWrite={() => {
        if (locked) return null;
        locked = true;
        return () => {
          locked = false;
        };
      }}
      onSelect={select}
      onProjectSaved={vi.fn()}
      onProjectTrashed={vi.fn()}
      onReload={vi.fn()}
      onAuthenticationError={authentication}
      onCollapse={() => {}}
      collapseRef={createRef()}
      footer={null}
      t={(text) => text}
    />,
  );
  const handle = () => screen.getByRole('button', { name: '並べ替え: B' });
  const names = () =>
    within(screen.getByRole('list', { name: '最近のプロジェクト' }))
      .getAllByRole('button', { name: /^(A|B)$/ })
      .map((node) => node.textContent);
  expect(screen.queryAllByRole('button', { name: /上へ移動|下へ移動/ })).toHaveLength(0);
  await waitFor(() => expect(handle()).toBeEnabled());
  handle().focus();
  fireEvent.keyDown(handle(), { key: 'ArrowDown' });
  expect(orderApi.move).not.toHaveBeenCalled();
  const up = createEvent.keyDown(handle(), { key: 'ArrowUp', cancelable: true });
  fireEvent(handle(), up);
  expect(up.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ピン留めする: A' }));
  expect(orderApi.move).toHaveBeenCalledTimes(1);
  expect(pinsApi.set).not.toHaveBeenCalled();
  expect(names()).toEqual(['A', 'B']);
  fireEvent.focus(window);
  await act(async () => fail(new ApiError(409, '競合しました。')));
  expect(names()).toEqual(['A', 'B']);
  expect(handle()).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('競合しました。');
  expect(locked).toBe(false);
  vi.mocked(orderApi.get).mockRejectedValueOnce(new ApiError(500, '読み込み失敗'));
  await user.click(screen.getByRole('button', { name: '並び順を再読み込み' }));
  expect(handle()).toBeDisabled();
  expect(names()).toEqual(['A', 'B']);
  await user.click(screen.getByRole('button', { name: '並び順を再読み込み' }));
  await waitFor(() => expect(handle()).toBeEnabled());
  fireEvent.keyDown(handle(), { key: 'ArrowUp' });
  snapshot = { version: 2, pinned: [], recent: [b, a] };
  await act(async () => finish(snapshot));
  expect(names()).toEqual(['B', 'A']);
  expect(handle()).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(handle(), { key: 'ArrowUp' });
  expect(orderApi.move).toHaveBeenCalledTimes(2);
  vi.mocked(orderApi.capabilities).mockResolvedValueOnce(false);
  fireEvent.focus(window);
  await waitFor(() => expect(handle()).toBeDisabled());
  expect(names()).toEqual(['A', 'B']);
  expect(screen.getByText('並べ替えは現在利用できません。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '並び順を再読み込み' }));
  await waitFor(() => expect(names()).toEqual(['B', 'A']));
  // The promise settles before React commits the new epoch: both outcomes must be fenced.
  fireEvent.keyDown(handle(), { key: 'ArrowDown' });
  await act(async () => {
    finish({ version: 3, pinned: [], recent: [a, b] });
    epoch++;
  });
  expect(names()).toEqual(['B', 'A']);
  fireEvent.focus(window);
  await waitFor(() => expect(handle()).toBeEnabled());
  fireEvent.keyDown(handle(), { key: 'ArrowDown' });
  await act(async () => {
    fail(new ApiError(401, 'old session'));
    epoch++;
  });
  expect(authentication).not.toHaveBeenCalled();
  expect(names()).toEqual(['B', 'A']);
});
