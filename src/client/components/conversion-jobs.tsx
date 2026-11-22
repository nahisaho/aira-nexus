import type { ConversionsApi } from '../conversions-api';
import type { ProjectFile } from '../../shared/files';
import type { ConversionPage, ConversionRequest, ConversionState } from '../../shared/conversions';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { conversionError, conversionUnavailable } from '../conversions-api';
import { Button } from './ui/button';

export interface ConversionJobsProps {
  api: ConversionsApi;
  projectId: string;
  scopeKey: string;
  captureSession: () => () => boolean;
  onAuthenticationError: (cause: unknown) => void;
  onOpen: (file: ProjectFile) => void;
  t: (text: string) => string;
  active?: boolean;
  revision?: number;
}
/** @id CODE-CJU-002 @implements REQ-CJU-001 REQ-CJU-002 REQ-CJU-003 REQ-CJU-004 REQ-CJU-005 */
export function ConversionJobs(props: ConversionJobsProps) {
  return (
    <ConversionJobsSession key={JSON.stringify([props.scopeKey, props.projectId])} {...props} />
  );
}
const states: Record<ConversionState, string> = {
  waiting: '待機中',
  queued: 'キュー待ち',
  running: '実行中',
  cancel_requested: 'キャンセル要求済み',
  succeeded: '完了',
  failed: '失敗',
  cancelled: 'キャンセル済み',
};
const reasons: Record<string, string> = {
  handler_failed: '文書変換に失敗しました。',
  interrupted: '文書変換が中断されました。',
  cancellation_unconfirmed: 'キャンセルの完了を確認できませんでした。',
  invalid_input: '文書変換の入力が不正です。',
  unsupported_type: 'この形式は文書変換に対応していません。',
  input_too_large: '文書変換は25MB以下のファイルに対応しています。',
  page_limit: '文書のページ数が上限を超えています。',
  invalid_document: '文書を読み取れませんでした。',
  conversion_failed: '文書変換に失敗しました。',
  timeout: '文書変換が制限時間を超えました。',
  runtime_unavailable: conversionUnavailable,
  output_invalid: '変換結果を確認できませんでした。',
  output_too_large: '変換結果が容量の上限を超えています。',
  source_unavailable: '変換元ファイルは利用できません。',
  source_changed: '変換元ファイルが変更されています。',
  quota_exceeded: 'プロジェクトの保存容量が不足しています。',
};
interface Activity {
  stopped: boolean;
  request: AbortController | null;
  kind: 'load' | 'poll' | 'write';
  timer: ReturnType<typeof setTimeout> | null;
  load: (more?: boolean) => Promise<void>;
  write: (row: ConversionRequest, retry: boolean) => Promise<boolean>;
}
function ConversionJobsSession({
  api,
  projectId,
  captureSession,
  onAuthenticationError,
  onOpen,
  t,
  active = true,
  revision = 0,
}: ConversionJobsProps) {
  const [page, setPage] = useState<ConversionPage | null>(null);
  const snapshot = useRef<ConversionPage | null>(null);
  const pageCount = useRef(1);
  const retryKeys = useRef(new Map<string, string>());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [authenticationFailure, setAuthenticationFailure] = useState<{
    cause: ApiError;
    current: () => boolean;
    stop: () => void;
  } | null>(null);
  const activity = useRef<Activity | null>(null);
  const callbacks = useRef({ captureSession, onAuthenticationError });
  useLayoutEffect(() => {
    callbacks.current = { captureSession, onAuthenticationError };
  }, [captureSession, onAuthenticationError]);
  useEffect(() => {
    if (authenticationFailure?.current()) {
      authenticationFailure.stop();
      callbacks.current.onAuthenticationError(authenticationFailure.cause);
    }
  }, [authenticationFailure]);
  useLayoutEffect(() => {
    let enabled: boolean | null = null;
    const session: Activity = {
      stopped: !active,
      request: null,
      kind: 'load',
      timer: null,
      load,
      write,
    };
    activity.current = session;
    function stopTimer() {
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
    }
    function schedule() {
      stopTimer();
      if (!session.stopped) session.timer = setTimeout(() => void load(false, true), 1000);
    }
    function commit(value: ConversionPage) {
      snapshot.current = value;
      setPage(value);
    }
    function begin(kind: Activity['kind']) {
      if (session.stopped) return null;
      const sessionCurrent = callbacks.current.captureSession();
      if (!sessionCurrent()) return null;
      if (session.request && session.kind === 'poll' && kind !== 'poll') {
        session.request.abort();
        session.request = null;
      }
      if (session.request) return null;
      stopTimer();
      const request = new AbortController();
      session.request = request;
      session.kind = kind;
      if (kind !== 'poll') {
        setBusy(true);
        setError('');
      }
      const settledCurrent = () =>
        activity.current === session &&
        !session.stopped &&
        !request.signal.aborted &&
        sessionCurrent();
      return {
        request,
        current: () => session.request === request && settledCurrent(),
        settledCurrent,
      };
    }
    function fail(cause: unknown, current: () => boolean, request: AbortController) {
      if (cause instanceof ApiError && cause.status === 401) {
        setAuthenticationFailure({
          cause,
          current,
          stop: () => {
            session.stopped = true;
            request.abort();
          },
        });
      } else setError(conversionError(cause));
    }
    async function load(more = false, background = false) {
      const pending = begin(background ? 'poll' : 'load');
      if (!pending) return;
      const { request, current, settledCurrent } = pending;
      let success = false;
      try {
        if (enabled === null) {
          const capability = await api.capabilities(projectId, request.signal);
          if (!current()) return;
          enabled = capability.enabled;
        }
        if (!enabled) {
          setError(conversionUnavailable);
          return;
        }
        const previous = snapshot.current;
        let cursor = more ? previous?.nextCursor : undefined;
        if (more && !cursor) return;
        let items: ConversionRequest[] = more ? [...(previous?.items ?? [])] : [];
        let nextCursor: string | null = null;
        let loaded = 0;
        const visited = new Set<string>();
        do {
          if (cursor) {
            if (visited.has(cursor)) throw new ApiError(503, conversionUnavailable);
            visited.add(cursor);
          }
          const result = await api.list(projectId, cursor ?? undefined, request.signal);
          if (!current()) return;
          items = [...new Map([...items, ...result.items].map((item) => [item.id, item])).values()];
          nextCursor = result.nextCursor;
          cursor = nextCursor;
          loaded++;
        } while (!more && nextCursor && loaded < pageCount.current);
        commit({ items, nextCursor });
        pageCount.current = more ? pageCount.current + 1 : loaded;
        success = true;
      } catch (cause) {
        if (current()) fail(cause, settledCurrent, request);
      } finally {
        if (activity.current === session && session.request === request) {
          const valid = current();
          if (!valid) request.abort();
          session.request = null;
          if (!request.signal.aborted && !session.stopped) setBusy(false);
          if (success && valid) schedule();
        }
      }
    }
    async function write(row: ConversionRequest, retry: boolean) {
      const pending = begin('write');
      if (!pending) return false;
      const { request, current, settledCurrent } = pending;
      let success = false;
      try {
        let result: ConversionRequest;
        if (retry) {
          let key = retryKeys.current.get(row.id);
          if (!key) {
            key = crypto.randomUUID();
            retryKeys.current.set(row.id, key);
          }
          result = await api.request(projectId, row.sourceId, key, request.signal);
        } else result = await api.cancel(projectId, row.id, request.signal);
        if (!current()) return false;
        const previous = snapshot.current;
        commit({
          items: retry
            ? [result, ...(previous?.items ?? []).filter((item) => item.id !== result.id)]
            : (previous?.items ?? []).map((item) => (item.id === result.id ? result : item)),
          nextCursor: previous?.nextCursor ?? null,
        });
        if (retry) retryKeys.current.delete(row.id);
        success = true;
        return true;
      } catch (cause) {
        if (current()) fail(cause, settledCurrent, request);
        return false;
      } finally {
        if (activity.current === session && session.request === request) {
          const valid = current();
          if (!valid) request.abort();
          session.request = null;
          if (!request.signal.aborted && !session.stopped) setBusy(false);
          if (success && valid) schedule();
        }
      }
    }
    if (active) void load();
    return () => {
      session.stopped = true;
      stopTimer();
      session.request?.abort();
    };
  }, [api, projectId, active, revision, reload]);
  function writeRow(row: ConversionRequest, retry: boolean) {
    return activity.current?.write(row, retry) ?? Promise.resolve(false);
  }
  function openArtifact(file: ProjectFile) {
    if (!activity.current?.stopped && callbacks.current.captureSession()()) onOpen(file);
  }
  return (
    <section aria-label={t('ジョブ')} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t('ジョブ')}</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy && active}
          onClick={() => setReload((value) => value + 1)}
        >
          {t('ジョブを再読み込み')}
        </Button>
      </div>
      {busy && active && <p role="status">{t('読み込み中…')}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {page?.items.length === 0 && <p>{t('ジョブはまだありません。')}</p>}
      <ul className="space-y-4">
        {page?.items.map((row) => (
          <ConversionRow
            key={row.id}
            row={row}
            busy={busy}
            active={active}
            t={t}
            onWrite={writeRow}
            onOpen={openArtifact}
          />
        ))}
      </ul>
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={busy || !active}
          onClick={() => void activity.current?.load(true)}
        >
          {t('さらにジョブを読み込む')}
        </Button>
      )}
    </section>
  );
}

function ConversionRow({
  row,
  busy,
  active,
  t,
  onWrite,
  onOpen,
}: {
  row: ConversionRequest;
  busy: boolean;
  active: boolean;
  t: (text: string) => string;
  onWrite: (row: ConversionRequest, retry: boolean) => Promise<boolean>;
  onOpen: (file: ProjectFile) => void;
}) {
  const element = useRef<HTMLLIElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) element.current?.focus();
  }, [row]);
  async function write(retry: boolean) {
    restoreFocus.current = element.current?.contains(document.activeElement) ?? false;
    if (!(await onWrite(row, retry))) restoreFocus.current = false;
  }
  return (
    <li
      ref={element}
      tabIndex={-1}
      aria-label={`${row.sourceName}: ${t(states[row.state])}`}
      className="space-y-2 rounded-lg border p-4 text-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="block break-all font-medium">{row.sourceName}</span>
      <p>{t(states[row.state])}</p>
      {row.reason && <p>{t(reasons[row.reason] ?? '文書変換に失敗しました。')}</p>}
      <div className="flex flex-wrap gap-2">
        {(['waiting', 'queued', 'running'] as string[]).includes(row.state) && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !active}
            onClick={() => void write(false)}
          >
            {t('キャンセル')}
          </Button>
        )}
        {(row.state === 'failed' || row.state === 'cancelled') && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !active}
            onClick={() => void write(true)}
          >
            {t('再試行')}
          </Button>
        )}
        {row.state === 'succeeded' &&
          row.artifacts &&
          (['markdown', 'json'] as const).map((kind) => {
            const artifact = row.artifacts![kind];
            const file = artifact.file;
            return artifact.availability === 'available' && file ? (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={!active}
                onClick={() => onOpen(file)}
              >
                {t(kind === 'markdown' ? 'Markdownを開く' : 'JSONを開く')}
              </Button>
            ) : (
              <p key={kind}>{t('変換結果は利用できません。')}</p>
            );
          })}
      </div>
    </li>
  );
}
