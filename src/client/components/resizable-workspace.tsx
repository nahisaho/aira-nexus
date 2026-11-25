import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
export interface ResizableWorkspaceProps {
  scopeKey: string;
  children: [ReactNode, ReactNode, ReactNode];
  t: (text: string) => string;
  leftCollapsed?: boolean;
}
/** @id CODE-UI-005 @implements REQ-UI-001 REQ-UI-008 REQ-SID-005 REQ-SCR-001 */
export function ResizableWorkspace(props: ResizableWorkspaceProps) {
  return <WorkspaceSession key={props.scopeKey} {...props} />;
}

type Side = 'left' | 'right';
const paneClassName =
  'flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-y-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&>section]:flex-1';
interface Widths {
  left: number;
  right: number;
  total: number;
}
interface DragState {
  side: Side;
  pointer: number;
  x: number;
  initial: Widths;
  handle: HTMLDivElement;
}
function normalize(widths: Widths): Widths {
  const total = Math.max(1024, widths.total);
  const left = Math.max(200, Math.min(widths.left, total - 16 - 480 - 200));
  const right = Math.max(200, Math.min(widths.right, total - 16 - 480 - left));
  return { left, right, total };
}
function WorkspaceSession({ children, t, leftCollapsed = false }: ResizableWorkspaceProps) {
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const [widths, setWidths] = useState<Widths>({ left: 260, right: 264, total: 1024 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => {
      const total = Math.max(1024, element.getBoundingClientRect().width);
      setWidths((current) =>
        current.total === total ? current : normalize({ ...current, total }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      const active = drag.current;
      drag.current = null;
      if (active?.handle.hasPointerCapture(active.pointer)) {
        active.handle.releasePointerCapture(active.pointer);
      }
    };
  }, []);
  const finish = useCallback((cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (cancel) setWidths((current) => normalize({ ...active.initial, total: current.total }));
    setDragging(false);
    if (active.handle.hasPointerCapture(active.pointer))
      active.handle.releasePointerCapture(active.pointer);
  }, []);
  useLayoutEffect(() => {
    if (leftCollapsed && drag.current?.side === 'left') finish(true);
  }, [leftCollapsed, finish]);
  function setSide(side: Side, value: number) {
    setWidths((current) => ({
      ...current,
      [side]: Math.max(
        200,
        Math.min(value, current.total - 496 - current[side === 'left' ? 'right' : 'left']),
      ),
    }));
  }
  return (
    <main
      ref={root}
      className={`grid min-h-0 min-w-[1024px] flex-1 ${dragging ? 'select-none' : ''}`}
      style={{
        gridTemplateColumns: leftCollapsed
          ? `minmax(480px,1fr) 8px ${widths.right}px`
          : `${widths.left}px 8px minmax(480px,1fr) 8px ${widths.right}px`,
      }}
    >
      <div
        id={`${id}-left`}
        hidden={leftCollapsed}
        role="group"
        aria-label={t('左ペイン')}
        tabIndex={leftCollapsed ? -1 : 0}
        className={leftCollapsed ? 'hidden' : paneClassName}
      >
        {children[0]}
      </div>
      {!leftCollapsed && (
        <PaneSeparator
          side="left"
          id={id}
          widths={widths}
          t={t}
          drag={drag}
          setDragging={setDragging}
          setSide={setSide}
          finish={finish}
        />
      )}
      <div role="group" aria-label={t('中央ペイン')} tabIndex={0} className={paneClassName}>
        {children[1]}
      </div>
      <PaneSeparator
        side="right"
        id={id}
        widths={widths}
        t={t}
        drag={drag}
        setDragging={setDragging}
        setSide={setSide}
        finish={finish}
      />
      <div
        id={`${id}-right`}
        role="group"
        aria-label={t('右ペイン')}
        tabIndex={0}
        className={paneClassName}
      >
        {children[2]}
      </div>
    </main>
  );
}
function PaneSeparator({
  side,
  id,
  widths,
  t,
  drag: dragRef,
  setDragging,
  setSide,
  finish,
}: {
  side: Side;
  id: string;
  widths: Widths;
  t: (text: string) => string;
  drag: RefObject<DragState | null>;
  setDragging: (value: boolean) => void;
  setSide: (side: Side, value: number) => void;
  finish: (cancel: boolean) => void;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t(side === 'left' ? '左ペインの幅を変更' : '右ペインの幅を変更')}
      aria-controls={`${id}-${side}`}
      aria-valuemin={200}
      aria-valuemax={widths.total - 496 - widths[side === 'left' ? 'right' : 'left']}
      aria-valuenow={widths[side]}
      aria-valuetext={`${widths[side]} ${t('ピクセル')}`}
      className="relative cursor-col-resize touch-none bg-border/40 hover:bg-primary/40 focus-visible:z-20 focus-visible:bg-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          side,
          pointer: event.pointerId,
          x: event.clientX,
          initial: widths,
          handle: event.currentTarget,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const active = dragRef.current;
        if (!active || active.pointer !== event.pointerId || active.handle !== event.currentTarget)
          return;
        setSide(
          side,
          active.initial[side] + (event.clientX - active.x) * (side === 'left' ? 1 : -1),
        );
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointer === event.pointerId) finish(false);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointer === event.pointerId) finish(true);
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointer === event.pointerId) finish(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (dragRef.current) {
            event.preventDefault();
            finish(true);
          }
          return;
        }
        if (dragRef.current) return;
        const max = widths.total - 496 - widths[side === 'left' ? 'right' : 'left'];
        const step = event.shiftKey ? 50 : 10;
        let value: number;
        if (event.key === 'Home') value = 200;
        else if (event.key === 'End') value = max;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          value =
            widths[side] +
            (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * step;
        } else return;
        event.preventDefault();
        setSide(side, value);
      }}
    />
  );
}
