import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, LogOut, Microscope, PanelLeftOpen, ShieldCheck } from 'lucide-react';
import type { BrowserAuth, UserAccount } from './auth';
import { ApiError } from './api';
import type { ProjectsApi } from './api';
import type { ProjectPinsApi } from './project-pins-api';
import { createProjectOrderApi } from './project-order-api';
import type { ProjectOrderApi } from './project-order-api';
import type { Project } from '../shared/contracts';
import { Button } from './components/ui/button';
import { WorkspaceTabs } from './components/workspace-tabs';
import { ResizableWorkspace } from './components/resizable-workspace';
import { CopilotSettings } from './components/copilot-settings';
import type { PreferencesApi, TextSizeApi } from './preferences-api';
import { useUserPreferences } from './use-user-preferences';
import { useTextSize } from './use-text-size';
import type { FilesApi } from './files-api';
import type { ProjectFile } from '../shared/files';
import type { WorkspaceTabsHandle } from './components/workspace-tabs';
import { FileViewer, ProjectFiles, interruptedUploadMessage } from './components/project-files';
import { ProjectSidebar } from './components/project-sidebar';
import type { ProjectManagementApi } from './project-management-api';
import { createConversionsApi } from './conversions-api';
import type { ConversionsApi } from './conversions-api';
import { ConversionJobs } from './components/conversion-jobs';
import { createChatApi } from './chat-api';
import type { ChatApi } from './chat-api';
import { ProjectChat } from './components/project-chat';
import { Notebook } from './components/notebook';
import { createNotebookApi } from './notebook-api';
import type { NotebookApi } from './notebook-api';

const ordered = (projects: Project[]) =>
  [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));

/** @id CODE-UI-003 @implements REQ-UI-001 REQ-UI-002 REQ-UI-003 REQ-SID-003 REQ-SID-005 REQ-SCR-001 */
export function App({
  auth,
  api,
  chatApi: injectedChatApi,
  managementApi,
  pinsApi,
  preferencesApi,
  textSizeApi,
  filesApi,
  orderApi: injectedOrderApi,
  conversionsApi: injectedConversionsApi,
  notebookApi: injectedNotebookApi,
}: {
  auth: BrowserAuth;
  api: ProjectsApi;
  chatApi?: ChatApi;
  managementApi?: ProjectManagementApi;
  pinsApi: ProjectPinsApi;
  preferencesApi: PreferencesApi;
  textSizeApi: TextSizeApi;
  filesApi: FilesApi;
  orderApi?: ProjectOrderApi;
  conversionsApi?: ConversionsApi;
  notebookApi?: NotebookApi;
}) {
  const [user, setUser] = useState<UserAccount | null>(() => auth.account());
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedProject = useRef<string | null>(null);
  const projectGeneration = useRef(0);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const selectProject = useCallback((id: string | null) => {
    if (selectedProject.current === id) return;
    selectedProject.current = id;
    projectGeneration.current++;
    setProjectEpoch(projectGeneration.current);
    setSelectedId(id);
  }, []);
  const [session, setSession] = useState(0);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreCollapseFocus = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const projectWrite = useRef<symbol | null>(null);
  const orderApi = useMemo(
    () => injectedOrderApi ?? createProjectOrderApi(auth),
    [auth, injectedOrderApi],
  );
  const conversionsApi = useMemo(
    () => injectedConversionsApi ?? createConversionsApi(auth),
    [auth, injectedConversionsApi],
  );
  const chatApi = useMemo(() => injectedChatApi ?? createChatApi(auth), [auth, injectedChatApi]);
  const notebookApi = useMemo(
    () => injectedNotebookApi ?? createNotebookApi(auth),
    [auth, injectedNotebookApi],
  );
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [jobsRevision, setJobsRevision] = useState(0);
  const mounted = useRef(false);
  const controller = useRef(new AbortController());
  const selected = projects.find((project) => project.id === selectedId);
  const scopeKey = JSON.stringify([user?.id ?? null, selectedId, session, projectEpoch]);
  const tabsRef = useRef<WorkspaceTabsHandle | null>(null);
  const [opened, setOpened] = useState<{ scopeKey: string; files: Record<string, ProjectFile> }>({
    scopeKey: '',
    files: {},
  });
  const uploadInterrupted = useCallback(() => setError(interruptedUploadMessage), []);
  useEffect(() => {
    if (leftCollapsed) expandButton.current?.focus();
    else if (restoreCollapseFocus.current) {
      collapseButton.current?.focus();
      restoreCollapseFocus.current = false;
    }
  }, [leftCollapsed]);
  useEffect(
    () =>
      setOpened((current) => (current.scopeKey === scopeKey ? current : { scopeKey, files: {} })),
    [scopeKey],
  );

  const resetRequests = useCallback(() => {
    epoch.current++;
    projectWrite.current = null;
    controller.current.abort();
    controller.current = new AbortController();
  }, []);
  const changeSession = useCallback(
    (account: UserAccount | null) => {
      resetRequests();
      setUser(account);
      setProjects([]);
      selectProject(null);
      setSession((value) => value + 1);
      setLeftCollapsed(false);
      restoreCollapseFocus.current = false;
      setLoading(false);
      setBusy(false);
    },
    [resetRequests, selectProject],
  );
  const current = useCallback(
    (generation: number, accountId: string) =>
      mounted.current && epoch.current === generation && auth.account()?.id === accountId,
    [auth],
  );
  const capturePinSession = useCallback(() => {
    const generation = epoch.current;
    const owner = user?.id;
    return () => owner !== undefined && current(generation, owner);
  }, [current, user?.id]);
  /** @id CODE-CJU-005 @implements REQ-CJU-001 REQ-CJU-004 REQ-CJU-005 */
  const captureConversionSession = useCallback(() => {
    const sessionCurrent = capturePinSession();
    return () =>
      sessionCurrent() &&
      projectGeneration.current === projectEpoch &&
      selectedProject.current === selectedId;
  }, [capturePinSession, projectEpoch, selectedId]);
  const openConversionFile = useCallback(
    (file: ProjectFile) => {
      if (!captureConversionSession()()) return;
      setOpened((current) => ({
        scopeKey,
        files: { ...(current.scopeKey === scopeKey ? current.files : {}), [file.id]: file },
      }));
      tabsRef.current?.openFile(file);
    },
    [captureConversionSession, scopeKey],
  );
  const openJobs = useCallback(() => {
    if (!captureConversionSession()()) return;
    setJobsRevision((value) => value + 1);
    tabsRef.current?.openJobs();
  }, [captureConversionSession]);
  const beginProjectWrite = useCallback(() => {
    if (!user || loading || projectWrite.current !== null) return null;
    const ticket = Symbol('project-write');
    const generation = epoch.current;
    const owner = user.id;
    projectWrite.current = ticket;
    setBusy(true);
    return () => {
      if (projectWrite.current === ticket && current(generation, owner)) {
        projectWrite.current = null;
        setBusy(false);
      }
    };
  }, [user, loading, current]);
  const projectSaved = useCallback(
    (saved: Project, select: boolean) => {
      setProjects((items) => ordered([saved, ...items.filter((item) => item.id !== saved.id)]));
      if (select) selectProject(saved.id);
    },
    [selectProject],
  );
  const projectTrashed = useCallback(
    (id: string) => {
      setProjects((items) => items.filter((item) => item.id !== id));
      if (selectedProject.current === id) selectProject(null);
    },
    [selectProject],
  );
  const reloadProjects = useCallback(() => setReload((value) => value + 1), []);
  const showError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        auth.invalidate?.();
        changeSession(null);
      }
      setError(
        cause instanceof ApiError
          ? cause.message
          : '操作を完了できませんでした。接続を確認して再試行してください。',
      );
    },
    [auth, changeSession],
  );
  const preferences = useUserPreferences(auth, user?.id ?? null, preferencesApi, showError);
  const textSize = useTextSize(
    user?.id ?? null,
    session,
    capturePinSession,
    textSizeApi,
    showError,
  );
  const { t } = preferences;
  useEffect(() => {
    mounted.current = true;
    if (controller.current.signal.aborted) controller.current = new AbortController();
    const unsubscribe = auth.subscribe?.(() => {
      changeSession(auth.account());
      setError('');
    });
    return () => {
      mounted.current = false;
      resetRequests();
      unsubscribe?.();
    };
  }, [auth, changeSession, resetRequests]);
  useEffect(() => {
    if (!user) return;
    const generation = epoch.current;
    const request = new AbortController();
    const signal = AbortSignal.any([controller.current.signal, request.signal]);
    setLoading(true);
    void api
      .list(signal)
      .then((items) => {
        if (!signal.aborted && current(generation, user.id)) {
          setProjects(ordered(items));
          selectProject(
            items.some((item) => item.id === selectedProject.current)
              ? selectedProject.current
              : (items[0]?.id ?? null),
          );
        }
      })
      .catch((cause: unknown) => {
        if (!signal.aborted && current(generation, user.id)) showError(cause);
      })
      .finally(() => {
        if (!signal.aborted && current(generation, user.id)) setLoading(false);
      });
    return () => request.abort();
  }, [api, user, reload, current, showError, selectProject]);
  async function signIn() {
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      const account = await auth.signIn();
      if (mounted.current && epoch.current === generation) changeSession(account);
    } catch {
      if (mounted.current && epoch.current === generation)
        setError('サインインが完了しませんでした。もう一度お試しください。');
    } finally {
      if (mounted.current && epoch.current === generation) setBusy(false);
    }
  }
  async function signOut() {
    changeSession(null);
    setError('');
    try {
      await auth.signOut();
    } catch {
      auth.invalidate?.();
      if (mounted.current)
        setError(
          '画面のデータは消去しましたが、Entraからのサインアウトに失敗しました。再度サインインしてからサインアウトするか、ブラウザーを閉じてください。',
        );
    }
  }
  return (
    <div
      className={`${user ? 'flex h-dvh min-w-[1024px] flex-col' : 'min-h-screen'} bg-background text-foreground`}
    >
      <header className="flex h-16 min-w-[640px] shrink-0 items-center justify-between border-b bg-card px-6">
        <a href="/" className="flex items-center gap-3 font-semibold tracking-tight">
          <span className="rounded-xl bg-primary p-2 text-primary-foreground">
            <Microscope aria-hidden="true" className="size-5" />
          </span>
          AIRA <span className="font-normal text-muted-foreground">Nexus</span>
        </a>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden items-center gap-1.5 text-muted-foreground md:flex">
            <ShieldCheck aria-hidden="true" className="size-4" />
            {t('組織内研究ワークスペース')}
          </span>
          {user && (
            <>
              <span>{user.name}</span>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                <LogOut aria-hidden="true" />
                {t('サインアウト')}
              </Button>
            </>
          )}
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="mx-6 mt-4 flex shrink-0 items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <span>{t(error)}</span>
          {user && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError('');
                setReload((value) => value + 1);
              }}
              disabled={busy || loading}
            >
              {t('再読み込み')}
            </Button>
          )}
        </div>
      )}
      {!user ? (
        <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col items-center justify-center px-8 py-20 text-center">
          <div className="mb-8 rounded-3xl border bg-card p-5 text-primary shadow-sm">
            <BookOpen aria-hidden="true" className="size-12" />
          </div>
          <p className="mb-4 text-xs font-semibold tracking-[0.3em] text-primary">
            PRIVATE RESEARCH WORKSPACE
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            {t('研究の文脈を、')}
            <br />
            {t('ひとつのプロジェクトに。')}
          </h1>
          <p className="mb-8 mt-5 max-w-lg text-base leading-8 text-muted-foreground">
            {t('組織のアカウントでサインインし、あなただけの研究プロジェクトを管理できます。')}
          </p>
          <Button size="lg" onClick={() => void signIn()} disabled={busy}>
            {t(busy ? '認証中…' : 'Microsoft Entra ID でサインイン')}
            <ArrowRight aria-hidden="true" />
          </Button>
          <p className="mt-6 text-xs text-muted-foreground">
            {t('基盤①：認証・個人プロジェクト管理。AI・ファイル・Notebookは後続段階で提供します。')}
          </p>
        </main>
      ) : (
        <ResizableWorkspace scopeKey={user.id} t={t} leftCollapsed={leftCollapsed}>
          <ProjectSidebar
            key={JSON.stringify([user.id, session])}
            projects={projects}
            auth={auth}
            api={api}
            managementApi={managementApi}
            selectedId={selectedId}
            loading={loading}
            busy={busy}
            pinsApi={pinsApi}
            orderApi={orderApi}
            beginWrite={beginProjectWrite}
            captureSession={capturePinSession}
            onSelect={selectProject}
            onProjectSaved={projectSaved}
            onProjectTrashed={projectTrashed}
            onReload={reloadProjects}
            onAuthenticationError={showError}
            onCollapse={() => setLeftCollapsed(true)}
            collapseRef={collapseButton}
            t={t}
            footer={
              <div className="mt-auto space-y-3">
                <div className="rounded-lg border bg-background p-3 text-xs leading-6 text-muted-foreground">
                  <ShieldCheck aria-hidden="true" className="mb-1 size-4" />
                  {t('プロジェクトは本人のみアクセスできます。アーカイブから復元できます。')}
                </div>
                <CopilotSettings
                  key={JSON.stringify([user.id, session])}
                  auth={auth}
                  accountId={user.id}
                  onAuthenticationError={showError}
                  onConnectionChange={() => setConnectionEpoch((value) => value + 1)}
                  preferences={preferences}
                  textSize={textSize}
                />
              </div>
            }
          />
          <section aria-label={t('研究ワークスペース')} className="flex min-w-0 flex-col px-8 py-6">
            <div className="mb-6 flex items-start justify-between gap-6">
              {leftCollapsed && (
                <Button
                  ref={expandButton}
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t('左ペインを展開')}
                  title={t('左ペインを展開')}
                  onClick={() => {
                    restoreCollapseFocus.current = true;
                    setLeftCollapsed(false);
                  }}
                >
                  <PanelLeftOpen aria-hidden="true" />
                </Button>
              )}
              <div className="min-w-0">
                <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
                  RESEARCH WORKSPACE
                </p>
                <h1 className="break-words text-2xl font-semibold tracking-tight">
                  {selected?.name ?? t('研究を始めましょう')}
                </h1>
              </div>
              <span className="shrink-0 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
                {t('基盤①')}
              </span>
            </div>
            <WorkspaceTabs
              ref={tabsRef}
              scopeKey={scopeKey}
              t={t}
              jobs={
                selectedId
                  ? (active) => (
                      <ConversionJobs
                        api={conversionsApi}
                        projectId={selectedId}
                        scopeKey={scopeKey}
                        active={active}
                        revision={jobsRevision}
                        captureSession={captureConversionSession}
                        onAuthenticationError={showError}
                        onOpen={openConversionFile}
                        t={t}
                      />
                    )
                  : undefined
              }
              renderFile={(tab) => {
                const file = opened.scopeKey === scopeKey ? opened.files[tab.id] : undefined;
                return file && selectedId ? (
                  <FileViewer
                    key={file.id}
                    scopeKey={scopeKey}
                    projectId={selectedId}
                    file={file}
                    api={filesApi}
                    t={t}
                    onAuthenticationError={showError}
                  />
                ) : null;
              }}
              chat={
                selectedId && user ? (
                  <ProjectChat
                    api={chatApi}
                    auth={auth}
                    accountId={user.id}
                    projectId={selectedId}
                    scopeKey={scopeKey}
                    connectionEpoch={connectionEpoch}
                    onAuthenticationError={showError}
                    t={t}
                  />
                ) : (
                  <p className="m-auto text-sm text-muted-foreground">
                    {t('まずプロジェクトを作成または選択してください。')}
                  </p>
                )
              }
              notebook={
                selectedId && user ? (
                  <Notebook key={scopeKey} api={notebookApi} projectId={selectedId} t={t} />
                ) : (
                  <p>{t('まずプロジェクトを作成または選択してください。')}</p>
                )
              }
            />
          </section>
          <ProjectFiles
            scopeKey={scopeKey}
            projectId={selectedId}
            api={filesApi}
            conversionsApi={conversionsApi}
            onOpenJobs={openJobs}
            t={t}
            onAuthenticationError={showError}
            onUploadInterrupted={uploadInterrupted}
            captureSession={captureConversionSession}
            onTrashed={(file) => {
              tabsRef.current?.closeFile(file.id);
              setOpened((current) => {
                if (current.scopeKey !== scopeKey) return current;
                const files = { ...current.files };
                delete files[file.id];
                return { ...current, files };
              });
            }}
            onOpen={openConversionFile}
          />
        </ResizableWorkspace>
      )}
    </div>
  );
}
