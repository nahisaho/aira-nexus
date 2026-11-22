// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceTabs } from '../src/client/components/workspace-tabs';
import type { WorkspaceTabsHandle } from '../src/client/components/workspace-tabs';
import { translate } from '../src/client/i18n';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});
const first = { id: 'chat', name: '研究.txt' };
const second = { id: 'notebook', name: 'notes.md' };
const third = { id: 'third', name: 'results.csv' };
function fixture() {
  const ref = createRef<WorkspaceTabsHandle>();
  const element = (scopeKey = 'alice:project-a', language: 'ja' | 'en' = 'ja') => (
    <WorkspaceTabs
      ref={ref}
      scopeKey={scopeKey}
      t={(text) => translate(language, text)}
      chat={<p>Chat placeholder</p>}
      notebook={<p>Notebook placeholder</p>}
    />
  );
  const view = render(element());
  const open = (...files: (typeof first)[]) =>
    act(() => {
      for (const file of files) ref.current?.openFile(file);
    });
  return { ref, view, element, open };
}
const order = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
function transfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    get types() {
      return [...values.keys()];
    },
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
    getData: (type: string) => values.get(type) ?? '',
  };
}
/** @id TEST-UI-007 @verifies REQ-UI-004 */
it('TEST-UI-007 opens and activates named file tabs after fixed tabs, deduplicating by ID', () => {
  const f = fixture();
  expect(() => f.ref.current?.openFile({ id: '', name: 'empty.txt' })).toThrow();
  expect(() => f.ref.current?.openFile({ id: 'empty-name', name: ' ' })).toThrow();
  expect(order()).toEqual(['AIチャット', 'Notebook']);
  f.open(first);
  expect(screen.queryByRole('tab', { name: first.name })).toBeInTheDocument();
  expect(order()).toEqual(['AIチャット', 'Notebook', first.name]);
  expect(screen.getByRole('tab', { name: first.name })).toHaveAttribute('aria-selected', 'true');
  f.open(second, first);
  expect(order()).toEqual(['AIチャット', 'Notebook', first.name, second.name]);
  expect(screen.getByRole('tab', { name: first.name })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveTextContent(first.name);
  expect(screen.getByRole('tabpanel')).toHaveTextContent('まだ利用できません');
  f.open({ ...first, name: 'renamed.txt' });
  expect(order()).toEqual(['AIチャット', 'Notebook', 'renamed.txt', second.name]);
  expect(screen.getByRole('tabpanel')).toHaveTextContent('renamed.txt');
});
/** @id TEST-UI-008 @verifies REQ-UI-005 */
it('TEST-UI-008 closes views only, retaining inactive selection and choosing/focusing the nearest file', async () => {
  const f = fixture();
  const user = userEvent.setup();
  f.open(first, second, third);
  expect(screen.queryByRole('button', { name: `タブを閉じる: ${first.name}` })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: `タブを閉じる: ${first.name}` }));
  expect(screen.getByRole('tab', { name: third.name })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: third.name })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: `タブを閉じる: ${third.name}` }));
  expect(screen.getByRole('tab', { name: second.name })).toHaveFocus();
  f.open(first, third);
  await user.click(screen.getByRole('tab', { name: second.name }));
  await user.click(screen.getByRole('button', { name: `タブを閉じる: ${second.name}` }));
  expect(screen.getByRole('tab', { name: first.name })).toHaveFocus();
  await user.keyboard('{Delete}');
  expect(screen.getByRole('tab', { name: third.name })).toHaveFocus();
  await user.keyboard('{Delete}');
  expect(screen.getByRole('tab', { name: 'AIチャット' })).toHaveFocus();
  expect(order()).toEqual(['AIチャット', 'Notebook']);
  expect(
    screen.queryByRole('button', { name: 'タブを閉じる: AIチャット' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'タブを閉じる: Notebook' })).not.toBeInTheDocument();
  expect(document.querySelector('button button')).toBeNull();
  f.open(first);
  expect(screen.getByRole('tab', { name: first.name })).toHaveAttribute('aria-selected', 'true');
});
/** @id TEST-UI-009 @verifies REQ-UI-006 */
it('TEST-UI-009 moves file tabs by mouse and keyboard but rejects pinned, foreign and stale drag sources', async () => {
  const f = fixture();
  const user = userEvent.setup();
  f.open(first, second, third);
  expect(screen.queryByRole('tab', { name: first.name })).toBeInTheDocument();
  const source = screen.getByRole('tab', { name: first.name });
  await user.click(source);
  const local = transfer();
  fireEvent.dragStart(source, { dataTransfer: local });
  const over = createEvent.dragOver(screen.getByRole('tab', { name: third.name }), {
    dataTransfer: local,
  });
  fireEvent(screen.getByRole('tab', { name: third.name }), over);
  expect(over.defaultPrevented).toBe(true);
  fireEvent.drop(screen.getByRole('tab', { name: third.name }), { dataTransfer: local });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  expect(screen.getByRole('tabpanel')).toHaveTextContent(first.name);
  expect(screen.getByRole('tab', { name: 'AIチャット' })).toHaveAttribute('draggable', 'false');
  expect(screen.getByRole('tab', { name: 'Notebook' })).toHaveAttribute('draggable', 'false');
  const backward = transfer();
  fireEvent.dragStart(source, { dataTransfer: backward });
  fireEvent.drop(screen.getByRole('tab', { name: second.name }), { dataTransfer: backward });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', first.name, second.name, third.name]);
  const forward = transfer();
  fireEvent.dragStart(source, { dataTransfer: forward });
  fireEvent.drop(screen.getByRole('tab', { name: third.name }), { dataTransfer: forward });
  fireEvent.dragEnd(source);
  const self = transfer();
  fireEvent.dragStart(source, { dataTransfer: self });
  fireEvent.drop(source, { dataTransfer: self });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  const cancelled = transfer();
  fireEvent.dragStart(source, { dataTransfer: cancelled });
  fireEvent.dragEnd(source);
  fireEvent.drop(screen.getByRole('tab', { name: second.name }), { dataTransfer: cancelled });
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  const closeTarget = transfer();
  fireEvent.dragStart(source, { dataTransfer: closeTarget });
  fireEvent.drop(screen.getByRole('button', { name: `タブを閉じる: ${second.name}` }), {
    dataTransfer: closeTarget,
  });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  const pinned = transfer();
  fireEvent.dragStart(source, { dataTransfer: pinned });
  fireEvent.drop(screen.getByRole('tab', { name: 'AIチャット' }), { dataTransfer: pinned });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  const foreign = transfer();
  fireEvent.dragStart(source, { dataTransfer: foreign });
  for (const type of foreign.types) foreign.setData(type, 'foreign-instance');
  fireEvent.drop(screen.getByRole('tab', { name: second.name }), { dataTransfer: foreign });
  fireEvent.dragEnd(source);
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name, first.name]);
  const stale = transfer();
  fireEvent.dragStart(source, { dataTransfer: stale });
  await user.click(screen.getByRole('button', { name: `タブを閉じる: ${first.name}` }));
  fireEvent.drop(screen.getByRole('tab', { name: second.name }), { dataTransfer: stale });
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name]);
  await user.click(screen.getByRole('tab', { name: third.name }));
  await user.keyboard('{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}');
  expect(order()).toEqual(['AIチャット', 'Notebook', third.name, second.name]);
  expect(screen.getByRole('tab', { name: third.name })).toHaveFocus();
  await user.keyboard('{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}');
  expect(order()).toEqual(['AIチャット', 'Notebook', third.name, second.name]);
  await user.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}');
  expect(order()).toEqual(['AIチャット', 'Notebook', second.name, third.name]);
});
/** @id TEST-UI-010 @verifies REQ-UI-007 */
it('TEST-UI-010 preserves tabs for language/theme changes but resets them and old drag state by project/account scope', () => {
  const f = fixture();
  f.open(first, { id: 'translation-key', name: 'AIチャット' }, second);
  expect(screen.queryByRole('tab', { name: first.name })).toBeInTheDocument();
  document.documentElement.dataset.theme = 'dark';
  f.view.rerender(f.element('alice:project-a', 'en'));
  expect(order()).toEqual(['AI chat', 'Notebook', first.name, 'AIチャット', second.name]);
  expect(screen.getByRole('button', { name: `Close tab: ${first.name}` })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: second.name })).toHaveAttribute('aria-selected', 'true');
  const old = transfer();
  fireEvent.dragStart(screen.getByRole('tab', { name: first.name }), { dataTransfer: old });
  f.view.rerender(f.element('alice:project-b', 'en'));
  expect(order()).toEqual(['AI chat', 'Notebook']);
  expect(screen.getByRole('tab', { name: 'AI chat' })).toHaveAttribute('aria-selected', 'true');
  f.open(first, third);
  fireEvent.drop(screen.getByRole('tab', { name: third.name }), { dataTransfer: old });
  expect(order()).toEqual(['AI chat', 'Notebook', first.name, third.name]);
  f.view.rerender(f.element('bob:project-b', 'en'));
  expect(order()).toEqual(['AI chat', 'Notebook']);
  f.view.unmount();
  render(f.element('alice:project-a'));
  expect(order()).toEqual(['AIチャット', 'Notebook']);
});
