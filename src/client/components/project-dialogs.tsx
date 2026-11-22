import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import type { Project } from '../../shared/contracts';
import type { BrowserAuth } from '../auth';
import type { ProjectsApi } from '../api';
import { ApiError } from '../api';
import { createProjectManagementApi, projectManagementInput } from '../project-management-api';
import type { ManagedProject, ProjectManagementApi } from '../project-management-api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface Props {
  auth: BrowserAuth;
  api: ProjectsApi;
  managementApi?: ProjectManagementApi;
  busy: boolean;
  captureSession: () => () => boolean;
  beginWrite: () => (() => void) | null;
  onProjectSaved: (project: Project, select: boolean) => void;
  onProjectTrashed: (id: string) => void;
  onReload: () => void;
  onAuthenticationError: (cause: unknown) => void;
  pinsPending: boolean;
  fallbackFocus: (projectId?: string) => HTMLButtonElement | null;
  t: (text: string) => string;
}
type Capability = 'loading' | 'enabled' | 'disabled' | 'error';
type Mode = 'create' | 'settings' | 'trash' | 'archive' | null;
const failedMessage = 'プロジェクト設定を取得・保存できませんでした。再試行してください。';

/** @id CODE-DLG-002 @implements REQ-DLG-001 REQ-DLG-002 REQ-DLG-003 REQ-DLG-004 */
export function useProjectDialogs(props: Props) {
  const { auth, captureSession, onAuthenticationError, t } = props;
  const latest = useRef(props);
  const management = useMemo(
    () => props.managementApi ?? createProjectManagementApi(auth),
    [auth, props.managementApi],
  );
  const [capability, setCapability] = useState<Capability>('loading');
  const [capabilityError, setCapabilityError] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [detail, setDetail] = useState<ManagedProject | null>(null);
  const [items, setItems] = useState<ManagedProject[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const capabilitySequence = useRef(0);
  const capabilityRequest = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const releaseWrite = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const archiveFocus = useRef(false);
  const activeMode = useRef(mode);
  useLayoutEffect(() => {
    latest.current = props;
    activeMode.current = mode;
  });

  useEffect(() => {
    if (!mode || mode === 'archive') return;
    const panel = () => (activeMode.current ? content.current : null);
    const focusable = () =>
      Array.from(
        panel()?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.closest('[hidden]'));
    const containFocus = () => {
      const currentPanel = panel();
      if (
        currentPanel &&
        (!currentPanel.contains(document.activeElement) ||
          document.activeElement?.matches(':disabled'))
      ) {
        (focusable()[0] ?? currentPanel).focus();
      }
    };
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel()) return;
      const controls = focusable();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (
        index < 0 ||
        (!event.shiftKey && index === controls.length - 1) ||
        (event.shiftKey && index === 0)
      ) {
        event.preventDefault();
        ((event.shiftKey ? controls.at(-1) : controls[0]) ?? panel())?.focus();
      }
    };
    // Disabling the submitted control can otherwise leave focus on a body guard.
    containFocus();
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', tab, true);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', tab, true);
    };
  }, [mode, pending]);

  const loadCapabilities = useCallback(async () => {
    const sessionCurrent = captureSession();
    const generation = ++capabilitySequence.current;
    capabilityRequest.current?.abort();
    const controller = new AbortController();
    capabilityRequest.current = controller;
    const valid = () =>
      mounted.current &&
      generation === capabilitySequence.current &&
      !controller.signal.aborted &&
      sessionCurrent();
    setCapability('loading');
    setCapabilityError('');
    try {
      const enabled = await management.capabilities(controller.signal);
      if (valid()) setCapability(enabled ? 'enabled' : 'disabled');
    } catch (cause) {
      if (!valid()) return;
      if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
      else {
        setCapability('error');
        setCapabilityError(cause instanceof ApiError ? cause.message : failedMessage);
      }
    }
  }, [captureSession, management, onAuthenticationError]);

  useEffect(() => {
    mounted.current = true;
    void loadCapabilities();
    return () => {
      mounted.current = false;
      request.current?.abort();
      capabilityRequest.current?.abort();
      releaseWrite.current?.();
    };
  }, [loadCapabilities]);

  const run = useCallback(
    async <T,>(
      action: (signal: AbortSignal) => Promise<T>,
      accept: (result: T) => void,
      write = false,
    ) => {
      if (pendingRef.current) return;
      const release = write ? latest.current.beginWrite() : null;
      if (write && !release) return;
      const sessionCurrent = captureSession();
      const generation = ++sequence.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      pendingRef.current = true;
      releaseWrite.current = release;
      setPending(true);
      setError('');
      const valid = () =>
        mounted.current &&
        generation === sequence.current &&
        !controller.signal.aborted &&
        sessionCurrent();
      try {
        const result = await action(controller.signal);
        if (valid()) accept(result);
      } catch (cause) {
        if (!valid()) return;
        if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
        else setError(cause instanceof ApiError ? cause.message : failedMessage);
      } finally {
        release?.();
        if (valid()) {
          pendingRef.current = false;
          releaseWrite.current = null;
          setPending(false);
        }
      }
    },
    [captureSession, onAuthenticationError],
  );

  const readDetail = useCallback(
    (target: Project) => {
      setDetail(null);
      void run(
        (signal) => management.get(target.id, signal),
        (result) => {
          if (result.project.id !== target.id) throw new ApiError(502, failedMessage);
          setDetail(result);
          setName(result.project.name);
          setDescription(result.description);
          latest.current.onProjectSaved(result.project, false);
        },
      );
    },
    [management, run],
  );
  const readTrash = useCallback(() => {
    void run((signal) => management.trash(signal), setItems);
  }, [management, run]);
  useEffect(() => {
    if (capability !== 'enabled') return;
    if (mode === 'settings' && project) readDetail(project);
    else if (mode === 'trash') readTrash();
  }, [capability, mode, project, readDetail, readTrash]);

  function close(refreshPending = true) {
    const interrupted = pendingRef.current && refreshPending;
    sequence.current++;
    request.current?.abort();
    releaseWrite.current?.();
    releaseWrite.current = null;
    pendingRef.current = false;
    setPending(false);
    activeMode.current = null;
    setMode(null);
    setDetail(null);
    setItems([]);
    setError('');
    if (interrupted) latest.current.onReload();
  }
  function open(next: Exclude<Mode, null>, target?: Project) {
    trigger.current =
      (target ? latest.current.fallbackFocus(target.id) : null) ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setProject(target ?? null);
    setName(target?.name ?? '');
    setDescription('');
    setDetail(null);
    setItems([]);
    setError('');
    activeMode.current = next;
    setMode(next);
  }
  function retry() {
    if (pendingRef.current) return;
    if (mode === 'archive' && project) archive(project);
    else if (capability === 'error') void loadCapabilities();
    else if (mode === 'settings' && project && capability === 'enabled') readDetail(project);
    else if (mode === 'trash' && capability === 'enabled') readTrash();
  }
  async function save() {
    if (
      pendingRef.current ||
      props.busy ||
      props.pinsPending ||
      !['enabled', 'disabled'].includes(capability) ||
      (mode === 'settings' && (!project || (capability === 'enabled' && !detail)))
    )
      return;
    let input: { name: string; description: string };
    try {
      input = projectManagementInput(name, capability === 'enabled' ? description : '');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : failedMessage);
      return;
    }
    await run(
      async (signal) => {
        if (capability === 'disabled') {
          const saved =
            mode === 'create'
              ? await props.api.create(input.name, signal)
              : await props.api.rename(project!, input.name, signal);
          return saved;
        }
        const saved =
          mode === 'create'
            ? await management.create(input.name, input.description, signal)
            : await management.update(detail!, input.name, input.description, signal);
        if (mode === 'settings' && saved.project.id !== project?.id)
          throw new ApiError(502, failedMessage);
        return saved.project;
      },
      (saved) => {
        latest.current.onProjectSaved(saved, mode === 'create');
        close(false);
      },
      true,
    );
  }
  function archive(target: Project) {
    if (pendingRef.current || props.busy || props.pinsPending) return;
    const sessionCurrent = captureSession();
    void run(
      async (signal) => {
        open('archive', target);
        archiveFocus.current = true;
        const checkSession = () => {
          if (signal.aborted || !sessionCurrent())
            throw new DOMException('Archive session changed.', 'AbortError');
        };
        if (capability !== 'enabled') {
          const enabled = await management.capabilities(signal);
          checkSession();
          setCapability(enabled ? 'enabled' : 'disabled');
          setCapabilityError('');
          if (!enabled) throw new ApiError(503, 'プロジェクト設定は現在利用できません。');
        }
        const current = await management.get(target.id, signal);
        checkSession();
        if (current.project.id !== target.id) throw new ApiError(502, failedMessage);
        return management.transition(current, 'trash', signal);
      },
      (saved) => {
        if (saved.project.id !== target.id) throw new ApiError(502, failedMessage);
        latest.current.onProjectTrashed(saved.project.id);
        latest.current.onReload();
        close(false);
      },
      true,
    );
  }
  function restore(item: ManagedProject) {
    if (capability !== 'enabled' || props.busy || props.pinsPending) return;
    void run(
      (signal) => management.transition(item, 'restore', signal),
      (saved) => {
        if (saved.project.id !== item.project.id) throw new ApiError(502, failedMessage);
        setItems((current) => current.filter((value) => value.project.id !== saved.project.id));
        latest.current.onProjectSaved(saved.project, false);
        latest.current.onReload();
      },
      true,
    );
  }
  const blocked = pending || props.busy || props.pinsPending;
  const ready = capability === 'enabled' || capability === 'disabled';
  const writable = ready && (mode !== 'settings' || capability === 'disabled' || detail !== null);
  const failure = capabilityError || error;
  const title =
    mode === 'create' ? '新しいプロジェクト' : mode === 'trash' ? 'アーカイブ' : 'プロジェクト設定';
  const restoreFocus = useCallback(
    (event?: Event) => {
      event?.preventDefault();
      const target = trigger.current?.isConnected
        ? trigger.current
        : latest.current.fallbackFocus(project?.id);
      target?.focus();
    },
    [project?.id],
  );
  useEffect(() => {
    if (!archiveFocus.current || pending || props.busy || props.pinsPending) return;
    archiveFocus.current = false;
    if (document.activeElement === document.body || document.activeElement === trigger.current)
      restoreFocus();
  }, [pending, props.busy, props.pinsPending, restoreFocus]);
  const alert = failure ? (
    <p role="alert" className="text-sm text-destructive">
      {t(failure)}
    </p>
  ) : null;
  const dialog = (
    <>
      <Dialog.Root
        open={mode !== null && mode !== 'archive'}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content
            ref={content}
            aria-modal="true"
            className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl"
            onCloseAutoFocus={restoreFocus}
          >
            <Dialog.Title className="text-xl font-semibold">{t(title)}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {t(
                mode === 'trash'
                  ? 'アーカイブしたプロジェクトは復元できます。完全な削除は行いません。'
                  : '名前と説明を保存します。変更はサーバーの確認後に反映されます。',
              )}
            </Dialog.Description>
            {capability === 'loading' && <p role="status">{t('読み込み中…')}</p>}
            {capability === 'disabled' && <p>{t('プロジェクト設定は現在利用できません。')}</p>}
            {alert}
            {(capability === 'error' || (error && capability === 'enabled')) && (
              <Button variant="outline" disabled={blocked} onClick={retry}>
                {t('プロジェクト設定を再読み込み')}
              </Button>
            )}
            {mode === 'trash' ? (
              <>
                {pending && <p role="status">{t('読み込み中…')}</p>}
                <ul aria-label={t('アーカイブ済みのプロジェクト')} className="space-y-3">
                  {items.map((item) => (
                    <li key={item.project.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 break-words">{item.project.name}</span>
                      <Button
                        disabled={blocked || capability !== 'enabled'}
                        onClick={() => restore(item)}
                        aria-label={`${t('復元')}: ${item.project.name}`}
                      >
                        {t('復元')}
                      </Button>
                    </li>
                  ))}
                </ul>
                {capability === 'enabled' && !pending && !failure && items.length === 0 && (
                  <p>{t('アーカイブは空です。')}</p>
                )}
                <Button variant="ghost" onClick={() => close()}>
                  {t('閉じる')}
                </Button>
              </>
            ) : (
              <>
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="project-dialog-name">
                      {t(mode === 'create' ? '新しいプロジェクト名' : 'プロジェクト名')}
                    </Label>
                    <Input
                      id="project-dialog-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={blocked}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="project-dialog-description">{t('プロジェクトの説明')}</Label>
                    <textarea
                      id="project-dialog-description"
                      rows={5}
                      value={description}
                      className="w-full rounded-md border bg-background p-3 text-sm"
                      disabled={
                        blocked || capability !== 'enabled' || (mode === 'settings' && !detail)
                      }
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={blocked || !writable || !name.trim()}>
                      {t(mode === 'create' ? 'プロジェクトを作成' : '変更を保存')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => close()}>
                      {t('キャンセル')}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {mode === 'archive' && (
        <div className="space-y-2" aria-busy={pending}>
          {pending && <p role="status">{t('アーカイブ中…')}</p>}
          {alert}
          {error && (
            <Button variant="outline" disabled={blocked} onClick={retry}>
              {t('アーカイブを再試行')}
            </Button>
          )}
        </div>
      )}
    </>
  );
  return {
    openCreate: () => open('create'),
    openSettings: (target: Project) => open('settings', target),
    openArchive: archive,
    openTrash: () => open('trash'),
    onMenuCloseAutoFocus: (event: Event) => {
      if (activeMode.current && activeMode.current !== 'archive') event.preventDefault();
    },
    dialog,
    pending,
    trashUnavailable: capability === 'disabled',
  };
}
