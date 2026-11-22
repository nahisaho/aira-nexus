import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  Clock3,
  GripVertical,
  FolderClosed,
  FolderPlus,
  MoreVertical,
  PanelLeftClose,
  Pin,
  PinOff,
  Search,
  Archive,
} from 'lucide-react';
import type { Project } from '../../shared/contracts';
import type { BrowserAuth } from '../auth';
import type { ProjectsApi } from '../api';
import type { ProjectPinsApi } from '../project-pins-api';
import { ProjectPinsUnavailable } from '../project-pins-api';
import type { ProjectOrderApi } from '../project-order-api';
import type { ProjectOrderMove } from '../../shared/project-order';
import { useProjectOrder } from '../use-project-order';
import type { BeginProjectWrite } from '../use-project-order';
import { ApiError } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useProjectDialogs } from './project-dialogs';
import type { ProjectManagementApi } from '../project-management-api';

type PinPhase = 'loading' | 'ready' | 'saving' | 'error' | 'unavailable';
const menuItemClassName =
  'flex cursor-default select-none items-center rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
interface Props {
  auth: BrowserAuth;
  api: ProjectsApi;
  managementApi?: ProjectManagementApi;
  projects: Project[];
  selectedId: string | null;
  loading: boolean;
  busy: boolean;
  pinsApi: ProjectPinsApi;
  orderApi: ProjectOrderApi;
  beginWrite: BeginProjectWrite;
  captureSession: () => () => boolean;
  onSelect: (id: string) => void;
  onProjectSaved: (project: Project, select: boolean) => void;
  onProjectTrashed: (id: string) => void;
  onReload: () => void;
  onAuthenticationError: (cause: unknown) => void;
  onCollapse: () => void;
  collapseRef: Ref<HTMLButtonElement>;
  footer: ReactNode;
  t: (text: string) => string;
}

/** @id CODE-SID-007 @implements REQ-SID-003 REQ-SID-004 REQ-SID-008 REQ-SID-009 */
export function ProjectSidebar({
  auth,
  api,
  managementApi,
  projects,
  selectedId,
  loading,
  busy,
  pinsApi,
  orderApi,
  beginWrite,
  captureSession,
  onSelect,
  onProjectSaved,
  onProjectTrashed,
  onReload,
  onAuthenticationError,
  onCollapse,
  collapseRef,
  footer,
  t,
}: Props) {
  const [pinIds, setPinIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<PinPhase>('loading');
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const settingsButtons = useRef(new Map<string, HTMLButtonElement>());
  const pinMenuFocus = useRef<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const pendingWrite = useRef(false);
  const disabledService = useRef(false);
  const drag = useRef<{ group: ProjectOrderMove['group']; id: string } | null>(null);
  const moveFocus = useRef<HTMLElement | null>(null);
  const order = useProjectOrder(
    orderApi,
    captureSession,
    beginWrite,
    onAuthenticationError,
    JSON.stringify([projects.map((project) => [project.id, project.updatedAt]), pinIds]),
  );
  useEffect(() => {
    const target = moveFocus.current;
    if (order.phase !== 'ready' || busy || !target) return;
    if (
      target.isConnected &&
      (document.activeElement === document.body || document.activeElement === target)
    )
      target.focus();
    moveFocus.current = null;
  }, [order.phase, order.snapshot, busy]);
  useEffect(() => {
    const id = pinMenuFocus.current;
    if (!id || busy || loading || phase === 'loading' || phase === 'saving') return;
    const target = settingsButtons.current.get(id);
    if (
      target?.isConnected &&
      (document.activeElement === document.body || document.activeElement === target)
    )
      target.focus();
    pinMenuFocus.current = null;
  }, [phase, busy, loading, pinIds]);
  const changePhase = useCallback((next: PinPhase) => {
    disabledService.current = next === 'unavailable';
    setPhase(next);
  }, []);
  const failed = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthenticationError(cause);
      } else if (cause instanceof ProjectPinsUnavailable) {
        setError('');
        changePhase('unavailable');
      } else {
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'ピン留めの操作に失敗しました。再試行してください。',
        );
        changePhase('error');
      }
    },
    [onAuthenticationError, changePhase],
  );
  const reloadPins = useCallback(async () => {
    if (pendingWrite.current) return;
    const sessionCurrent = captureSession();
    const generation = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    changePhase('loading');
    setError('');
    try {
      const ids = await pinsApi.list(controller.signal);
      if (
        mounted.current &&
        generation === sequence.current &&
        !controller.signal.aborted &&
        sessionCurrent()
      ) {
        setPinIds(ids);
        changePhase('ready');
      }
    } catch (cause) {
      if (
        mounted.current &&
        generation === sequence.current &&
        !controller.signal.aborted &&
        sessionCurrent()
      )
        failed(cause);
    }
  }, [pinsApi, captureSession, changePhase, failed]);
  useEffect(() => {
    mounted.current = true;
    void reloadPins();
    const focus = () => {
      if (!disabledService.current) void reloadPins();
    };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      request.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, [reloadPins]);
  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);
  async function togglePin(project: Project) {
    if (phase !== 'ready' || pendingWrite.current || busy || loading) return;
    const release = beginWrite();
    if (!release) return;
    const sessionCurrent = captureSession();
    const generation = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    pendingWrite.current = true;
    changePhase('saving');
    setError('');
    try {
      const ids = await pinsApi.set(project.id, !pinIds.includes(project.id), controller.signal);
      if (
        mounted.current &&
        generation === sequence.current &&
        !controller.signal.aborted &&
        sessionCurrent()
      ) {
        setPinIds(ids);
        changePhase('ready');
      }
    } catch (cause) {
      if (
        mounted.current &&
        generation === sequence.current &&
        !controller.signal.aborted &&
        sessionCurrent()
      )
        failed(cause);
    } finally {
      release();
      if (mounted.current && generation === sequence.current) pendingWrite.current = false;
    }
  }
  function closeSearch() {
    setSearching(false);
    setQuery('');
    searchButton.current?.focus();
  }
  const dialogs = useProjectDialogs({
    auth,
    api,
    managementApi,
    busy,
    captureSession,
    beginWrite,
    onProjectSaved,
    onProjectTrashed,
    onReload: () => {
      onReload();
      void reloadPins();
    },
    onAuthenticationError,
    pinsPending: phase === 'saving',
    fallbackFocus: (id) => (id ? settingsButtons.current.get(id) : null) ?? createButton.current,
    t,
  });
  const term = query.trim().toLocaleLowerCase();
  const matches = (project: Project) => project.name.toLocaleLowerCase().includes(term);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const pinnedSet = new Set(pinIds);
  const pinnedDefaults = pinIds.flatMap((id) => {
    const project = byId.get(id);
    return project && matches(project) ? [project] : [];
  });
  const recentDefaults = projects.filter(
    (project) => !pinnedSet.has(project.id) && matches(project),
  );
  function ranked(defaults: Project[], group: ProjectOrderMove['group']) {
    const saved = order.snapshot?.[group] ?? [];
    const rankedIds = new Set(saved);
    const visible = new Map(defaults.map((project) => [project.id, project]));
    return [
      ...defaults.filter((project) => !rankedIds.has(project.id)),
      ...saved.flatMap((id) => (visible.has(id) ? [visible.get(id)!] : [])),
    ];
  }
  const pinned = ranked(pinnedDefaults, 'pinned');
  const recent = ranked(recentDefaults, 'recent');
  const moveDisabled = busy || loading || phase !== 'ready' || order.phase !== 'ready' || !!term;
  function moveRow(group: ProjectOrderMove['group'], projectId: string, beforeId: string | null) {
    if (moveDisabled || beforeId === projectId) return;
    moveFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void order.move({ group, projectId, beforeId });
  }
  function rows(items: Project[], group: ProjectOrderMove['group']) {
    return items.map((project, index) => {
      const isPinned = pinnedSet.has(project.id);
      return (
        <li
          key={project.id}
          className="group/project-row flex min-w-0 items-center gap-1"
          onDragOver={(event) => {
            if (!moveDisabled && drag.current?.group === group && drag.current.id !== project.id) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(event) => {
            const source = drag.current;
            drag.current = null;
            if (moveDisabled || !source || source.group !== group || source.id === project.id)
              return;
            event.preventDefault();
            event.stopPropagation();
            const sourceIndex = items.findIndex((item) => item.id === source.id);
            if (sourceIndex < 0) return;
            moveRow(
              group,
              source.id,
              sourceIndex < index ? (items[index + 1]?.id ?? null) : project.id,
            );
          }}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 cursor-grab active:cursor-grabbing"
            aria-label={`${t('並べ替え')}: ${project.name}`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            title={t('ドラッグして並べ替え（キーボードでは上下キー）')}
            disabled={moveDisabled}
            draggable={!moveDisabled}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              if (event.key === 'ArrowUp' && index > 0)
                moveRow(group, project.id, items[index - 1]!.id);
              else if (event.key === 'ArrowDown' && index < items.length - 1)
                moveRow(group, project.id, items[index + 2]?.id ?? null);
            }}
            onDragStart={(event) => {
              if (moveDisabled) {
                event.preventDefault();
                return;
              }
              drag.current = { group, id: project.id };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-aira-project-order', project.id);
            }}
            onDragEnd={() => {
              drag.current = null;
            }}
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <Button
            variant={selectedId === project.id ? 'secondary' : 'ghost'}
            className="min-w-0 flex-1 justify-start"
            aria-pressed={selectedId === project.id}
            onClick={() => onSelect(project.id)}
            disabled={busy}
          >
            <FolderClosed aria-hidden="true" className="shrink-0" />
            <span className="truncate">{project.name}</span>
          </Button>
          <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover/project-row:opacity-100 has-[:focus-visible]:opacity-100">
            {phase !== 'unavailable' && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={`${t(isPinned ? 'ピン留めを外す' : 'ピン留めする')}: ${project.name}`}
                disabled={busy || loading || phase !== 'ready'}
                onClick={() => void togglePin(project)}
              >
                {isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </Button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={`${t('プロジェクト設定')}: ${project.name}`}
                  ref={(button) => {
                    if (button) settingsButtons.current.set(project.id, button);
                    else settingsButtons.current.delete(project.id);
                  }}
                  disabled={busy || loading || phase === 'saving'}
                >
                  <MoreVertical aria-hidden="true" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  aria-label={t('プロジェクト設定')}
                  className="z-40 min-w-48 rounded-md border bg-card p-1 text-foreground shadow-md"
                  onCloseAutoFocus={dialogs.onMenuCloseAutoFocus}
                >
                  <DropdownMenu.Item
                    className={menuItemClassName}
                    onSelect={() => dialogs.openSettings(project)}
                  >
                    {t('プロジェクト設定')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={menuItemClassName}
                    disabled={busy || loading || phase !== 'ready'}
                    onSelect={() => {
                      pinMenuFocus.current = project.id;
                      void togglePin(project);
                    }}
                  >
                    {t(isPinned ? 'ピン留めを外す' : 'ピン留めする')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={menuItemClassName}
                    disabled={busy || loading || dialogs.trashUnavailable}
                    onSelect={() => dialogs.openArchive(project)}
                  >
                    {t('アーカイブ')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </li>
      );
    });
  }
  return (
    <section
      aria-label={t('プロジェクト管理')}
      className="flex min-w-0 flex-col gap-5 border-r bg-card px-4 py-6"
    >
      <div>
        <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">WORKSPACE</p>
        <div className="flex items-center justify-between gap-1">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-primary" />
            <span className="truncate">{t('プロジェクト')}</span>
          </h2>
          <div className="flex shrink-0 items-center">
            <Button
              ref={searchButton}
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('プロジェクトを検索')}
              title={t('プロジェクトを検索')}
              aria-expanded={searching}
              onClick={() => (searching ? closeSearch() : setSearching(true))}
            >
              <Search aria-hidden="true" />
            </Button>
            <Button
              ref={collapseRef}
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('左ペインを折りたたむ')}
              title={t('左ペインを折りたたむ')}
              onClick={onCollapse}
            >
              <PanelLeftClose aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      {searching && (
        <div>
          <Label htmlFor="project-search" className="sr-only">
            {t('プロジェクト名で検索')}
          </Label>
          <Input
            ref={searchInput}
            id="project-search"
            type="search"
            value={query}
            placeholder={t('プロジェクト名で検索')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }}
          />
        </div>
      )}
      <div className="space-y-3">
        <Button
          ref={createButton}
          variant="outline"
          className="w-full justify-start"
          disabled={busy || loading}
          onClick={dialogs.openCreate}
        >
          <FolderPlus aria-hidden="true" />
          {t('新しいプロジェクト')}
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={dialogs.openTrash}
          disabled={busy || loading || dialogs.trashUnavailable}
        >
          <Archive aria-hidden="true" />
          {t('アーカイブ')}
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('読み込み中…')}
        </p>
      )}
      {!loading && !projects.length && (
        <p className="text-sm leading-6 text-muted-foreground">
          {t('プロジェクトはまだありません。')}
        </p>
      )}
      {term && <p className="text-xs text-muted-foreground">{t('検索中は並べ替えできません。')}</p>}
      {order.phase === 'loading' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('並び順を読み込み中…')}
        </p>
      )}
      {order.phase === 'saving' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('並び順を保存中…')}
        </p>
      )}
      {order.phase === 'unavailable' && (
        <p className="text-xs text-muted-foreground">{t('並べ替えは現在利用できません。')}</p>
      )}
      {order.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {t(order.error)}
        </p>
      )}
      {(order.phase === 'error' || order.phase === 'unavailable') && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void order.reload()}>
          {t('並び順を再読み込み')}
        </Button>
      )}
      <ul aria-label={t('プロジェクト一覧')} className="space-y-5">
        <li className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Pin aria-hidden="true" className="size-3.5" />
            {t('ピン留め')}
          </h3>
          {phase === 'loading' && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('ピン留めを読み込み中…')}
            </p>
          )}
          {phase === 'unavailable' && (
            <p className="text-xs text-muted-foreground">{t('ピン留めは現在利用できません。')}</p>
          )}
          {phase === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {t('ピン留め')}: {t(error)}
            </p>
          )}
          {(phase === 'error' || phase === 'unavailable') && (
            <Button variant="ghost" size="sm" onClick={() => void reloadPins()}>
              {t('ピン留めを再読み込み')}
            </Button>
          )}
          <ul aria-label={t('ピン留め')} className="space-y-1">
            {rows(pinned, 'pinned')}
            {!pinned.length && phase === 'ready' && (
              <li className="px-3 text-xs leading-6 text-muted-foreground">
                {t(term ? '一致するプロジェクトがありません。' : 'ピン留めはありません。')}
              </li>
            )}
          </ul>
        </li>
        <li className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Clock3 aria-hidden="true" className="size-3.5" />
            {t('最近のプロジェクト')}
          </h3>
          <ul aria-label={t('最近のプロジェクト')} className="space-y-1">
            {rows(recent, 'recent')}
            {!recent.length && !loading && (
              <li className="px-3 text-xs leading-6 text-muted-foreground">
                {t(
                  term ? '一致するプロジェクトがありません。' : '最近のプロジェクトはありません。',
                )}
              </li>
            )}
          </ul>
        </li>
      </ul>
      {footer}
      {dialogs.dialog}
    </section>
  );
}
