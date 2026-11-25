// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './helpers/app';
import type { BrowserAuth } from '../src/client/auth';
import type { Project } from '../src/shared/contracts';
import type { NotebookCell } from '../src/shared/notebook';

afterEach(cleanup);

/** @id TEST-NB-006 @verifies REQ-NB-002 */
it('TEST-NB-006 edits and executes saved Notebook cells and renders output as inert text', async () => {
  const project: Project = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Notebook research',
    version: 1,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  const auth: BrowserAuth = {
    account: () => ({ id: 'owner', name: 'Researcher' }),
    accessToken: async () => 'test-token',
    signIn: async () => ({ id: 'owner', name: 'Researcher' }),
    signOut: async () => {},
  };
  const saved: NotebookCell = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    language: 'python',
    code: 'x = 40',
    version: 1,
    output: '',
    executedBy: null,
    stateLost: false,
  };
  const notebookApi = {
    capabilities: vi.fn(async () => ({ enabled: true })),
    list: vi.fn(async () => ({ cells: [saved] })),
    create: vi.fn(async () => saved),
    save: vi.fn(
      async (_project: string, _id: string, input: { code: string; version: number }) => ({
        ...saved,
        code: input.code,
        version: 2,
      }),
    ),
    execute: vi.fn(async () => ({
      ...saved,
      version: 2,
      output: '<img src=x onerror=alert(1)>',
      executedBy: 'owner',
    })),
    restart: vi.fn(async () => ({ stateLost: true })),
  };
  render(
    <App
      auth={auth}
      api={{
        list: async () => [project],
        create: async () => project,
        rename: async () => project,
      }}
      {...{ notebookApi }}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: project.name }));
  await user.click(screen.getByRole('tab', { name: /Notebook/ }));
  const editor = await screen.findByRole('textbox', { name: 'セルのコード' });
  expect(editor).toHaveValue('x = 40');
  await user.clear(editor);
  await user.type(editor, 'print(42)');
  await user.click(screen.getByRole('button', { name: 'セルを実行' }));
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(notebookApi.save).toHaveBeenCalledWith(
    project.id,
    saved.id,
    { code: 'print(42)', version: 1 },
    expect.any(AbortSignal),
  );
  expect(notebookApi.execute).toHaveBeenCalledWith(
    project.id,
    saved.id,
    { version: 2 },
    expect.any(AbortSignal),
  );
});
