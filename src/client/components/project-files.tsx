import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Files, MoreVertical, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { AlertDialog, DropdownMenu } from 'radix-ui';
import type { FilesApi } from '../files-api';
import type { ConversionsApi } from '../conversions-api';
import { conversionEligibility, conversionError, conversionUnavailable } from '../conversions-api';
import { ApiError } from '../api';
import type { FilePage, ProjectFile } from '../../shared/files';
import { MAX_FILE_BYTES } from '../../shared/files';
import { Button } from './ui/button';
import { PdfViewer } from './pdf-viewer';
import { MarkdownPreview } from './markdown-preview';
import { PreviewError, pixels, png, svg, dataImage } from './image-safety';

export const interruptedUploadMessage =
  'アップロードが中断されました。保存済みの可能性があるため、元のプロジェクトの一覧を再読み込みしてください。';
const failureMessage = 'ファイル操作に失敗しました。入力・容量・接続を確認して再試行してください。';
const purgeFailureMessage =
  '一部のファイルが完全削除された可能性があります。ごみ箱を再読み込みし、もう一度空にしてください。';
type Translate = (text: string) => string;
const message = (error: unknown) => (error instanceof ApiError ? error.message : failureMessage);
function useAuthenticationError(callback: (cause: unknown) => void) {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  }, [callback]);
  return ref;
}
function useDownload(
  api: FilesApi,
  projectId: string | null,
  scopeKey: string,
  onError: (cause: unknown) => void,
) {
  const requests = useRef(new Set<AbortController>());
  const notify = useAuthenticationError(onError);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const active = requests.current;
    return () => {
      for (const request of active) request.abort();
      active.clear();
    };
  }, [api, projectId, scopeKey]);
  async function download(file: ProjectFile) {
    if (!projectId) {
      setError('まずプロジェクトを作成または選択してください。');
      return;
    }
    const request = new AbortController();
    requests.current.add(request);
    setBusy(true);
    setError('');
    try {
      const bytes = await api.content(projectId, file, request.signal);
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (!request.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
        else setError(message(cause));
      }
    } finally {
      requests.current.delete(request);
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return { download, error, busy };
}
export interface ProjectFilesProps {
  scopeKey: string;
  projectId: string | null;
  api: FilesApi;
  onOpen: (file: ProjectFile) => void;
  onTrashed: (file: ProjectFile) => void;
  captureSession: () => () => boolean;
  t: Translate;
  onAuthenticationError: (cause: unknown) => void;
  onUploadInterrupted: () => void;
  conversionsApi?: ConversionsApi;
  onOpenJobs?: () => void;
}
/** @id CODE-SVC-004 @implements REQ-SVC-007 */
export function ProjectFiles(props: ProjectFilesProps) {
  return <ProjectFilesSession key={JSON.stringify([props.scopeKey, props.projectId])} {...props} />;
}
const filenameOrder = new Intl.Collator('en', { sensitivity: 'base' });
const fileDragType = 'application/x-aira-project-file';
const fileMenuItemClassName =
  'cursor-default select-none rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
/** @id CODE-FEX-006 @implements REQ-FEX-001 REQ-FEX-003 REQ-FTB-001 */
function ProjectFilesSession({
  scopeKey,
  projectId,
  api,
  onOpen,
  onTrashed,
  captureSession,
  t,
  onAuthenticationError,
  onUploadInterrupted,
  conversionsApi,
  onOpenJobs,
}: ProjectFilesProps) {
  const [page, setPage] = useState<FilePage | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false),
    [uploading, setUploading] = useState(false);
  const [note, setNote] = useState(''),
    [revision, setRevision] = useState(0);
  const [trashed, setTrashed] = useState(false),
    [writing, setWriting] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [purging, setPurging] = useState(false);
  const [trashDropActive, setTrashDropActive] = useState(false);
  const [conversionEnabled, setConversionEnabled] = useState<boolean | null>(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [converted, setConverted] = useState(new Set<string>());
  const conversionRead = useRef<AbortController | null>(null);
  const conversionWrite = useRef<AbortController | null>(null);
  const conversionKeys = useRef(new Map<string, string>());
  const conversionMounted = useRef(false);
  const jobsFocus = useRef(false);
  const draggedFile = useRef<{ file: ProjectFile; current: () => boolean } | null>(null);
  const listRequest = useRef<AbortController | null>(null),
    uploadRequest = useRef<AbortController | null>(null),
    writeRequest = useRef<AbortController | null>(null);
  const interrupt = useRef(onUploadInterrupted),
    notify = useAuthenticationError(onAuthenticationError);
  const fileInput = useRef<HTMLInputElement>(null),
    downloads = useDownload(api, projectId, scopeKey, onAuthenticationError);
  const canDragFiles =
    !!projectId &&
    !trashed &&
    !loading &&
    !uploading &&
    !writing &&
    !downloads.busy &&
    !conversionBusy;
  useLayoutEffect(() => {
    conversionMounted.current = true;
    return () => {
      conversionMounted.current = false;
      conversionRead.current?.abort();
      conversionWrite.current?.abort();
    };
  }, []);
  /** @id CODE-CJU-004 @implements REQ-CJU-001 REQ-CJU-003 REQ-CJU-004 REQ-CJU-005 */
  async function loadConversionMenu() {
    if (!conversionsApi || !projectId) return;
    conversionRead.current?.abort();
    const request = new AbortController();
    conversionRead.current = request;
    const sessionCurrent = captureSession();
    const current = () => conversionMounted.current && !request.signal.aborted && sessionCurrent();
    if (!current()) return;
    setConversionEnabled(null);
    try {
      const capability = await conversionsApi.capabilities(projectId, request.signal);
      if (!current()) return;
      setConversionEnabled(capability.enabled);
      if (capability.enabled) {
        const history = await conversionsApi.list(projectId, undefined, request.signal);
        if (!current()) return;
        setConverted(
          (previous) =>
            new Set([
              ...previous,
              ...history.items
                .filter((item) => item.state === 'succeeded')
                .map((item) => item.sourceId),
            ]),
        );
      }
    } catch (cause) {
      if (!current()) return;
      setConversionEnabled(false);
      if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
      else setError(conversionError(cause));
    }
  }
  async function convert(file: ProjectFile) {
    if (
      !projectId ||
      !conversionsApi ||
      conversionEnabled !== true ||
      conversionEligibility(file) ||
      conversionWrite.current ||
      writeRequest.current ||
      (uploadRequest.current && !uploadRequest.current.signal.aborted)
    )
      return;
    const sessionCurrent = captureSession();
    if (!sessionCurrent() || !conversionMounted.current) return;
    conversionRead.current?.abort();
    const request = new AbortController();
    conversionWrite.current = request;
    setConversionBusy(true);
    setError('');
    let key = conversionKeys.current.get(file.id);
    if (!key) {
      key = crypto.randomUUID();
      conversionKeys.current.set(file.id, key);
    }
    const current = () => conversionMounted.current && !request.signal.aborted && sessionCurrent();
    try {
      const result = await conversionsApi.request(projectId, file.id, key, request.signal);
      if (!current()) return;
      conversionKeys.current.delete(file.id);
      if (result.state === 'succeeded') setConverted((previous) => new Set([...previous, file.id]));
      onOpenJobs?.();
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
      else setError(conversionError(cause));
    } finally {
      if (current()) {
        conversionWrite.current = null;
        setConversionBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!canDragFiles) {
      draggedFile.current = null;
      setTrashDropActive(false);
    }
  }, [canDragFiles]);
  function clearFileDrag() {
    draggedFile.current = null;
    setTrashDropActive(false);
  }
  /** @id CODE-FTD-001 @implements REQ-FTD-001 REQ-FTD-002 */
  function acceptsFileDrag(transfer: DataTransfer) {
    const drag = draggedFile.current;
    return (
      canDragFiles &&
      drag !== null &&
      drag.current() &&
      !!page?.items.some((item) => item.id === drag.file.id) &&
      transfer.types.includes(fileDragType)
    );
  }
  useEffect(() => {
    interrupt.current = onUploadInterrupted;
  }, [onUploadInterrupted]);
  useEffect(
    () => () => {
      writeRequest.current?.abort();
      if (uploadRequest.current && !uploadRequest.current.signal.aborted) {
        uploadRequest.current.abort();
        interrupt.current();
      }
    },
    [],
  );
  useEffect(() => {
    if (!projectId) return;
    const request = new AbortController();
    listRequest.current = request;
    setLoading(true);
    setError('');
    const pending = trashed
      ? api.list(projectId, undefined, request.signal, true)
      : api.list(projectId, undefined, request.signal);
    void pending
      .then((result) => {
        if (!request.signal.aborted) setPage(result);
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) {
          if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
          else setError(message(cause));
        }
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => {
      request.abort();
      listRequest.current?.abort();
    };
  }, [api, projectId, scopeKey, revision, notify, trashed]);
  async function more() {
    if (!projectId || !page?.nextCursor || writeRequest.current) return;
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    setLoading(true);
    setError('');
    try {
      const result = await (trashed
        ? api.list(projectId, page.nextCursor, request.signal, true)
        : api.list(projectId, page.nextCursor, request.signal));
      if (!request.signal.aborted)
        setPage((current) => ({
          ...result,
          items: [
            ...new Map(
              [...(current?.items ?? []), ...result.items].map((file) => [file.id, file]),
            ).values(),
          ],
        }));
    } catch (cause) {
      if (!request.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
        else setError(message(cause));
      }
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  async function upload(file: File) {
    if (!projectId || writeRequest.current || conversionWrite.current || trashed) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('ファイルは100MB以下を選択してください。');
      return;
    }
    const request = new AbortController();
    uploadRequest.current = request;
    setUploading(true);
    setError('');
    setNote('アップロード中…');
    try {
      await api.upload(projectId, file, request.signal);
      if (!request.signal.aborted) {
        setNote('アップロードしました。');
        setRevision((value) => value + 1);
      }
    } catch (cause) {
      if (!request.signal.aborted) {
        setNote(interruptedUploadMessage);
        if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
        else setError(message(cause));
      }
    } finally {
      if (!request.signal.aborted) {
        uploadRequest.current = null;
        setUploading(false);
      }
    }
  }
  async function changeTrash(file: ProjectFile) {
    if (
      !projectId ||
      writeRequest.current ||
      conversionWrite.current ||
      (uploadRequest.current && !uploadRequest.current.signal.aborted)
    )
      return;
    const sessionCurrent = captureSession();
    listRequest.current?.abort();
    setLoading(false);
    const request = new AbortController();
    writeRequest.current = request;
    setWriting(true);
    setError('');
    setNote('');
    try {
      await api.setTrashed(projectId, file.id, !trashed, request.signal);
      if (request.signal.aborted || !sessionCurrent()) return;
      setPage((current) =>
        current ? { ...current, items: current.items.filter((item) => item.id !== file.id) } : null,
      );
      setNote(trashed ? 'ファイルを復元しました。' : 'ファイルをゴミ箱に移動しました。');
      if (!trashed) onTrashed(file);
    } catch (cause) {
      if (!request.signal.aborted && sessionCurrent()) {
        if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
        else setError(message(cause));
      }
    } finally {
      if (!request.signal.aborted && sessionCurrent()) {
        writeRequest.current = null;
        setWriting(false);
      }
    }
  }
  /** @id CODE-FTP-006 @implements REQ-FTP-001 REQ-FTP-003 */
  async function emptyTrash() {
    if (
      !projectId ||
      !trashed ||
      writeRequest.current ||
      (uploadRequest.current && !uploadRequest.current.signal.aborted)
    )
      return;
    const sessionCurrent = captureSession();
    const request = new AbortController();
    const current = () => !request.signal.aborted && sessionCurrent();
    writeRequest.current = request;
    listRequest.current?.abort();
    setLoading(false);
    setWriting(true);
    setPurging(true);
    setNote('');
    setError('');
    try {
      let completed = false;
      try {
        await api.emptyTrash(projectId, request.signal);
        if (!current()) return;
        completed = true;
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 401) {
          notify.current(cause);
          return;
        }
        setError(cause instanceof ApiError ? cause.message : purgeFailureMessage);
      }
      try {
        const result = await api.list(projectId, undefined, request.signal, true);
        if (current()) setPage(result);
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 401) {
          notify.current(cause);
          return;
        }
        setError(purgeFailureMessage);
        completed = false;
      }
      if (completed && current()) setNote('ごみ箱のファイルを完全削除しました。');
    } finally {
      if (current()) {
        writeRequest.current = null;
        setWriting(false);
        setPurging(false);
      }
    }
  }
  return (
    <section
      aria-label={t('ファイルエクスプローラー')}
      className="min-w-0 border-l bg-card px-5 py-6"
    >
      <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
        PROJECT FILES
      </p>
      <div className="mb-5 flex min-w-0 items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 font-semibold">
          <Files aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="truncate">{t(trashed ? 'ファイルのゴミ箱' : 'ファイル')}</span>
        </h2>
        <div role="group" aria-label={t('ファイル操作')} className="flex shrink-0 gap-1">
          {trashed ? (
            <AlertDialog.Root open={confirmEmpty} onOpenChange={setConfirmEmpty}>
              <AlertDialog.Trigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={
                    !projectId ||
                    loading ||
                    uploading ||
                    writing ||
                    !page ||
                    (!page.items.length && !page.nextCursor)
                  }
                  aria-label={t('ごみ箱を空にする')}
                  title={t('ごみ箱を空にする')}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
                <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border bg-card p-6 text-foreground shadow-xl">
                  <AlertDialog.Title className="text-xl font-semibold">
                    {t('ごみ箱を空にする')}
                  </AlertDialog.Title>
                  <AlertDialog.Description className="text-sm text-muted-foreground">
                    {t(
                      'このプロジェクトのごみ箱にあるすべてのファイルを完全に削除します。この操作は取り消せません。',
                    )}
                  </AlertDialog.Description>
                  <div className="flex justify-end gap-2">
                    <AlertDialog.Cancel asChild>
                      <Button variant="outline">{t('キャンセル')}</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action asChild>
                      <Button variant="destructive" onClick={() => void emptyTrash()}>
                        {t('完全に削除する')}
                      </Button>
                    </AlertDialog.Action>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={!projectId || uploading || writing || conversionBusy || trashed}
              aria-label={t('ファイルをアップロード')}
              title={t('ファイルをアップロード')}
              onClick={() => fileInput.current?.click()}
            >
              <Upload aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!projectId || loading || writing || uploading}
            aria-label={t('ファイル一覧を再読み込み')}
            title={t('ファイル一覧を再読み込み')}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </div>
      {!projectId ? (
        <p>{t('まずプロジェクトを作成または選択してください。')}</p>
      ) : (
        <>
          <input
            ref={fileInput}
            type="file"
            hidden
            aria-label={t('アップロードするファイル')}
            disabled={uploading || writing || conversionBusy || trashed}
            accept=".txt,.csv,.json,.md,.markdown,.py,.r,.png,.svg,.pdf,.docx,.pptx,.xlsx,.jpg,.jpeg"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void upload(file);
            }}
          />
          {uploading && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                uploadRequest.current?.abort();
                setUploading(false);
                setNote(interruptedUploadMessage);
                setRevision((value) => value + 1);
              }}
            >
              {t('アップロードを中断')}
            </Button>
          )}
          {note && (
            <p role="status" className="my-3 break-words text-xs">
              {t(note)}
            </p>
          )}
          {page && (
            <p className="my-3 text-xs text-muted-foreground">
              {t('使用量')}: {page.usedBytes.toLocaleString()} / {page.limitBytes.toLocaleString()}{' '}
              {t('バイト')}
              <br />
              {t('アップロード予約')}: {page.reservedBytes.toLocaleString()} {t('バイト')}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={
              trashDropActive ? 'bg-accent text-accent-foreground ring-2 ring-ring' : undefined
            }
            title={trashed ? undefined : t('ファイルをドラッグしてゴミ箱に移動')}
            disabled={writing || uploading}
            onDragOver={(event) => {
              if (!acceptsFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setTrashDropActive(true);
            }}
            onDragLeave={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              )
                setTrashDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const drag = draggedFile.current;
              const accepted =
                acceptsFileDrag(event.dataTransfer) &&
                event.dataTransfer.getData(fileDragType) === drag?.file.id;
              clearFileDrag();
              if (accepted && drag) void changeTrash(drag.file);
            }}
            onClick={() => {
              clearFileDrag();
              listRequest.current?.abort();
              setPage(null);
              setError('');
              setNote('');
              setTrashed((value) => !value);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t(trashed ? 'ファイルに戻る' : 'ゴミ箱')}
          </Button>
          {trashed && (
            <p className="my-3 text-xs text-muted-foreground">
              {t('ゴミ箱のファイルも使用量に含まれます。')}
            </p>
          )}
          {writing && (
            <p role="status" className="my-3 text-xs">
              {t(purging ? '完全削除中…' : '保存中…')}
            </p>
          )}
          {loading && (
            <p role="status" className="my-3 text-xs">
              {t('読み込み中…')}
            </p>
          )}
          {(error || downloads.error) && (
            <p role="alert" className="my-3 break-words text-sm text-destructive">
              {t(error || downloads.error)}
            </p>
          )}
          <ul className="my-4 space-y-1">
            {[...(page?.items ?? [])]
              .sort((a, b) => filenameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id))
              .map((file) => (
                <li
                  key={file.id}
                  className="flex min-w-0 items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent"
                  draggable={canDragFiles}
                  onDragStart={(event) => {
                    clearFileDrag();
                    const current = captureSession();
                    if (!canDragFiles || !current()) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(fileDragType, file.id);
                    event.dataTransfer.effectAllowed = 'move';
                    draggedFile.current = { file, current };
                  }}
                  onDragEnd={clearFileDrag}
                >
                  {trashed ? (
                    <>
                      <span className="min-w-0 flex-1 truncate" title={file.name}>
                        {file.name}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={writing || uploading}
                        aria-label={`${t('ファイルを復元')}: ${file.name}`}
                        onClick={() => void changeTrash(file)}
                      >
                        <RotateCcw aria-hidden="true" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        title={file.name}
                        aria-label={`${t('ファイルを開く')}: ${file.name}`}
                        onClick={() => onOpen(file)}
                      >
                        {file.name}
                      </button>
                      <DropdownMenu.Root
                        onOpenChange={(open) => {
                          if (open) void loadConversionMenu();
                          else conversionRead.current?.abort();
                        }}
                      >
                        <DropdownMenu.Trigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            disabled={writing || uploading}
                            aria-label={`${t('ファイル操作')}: ${file.name}`}
                          >
                            <MoreVertical aria-hidden="true" />
                          </Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={4}
                            aria-label={`${t('ファイル操作')}: ${file.name}`}
                            className="z-40 min-w-36 rounded-md border bg-card p-1 text-foreground shadow-md"
                            onCloseAutoFocus={(event) => {
                              if (jobsFocus.current) {
                                jobsFocus.current = false;
                                event.preventDefault();
                              }
                            }}
                          >
                            {conversionsApi && onOpenJobs && (
                              <>
                                <DropdownMenu.Item
                                  className={fileMenuItemClassName}
                                  disabled={
                                    conversionEnabled !== true ||
                                    !!conversionEligibility(file) ||
                                    conversionBusy ||
                                    writing ||
                                    uploading
                                  }
                                  onSelect={() => void convert(file)}
                                >
                                  {t(converted.has(file.id) ? '再変換' : '変換')}
                                </DropdownMenu.Item>
                                {(conversionEligibility(file) || conversionEnabled !== true) && (
                                  <DropdownMenu.Label className="max-w-64 px-3 py-2 text-xs text-muted-foreground">
                                    {t(
                                      conversionEligibility(file) ??
                                        (conversionEnabled === null
                                          ? '読み込み中…'
                                          : conversionUnavailable),
                                    )}
                                  </DropdownMenu.Label>
                                )}
                                <DropdownMenu.Item
                                  className={fileMenuItemClassName}
                                  onSelect={() => {
                                    if (!conversionMounted.current || !captureSession()()) return;
                                    jobsFocus.current = true;
                                    onOpenJobs();
                                  }}
                                >
                                  {t('ジョブを開く')}
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator className="my-1 border-t" />
                              </>
                            )}
                            <DropdownMenu.Item
                              className={fileMenuItemClassName}
                              disabled={downloads.busy || writing}
                              onSelect={() => void downloads.download(file)}
                            >
                              {t('ダウンロード')}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className={`${fileMenuItemClassName} text-destructive`}
                              disabled={downloads.busy || writing || conversionBusy}
                              onSelect={() => void changeTrash(file)}
                            >
                              {t('削除')}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </>
                  )}
                </li>
              ))}
          </ul>
          {page && !page.items.length && !loading && (
            <p className="my-4 text-xs">{t('ファイルはまだありません。')}</p>
          )}
          {page?.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading || writing || uploading}
              onClick={() => void more()}
            >
              {t('さらにファイルを読み込む')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const unsupported = 'このファイルはプレビューできません。ダウンロードして確認してください。';
const invalidImage = '画像の形式・寸法が不正か、安全なプレビューの上限を超えています。';
export interface FileViewerProps {
  scopeKey: string;
  projectId: string;
  file: ProjectFile;
  api: FilesApi;
  t: Translate;
  onAuthenticationError: (cause: unknown) => void;
}
/** @id CODE-SVC-005 @implements REQ-SVC-007 REQ-SVC-008 REQ-SVC-009 */
export function FileViewer(props: FileViewerProps) {
  return (
    <FileViewerSession
      key={JSON.stringify([props.scopeKey, props.projectId, props.file.id])}
      {...props}
    />
  );
}
/** @id CODE-MDV-008 @implements REQ-MDV-001 REQ-MDV-005 */
function FileViewerSession({
  scopeKey,
  projectId,
  file,
  api,
  t,
  onAuthenticationError,
}: FileViewerProps) {
  const [preview, setPreview] = useState<{
    text?: string;
    image?: string;
    pdf?: Uint8Array;
    error?: string;
  }>({});
  const downloads = useDownload(api, projectId, scopeKey, onAuthenticationError);
  const notify = useAuthenticationError(onAuthenticationError);
  // Renaming alone must not replace the verified document or restart its resources.
  const [markdown] = useState(() => /\.(md|markdown)$/i.test(file.name));
  const { id, size, sha256, kind } = file;
  const metadata = useRef(file);
  useEffect(() => {
    metadata.current = file;
  }, [file]);
  useEffect(() => {
    const request = new AbortController();
    setPreview({});
    const limits = { text: 1000000, svg: 1000000, png: 10000000, pdf: 25000000, download: 0 };
    if (kind === 'download' || size > limits[kind]) {
      setPreview({ error: unsupported });
      return () => request.abort();
    }
    void api
      .content(projectId, metadata.current, request.signal)
      .then((bytes) => {
        if (request.signal.aborted) return;
        if (kind === 'pdf') {
          setPreview({ pdf: bytes });
          return;
        }
        if (kind === 'png') {
          png(bytes);
          setPreview({ image: dataImage(bytes, 'png') });
          return;
        }
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new PreviewError(
            'UTF-8として読み込めません。元のファイルをダウンロードしてください。',
          );
        }
        if (kind === 'svg') {
          svg(text);
          setPreview({ image: dataImage(bytes, 'svg') });
        } else setPreview({ text });
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) {
          if (cause instanceof ApiError && cause.status === 401) notify.current(cause);
          else
            setPreview({ error: cause instanceof PreviewError ? cause.message : message(cause) });
        }
      });
    return () => request.abort();
  }, [api, projectId, scopeKey, id, size, sha256, kind, notify, metadata]);
  return (
    <div className="min-w-0">
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 className="break-all font-semibold">{file.name}</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={downloads.busy}
          onClick={() => void downloads.download(file)}
        >
          {t('ダウンロード')}
        </Button>
      </div>
      {(preview.error || downloads.error) && (
        <p role="alert" className="my-4 text-sm text-destructive">
          {preview.error && <span className="block">{t(preview.error)}</span>}
          {downloads.error && downloads.error !== preview.error && (
            <span className="block">{t(downloads.error)}</span>
          )}
        </p>
      )}
      {!preview.error && preview.text === undefined && !preview.image && !preview.pdf && (
        <p role="status">{t('読み込み中…')}</p>
      )}
      {preview.text !== undefined &&
        (markdown ? (
          <MarkdownPreview
            text={preview.text}
            api={api}
            projectId={projectId}
            t={t}
            onAuthenticationError={onAuthenticationError}
          />
        ) : (
          <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words text-sm">
            {preview.text}
          </pre>
        ))}
      {preview.image && (
        <img
          src={preview.image}
          alt={file.name}
          className="h-auto max-w-full"
          onError={() => setPreview({ error: invalidImage })}
          onLoad={(event) => {
            try {
              pixels(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
            } catch {
              setPreview({ error: invalidImage });
            }
          }}
        />
      )}
      {preview.pdf && <PdfViewer bytes={preview.pdf} t={t} />}
    </div>
  );
}
