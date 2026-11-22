// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResizableWorkspace } from '../src/client/components/resizable-workspace';

const pointerMethods = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'] as const;
const originals = pointerMethods.map((key) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pointerMethods.forEach((key, index) => {
    const descriptor = originals[index];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  });
});
function fixture() {
  let width = 1200;
  let notify = () => {};
  const captured = new Map<HTMLElement, number>();
  const setCapture = vi.fn(function (this: HTMLElement, id: number) {
    captured.set(this, id);
  });
  const releaseCapture = vi.fn(function (this: HTMLElement) {
    captured.delete(this);
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: setCapture },
    releasePointerCapture: { configurable: true, value: releaseCapture },
    hasPointerCapture: {
      configurable: true,
      value: function (this: HTMLElement, id: number) {
        return captured.get(this) === id;
      },
    },
  });
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, 700),
  );
  const element = (scopeKey = 'alice') => (
    <ResizableWorkspace scopeKey={scopeKey} t={(text) => text}>
      <section>Left</section>
      <section>Center</section>
      <section>Right</section>
    </ResizableWorkspace>
  );
  const view = render(element());
  return {
    view,
    element,
    setCapture,
    releaseCapture,
    resize: (next: number) =>
      act(() => {
        width = next;
        notify();
      }),
  };
}
const value = (separator: HTMLElement) => Number(separator.getAttribute('aria-valuenow'));
/** @id TEST-UI-011 @verifies REQ-UI-008 */
it('TEST-UI-011 resizes both pane boundaries with capture while preserving the other sidebar', () => {
  const f = fixture();
  expect(screen.queryAllByRole('separator')).toHaveLength(2);
  const left = screen.getByRole('separator', { name: '左ペインの幅を変更' });
  const right = screen.getByRole('separator', { name: '右ペインの幅を変更' });
  expect(left).toHaveAttribute('aria-orientation', 'vertical');
  expect(left).toHaveAttribute('tabindex', '0');
  fireEvent.pointerDown(left, { pointerId: 7, button: 0, clientX: 260 });
  fireEvent.pointerMove(left, { pointerId: 7, clientX: 340 });
  expect(value(left)).toBe(340);
  expect(value(right)).toBe(264);
  fireEvent.pointerMove(left, { pointerId: 8, clientX: 500 });
  expect(value(left)).toBe(340);
  fireEvent.pointerUp(left, { pointerId: 7 });
  fireEvent.lostPointerCapture(left, { pointerId: 7 });
  expect(value(left)).toBe(340);
  expect(f.setCapture).toHaveBeenCalledWith(7);
  expect(f.releaseCapture).toHaveBeenCalled();
  fireEvent.pointerMove(left, { pointerId: 7, clientX: 500 });
  expect(value(left)).toBe(340);
  fireEvent.pointerDown(right, { pointerId: 9, button: 0, clientX: 900 });
  fireEvent.pointerMove(right, { pointerId: 9, clientX: 940 });
  fireEvent.pointerUp(right, { pointerId: 9 });
  expect(value(right)).toBe(224);
  expect(value(left)).toBe(340);
  fireEvent.keyDown(left, { key: 'ArrowLeft' });
  expect(value(left)).toBe(330);
  fireEvent.keyDown(right, { key: 'ArrowLeft', shiftKey: true });
  expect(value(right)).toBe(274);
  expect(left).toHaveAttribute('aria-valuemin', '200');
  expect(value(left)).toBeLessThanOrEqual(Number(left.getAttribute('aria-valuemax')));
  fireEvent.keyDown(right, { key: 'Home' });
  expect(value(right)).toBe(200);
  fireEvent.keyDown(right, { key: 'End' });
  expect(value(right)).toBe(374);
  expect(right).toHaveAttribute('aria-valuemax', '374');
});
/** @id TEST-UI-012 @verifies REQ-UI-008 */
it('TEST-UI-012 clamps widths, cancels incomplete drags and normalizes container shrink without persistence', () => {
  const f = fixture();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  expect(screen.queryAllByRole('separator')).toHaveLength(2);
  const left = screen.getByRole('separator', { name: '左ペインの幅を変更' });
  const right = screen.getByRole('separator', { name: '右ペインの幅を変更' });
  fireEvent.pointerDown(left, { pointerId: 1, button: 2, clientX: 260 });
  fireEvent.pointerMove(left, { pointerId: 1, clientX: 500 });
  expect(value(left)).toBe(260);
  fireEvent.pointerDown(left, { pointerId: 2, button: 0, clientX: 260 });
  fireEvent.pointerMove(left, { pointerId: 2, clientX: 10000 });
  expect(value(left)).toBe(440);
  expect(value(right)).toBe(264);
  fireEvent.keyDown(left, { key: 'Escape' });
  fireEvent.lostPointerCapture(left, { pointerId: 2 });
  expect(value(left)).toBe(260);
  fireEvent.pointerDown(right, { pointerId: 3, button: 0, clientX: 900 });
  fireEvent.pointerMove(right, { pointerId: 3, clientX: 10000 });
  expect(value(right)).toBe(200);
  fireEvent.pointerCancel(right, { pointerId: 3 });
  fireEvent.lostPointerCapture(right, { pointerId: 3 });
  expect(value(right)).toBe(264);
  fireEvent.pointerDown(left, { pointerId: 4, button: 0, clientX: 260 });
  fireEvent.pointerMove(left, { pointerId: 4, clientX: 320 });
  fireEvent.lostPointerCapture(left, { pointerId: 4 });
  expect(value(left)).toBe(260);
  fireEvent.keyDown(left, { key: 'End' });
  expect(value(left)).toBe(440);
  f.resize(1024);
  expect(value(left)).toBeGreaterThanOrEqual(200);
  expect(value(right)).toBeGreaterThanOrEqual(200);
  expect(value(left) + value(right)).toBeLessThanOrEqual(1024 - 16 - 480);
  f.resize(800);
  expect(value(left) + value(right)).toBeLessThanOrEqual(1024 - 16 - 480);
  f.view.rerender(f.element('alice'));
  expect(value(left)).toBe(328);
  f.view.rerender(f.element('bob'));
  expect(value(screen.getByRole('separator', { name: '左ペインの幅を変更' }))).toBe(260);
  expect(value(screen.getByRole('separator', { name: '右ペインの幅を変更' }))).toBe(264);
  expect(storage).not.toHaveBeenCalled();
  f.view.unmount();
  render(f.element());
  expect(value(screen.getByRole('separator', { name: '左ペインの幅を変更' }))).toBe(260);
  expect(value(screen.getByRole('separator', { name: '右ペインの幅を変更' }))).toBe(264);
});
