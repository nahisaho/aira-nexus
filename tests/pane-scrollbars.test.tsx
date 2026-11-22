// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResizableWorkspace } from '../src/client/components/resizable-workspace';
import { translate } from '../src/client/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** @id TEST-SCR-001 @verifies REQ-SCR-001 */
it('TEST-SCR-001 exposes independent keyboard-focusable panes and excludes the collapsed pane', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const children = [
    <section key="left">Left</section>,
    <section key="center">Center</section>,
    <section key="right">Right</section>,
  ] as const;
  const element = (leftCollapsed = false, language: 'ja' | 'en' = 'ja') => (
    <ResizableWorkspace
      scopeKey="synthetic-owner"
      t={(text) => translate(language, text)}
      leftCollapsed={leftCollapsed}
    >
      {[...children]}
    </ResizableWorkspace>
  );
  const view = render(element());
  expect(screen.queryByRole('group', { name: '左ペイン' })).toBeInTheDocument();
  const panes = ['左ペイン', '中央ペイン', '右ペイン'].map((name) =>
    screen.getByRole('group', { name }),
  );
  expect(new Set(panes).size).toBe(3);
  for (const pane of panes) {
    expect(pane).toHaveAttribute('tabindex', '0');
    pane.focus();
    expect(pane).toHaveFocus();
  }
  const left = panes[0]!;
  left.scrollTop = 42;
  const separators = screen.getAllByRole('separator');
  const rightWidth = separators[1]!.getAttribute('aria-valuenow');
  view.rerender(element(true));
  expect(screen.queryByRole('group', { name: '左ペイン' })).not.toBeInTheDocument();
  expect(left).toHaveAttribute('tabindex', '-1');
  expect(left).toHaveAttribute('hidden');
  expect(screen.getAllByRole('separator')).toHaveLength(1);
  view.rerender(element());
  expect(screen.getByRole('group', { name: '左ペイン' })).toBe(left);
  expect(left).toHaveAttribute('tabindex', '0');
  expect(left.scrollTop).toBe(42);
  expect(screen.getAllByRole('separator')[1]).toHaveAttribute('aria-valuenow', rightWidth);
  view.rerender(element(false, 'en'));
  for (const name of ['Left pane', 'Center pane', 'Right pane']) {
    expect(screen.getByRole('group', { name })).toHaveAttribute('tabindex', '0');
  }
});
