import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { FileCode2, MessageSquare, X } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

export interface WorkspaceFile {
  id: string;
  name: string;
}
export interface WorkspaceTabsHandle {
  openFile(file: WorkspaceFile): void;
  closeFile(id: string): void;
  openJobs(): void;
}
export interface WorkspaceTabsProps {
  scopeKey: string;
  chat: ReactNode;
  notebook: ReactNode;
  jobs?: ReactNode | ((active: boolean) => ReactNode);
  t: (text: string) => string;
  ref?: Ref<WorkspaceTabsHandle>;
  renderFile?: (file: WorkspaceFile) => ReactNode;
}
/** @id CODE-UI-004 @implements REQ-UI-001 REQ-UI-004 REQ-UI-005 REQ-UI-006 REQ-UI-007 */
export function WorkspaceTabs(props: WorkspaceTabsProps) {
  return <WorkspaceTabsSession key={props.scopeKey} {...props} />;
}

const fileValue = (id: string) => `file:${id}`;
const dragType = 'application/x-aira-workspace-tab';
function WorkspaceTabsSession({ chat, notebook, jobs, t, ref, renderFile }: WorkspaceTabsProps) {
  const [state, setState] = useState({
    files: [] as WorkspaceFile[],
    active: 'chat',
    focus: false,
    jobsOpen: false,
  });
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<string | null>(null);
  const instance = useId();
  function close(id: string) {
    if (dragged.current === id) dragged.current = null;
    setState((current) => {
      const index = current.files.findIndex((file) => file.id === id);
      if (index < 0) return current;
      const neighbor = current.files[index + 1] ?? current.files[index - 1];
      return {
        ...current,
        files: current.files.filter((file) => file.id !== id),
        active:
          current.active === fileValue(id)
            ? neighbor
              ? fileValue(neighbor.id)
              : 'chat'
            : current.active,
        focus: true,
      };
    });
  }
  useImperativeHandle(ref, () => ({
    /** @id CODE-CJU-003 @implements REQ-CJU-001 REQ-CJU-005 */
    openJobs() {
      setState((current) => ({ ...current, jobsOpen: true, active: 'jobs', focus: true }));
    },
    openFile(file) {
      if (!file.id.trim() || !file.name.trim()) {
        throw new Error('File tab ID and name must not be blank');
      }
      const metadata = { id: file.id, name: file.name };
      setState((current) => ({
        ...current,
        files: current.files.some((item) => item.id === metadata.id)
          ? current.files.map((item) => (item.id === metadata.id ? metadata : item))
          : [...current.files, metadata],
        active: fileValue(metadata.id),
        focus: false,
      }));
    },
    closeFile: close,
  }));
  useLayoutEffect(() => {
    if (state.focus) triggers.current.get(state.active)?.focus();
  }, [state]);
  function closeJobs() {
    setState((current) => ({
      ...current,
      jobsOpen: false,
      active:
        current.active === 'jobs'
          ? current.files.length
            ? fileValue(current.files[current.files.length - 1]!.id)
            : 'chat'
          : current.active,
      focus: true,
    }));
  }
  function move(source: string, target: string) {
    setState((current) => {
      const from = current.files.findIndex((file) => file.id === source);
      const to = current.files.findIndex((file) => file.id === target);
      if (from < 0 || to < 0 || from === to) return current;
      const files = [...current.files];
      const [file] = files.splice(from, 1);
      if (!file) return current;
      files.splice(to, 0, file);
      return { ...current, files, focus: true };
    });
  }
  return (
    <Tabs
      value={state.active}
      onValueChange={(active) =>
        setState((current) => ({
          ...current,
          active,
          focus: false,
        }))
      }
      className="workspace-tabs flex min-w-0 flex-1 flex-col gap-0"
    >
      <div className="workspace-tab-strip overflow-x-auto">
        <TabsList aria-label={t('ワークスペースのタブ')} className="min-w-full justify-start">
          <div className="sticky left-0 z-10 flex h-full shrink-0 bg-muted">
            <div
              className="workspace-tab flex h-full shrink-0 items-center"
              data-state={state.active === 'chat' ? 'active' : 'inactive'}
            >
              <TabsTrigger
                ref={(element) => {
                  if (element) triggers.current.set('chat', element);
                  else triggers.current.delete('chat');
                }}
                value="chat"
                draggable={false}
              >
                <MessageSquare aria-hidden="true" />
                {t('AIチャット')}
              </TabsTrigger>
            </div>
            {state.jobsOpen && (
              <div
                className="workspace-tab flex h-full shrink-0 items-center"
                data-state={state.active === 'jobs' ? 'active' : 'inactive'}
              >
                <TabsTrigger
                  ref={(element) => {
                    if (element) triggers.current.set('jobs', element);
                    else triggers.current.delete('jobs');
                  }}
                  value="jobs"
                  draggable={false}
                  onKeyDown={(event) => {
                    if (event.key === 'Delete') {
                      event.preventDefault();
                      closeJobs();
                    }
                  }}
                >
                  {t('ジョブ')}
                </TabsTrigger>
                <button
                  type="button"
                  aria-label={t('ジョブタブを閉じる')}
                  tabIndex={state.active === 'jobs' ? 0 : -1}
                  className="mr-1 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={closeJobs}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            )}
            <div
              className="workspace-tab flex h-full shrink-0 items-center"
              data-state={state.active === 'notebook' ? 'active' : 'inactive'}
            >
              <TabsTrigger
                ref={(element) => {
                  if (element) triggers.current.set('notebook', element);
                  else triggers.current.delete('notebook');
                }}
                value="notebook"
                draggable={false}
              >
                <FileCode2 aria-hidden="true" />
                Notebook
              </TabsTrigger>
            </div>
          </div>
          {state.files.map((file, index) => (
            <div
              key={file.id}
              className="workspace-tab flex h-full shrink-0 items-center"
              data-state={state.active === fileValue(file.id) ? 'active' : 'inactive'}
            >
              <TabsTrigger
                ref={(element) => {
                  if (element) triggers.current.set(fileValue(file.id), element);
                  else triggers.current.delete(fileValue(file.id));
                }}
                value={fileValue(file.id)}
                draggable
                title={t('Alt+Shift+左右キーでタブを移動')}
                onDragStart={(event) => {
                  dragged.current = file.id;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(dragType, instance);
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
                onDragOver={(event) => {
                  if (dragged.current && state.files.some((item) => item.id === dragged.current)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => {
                  const source = dragged.current;
                  dragged.current = null;
                  if (!source || event.dataTransfer.getData(dragType) !== instance) return;
                  event.preventDefault();
                  move(source, file.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault();
                    close(file.id);
                  } else if (
                    event.altKey &&
                    event.shiftKey &&
                    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                  ) {
                    event.preventDefault();
                    const target = state.files[index + (event.key === 'ArrowLeft' ? -1 : 1)];
                    if (target) move(file.id, target.id);
                  }
                }}
              >
                {file.name}
              </TabsTrigger>
              <button
                type="button"
                aria-label={`${t('タブを閉じる')}: ${file.name}`}
                tabIndex={state.active === fileValue(file.id) ? 0 : -1}
                className="mr-1 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => close(file.id)}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </TabsList>
      </div>
      <TabsContent value="chat" className="flex flex-1 flex-col rounded-b-xl border bg-card p-6">
        {chat}
      </TabsContent>
      <TabsContent value="notebook" className="rounded-b-xl border bg-card p-10 text-center">
        {notebook}
      </TabsContent>
      {jobs !== undefined && (
        <TabsContent
          forceMount
          value="jobs"
          hidden={state.active !== 'jobs'}
          className={`rounded-b-xl border bg-card p-6 ${state.active !== 'jobs' ? 'hidden' : ''}`}
        >
          {typeof jobs === 'function' ? jobs(state.active === 'jobs' && state.jobsOpen) : jobs}
        </TabsContent>
      )}
      {state.files.map((file) => (
        <TabsContent
          key={file.id}
          value={fileValue(file.id)}
          className="rounded-b-xl border bg-card p-6"
        >
          {renderFile ? (
            renderFile(file)
          ) : (
            <>
              <h2 className="break-all font-semibold">{file.name}</h2>
              <p className="mt-4 text-sm text-muted-foreground">
                {t('ファイルの閲覧はまだ利用できません。')}
              </p>
            </>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
