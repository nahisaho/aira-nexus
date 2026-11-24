import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { ChatApi, ChatPreview } from '../chat-api';
import type { BrowserAuth } from '../auth';
import type { ChatConversation, ChatRun, ChatTurn } from '../../shared/chat';
import { Dialog } from 'radix-ui';
import { ChatConfirmation } from './chat-confirmation';
import { ChatConversations } from './chat-conversations';

export interface ProjectChatProps {
  api: ChatApi;
  auth: BrowserAuth;
  accountId: string;
  projectId: string;
  scopeKey: string;
  connectionEpoch: number;
  t: (text: string) => string;
  onAuthenticationError: (cause: unknown) => void;
}

type SendDraft = { preview: ChatPreview; key: string | null };
const activeStates = new Set(['queued', 'running', 'cancel_requested']);
const runLabel = (state: ChatRun['state'], t: ProjectChatProps['t']) =>
  t(
    {
      queued: '待機中',
      running: '生成中',
      cancel_requested: 'キャンセルを確認しています',
      succeeded: '完了',
      failed: '失敗',
      cancelled: 'キャンセル済み',
    }[state],
  );
const genericError = 'チャットの読み込みに失敗しました。再試行してください。';
const actionError = 'チャット操作に失敗しました。入力と接続を確認して再試行してください。';
const uncertainError =
  '送信結果を確認できませんでした。送信は再実行されていないため、同じ送信の回復を選択してください。';

/** @id CODE-CHU-001 @implements REQ-CHU-001 */
/** @id CODE-CHU-002 @implements REQ-CHU-002 */
/** @id CODE-CHU-003 @implements REQ-CHU-003 */
/** @id CODE-CHU-004 @implements REQ-CHU-004 */
export function ProjectChat(props: ProjectChatProps) {
  const instance = JSON.stringify([
    props.accountId,
    props.projectId,
    props.scopeKey,
    props.connectionEpoch,
  ]);
  return <ProjectChatSession key={instance} {...props} />;
}

function ProjectChatSession({
  api,
  auth,
  accountId,
  projectId,
  onAuthenticationError,
  t,
}: ProjectChatProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [turnCursor, setTurnCursor] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const [run, setRun] = useState<ChatRun | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelId, setModelId] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ChatPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conversationRetry, setConversationRetry] = useState(0);
  const [selectionRetry, setSelectionRetry] = useState(0);
  const [reconnect, setReconnect] = useState(0);
  const operations = useRef(new Set<AbortController>());
  const selectedRef = useRef<string | null>(null);
  const previousSelection = useRef<string | null>(null);
  const sequence = useRef(0);
  const sendDraft = useRef<SendDraft | null>(null);
  const translateRef = useRef(t);
  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  const currentOwner = useCallback(
    (signal: AbortSignal) => !signal.aborted && auth.account()?.id === accountId,
    [accountId, auth],
  );
  const currentSelection = useCallback(
    (signal: AbortSignal, conversationId: string) =>
      currentOwner(signal) && selectedRef.current === conversationId,
    [currentOwner],
  );
  const streamRunId = run && activeStates.has(run.state) ? run.id : null;
  const streamConversationId = run && activeStates.has(run.state) ? run.conversationId : null;
  const report = useCallback(
    (cause: unknown, fallback: string) => {
      if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
      setError(cause instanceof ApiError ? translateRef.current(cause.message) : fallback);
    },
    [onAuthenticationError],
  );
  const controller = useCallback(() => {
    const request = new AbortController();
    operations.current.add(request);
    return request;
  }, []);
  const release = useCallback((request: AbortController) => {
    operations.current.delete(request);
  }, []);

  useEffect(
    () => () => {
      for (const request of operations.current) request.abort();
      operations.current.clear();
    },
    [],
  );

  useEffect(() => {
    const active = operations.current;
    return () => {
      for (const request of active) request.abort();
      active.clear();
    };
  }, [selectedId]);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const page = await api.listConversations(projectId, request.signal);
        if (!currentOwner(request.signal)) return;
        setConversations(page.items);
        setConversationCursor(page.nextCursor);
        const next =
          selectedRef.current && page.items.some((item) => item.id === selectedRef.current)
            ? selectedRef.current
            : (page.items[0]?.id ?? null);
        selectedRef.current = next;
        setSelectedId(next);
      } catch (cause) {
        if (currentOwner(request.signal)) report(cause, genericError);
      } finally {
        if (currentOwner(request.signal)) setLoading(false);
      }
    })();
    return () => request.abort();
  }, [api, conversationRetry, currentOwner, projectId, report]);

  useEffect(() => {
    setBusy(false);
    if (!selectedId) {
      setTurns([]);
      setTurnCursor(null);
      setHistoryRevision(null);
      setRun(null);
      return;
    }
    const request = new AbortController();
    setLoading(true);
    setError('');
    setTurns([]);
    setTurnCursor(null);
    setRun(null);
    setPreview(null);
    sendDraft.current = null;
    setPreviewError('');
    setRecoveryAvailable(false);
    setText('');
    setHistoryRevision(null);
    if (previousSelection.current !== selectedId) {
      setModels([]);
      setModelId('');
      setDiscoveryOpen(false);
    }
    previousSelection.current = selectedId;
    void (async () => {
      try {
        const conversation = await api.getConversation(projectId, selectedId, request.signal);
        if (!currentSelection(request.signal, selectedId)) return;
        setHistoryRevision(conversation.historyRevision);
        const page = await api.listTurns(projectId, selectedId, null, request.signal);
        if (!currentSelection(request.signal, selectedId)) return;
        setTurns(page.items);
        setTurnCursor(page.nextCursor);
        const latestRunId = conversation.activeRunId ?? conversation.latestRunId;
        if (latestRunId) {
          const currentRun = await api.getRun(projectId, latestRunId, request.signal);
          if (!currentSelection(request.signal, selectedId)) return;
          sequence.current = currentRun.lastSequence;
          setRun(currentRun);
        }
      } catch (cause) {
        if (currentSelection(request.signal, selectedId)) report(cause, genericError);
      } finally {
        if (currentSelection(request.signal, selectedId)) setLoading(false);
      }
    })();
    return () => request.abort();
  }, [api, currentOwner, currentSelection, projectId, report, selectedId, selectionRetry]);

  useEffect(() => {
    if (!streamRunId) return;
    const request = new AbortController();
    const after = sequence.current;
    void api
      .subscribe(
        projectId,
        streamRunId,
        after,
        (event) => {
          if (!currentOwner(request.signal) || selectedRef.current !== streamConversationId) return;
          if (event.sequence <= sequence.current) return;
          if (event.sequence !== sequence.current + 1) {
            setError('会話イベントの順序を確認できません。再接続してください。');
            request.abort();
            return;
          }
          sequence.current = event.sequence;
          setRun((current) =>
            !current || current.id !== streamRunId
              ? current
              : {
                  ...current,
                  answer: event.type === 'delta' ? current.answer + event.text : current.answer,
                  state: event.type === 'status' && event.state ? event.state : current.state,
                  failureCode: event.type === 'status' ? event.reason : current.failureCode,
                  lastSequence: event.sequence,
                },
          );
        },
        request.signal,
      )
      .catch((cause: unknown) => {
        if (currentOwner(request.signal)) report(cause, genericError);
      });
    return () => request.abort();
  }, [api, currentOwner, projectId, reconnect, report, streamConversationId, streamRunId]);

  async function createConversation() {
    const previousSelection = selectedId;
    const request = controller();
    setBusy(true);
    setError('');
    try {
      const created = await api.createConversation(projectId, request.signal);
      if (!currentOwner(request.signal)) return;
      setConversations((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      if (selectedRef.current === previousSelection) {
        selectedRef.current = created.id;
        setSelectedId(created.id);
      }
    } catch (cause) {
      if (currentOwner(request.signal)) report(cause, actionError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function loadMoreConversations() {
    if (!conversationCursor) return;
    const request = controller();
    setBusy(true);
    try {
      const page = await api.listConversations(projectId, request.signal, conversationCursor);
      if (!currentOwner(request.signal)) return;
      setConversations((items) => [...items, ...page.items]);
      setConversationCursor(page.nextCursor);
    } catch (cause) {
      if (currentOwner(request.signal)) report(cause, genericError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function loadMoreTurns() {
    const target = selectedId;
    if (!target || !turnCursor) return;
    const request = controller();
    setBusy(true);
    try {
      const page = await api.listTurns(projectId, target, turnCursor, request.signal);
      if (!currentSelection(request.signal, target)) return;
      setTurns((items) => [...items, ...page.items]);
      setTurnCursor(page.nextCursor);
    } catch (cause) {
      if (currentSelection(request.signal, target)) report(cause, genericError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function discoverModels() {
    const target = selectedId;
    if (!target) return;
    const request = controller();
    setBusy(true);
    setError('');
    setModels([]);
    setModelId('');
    setPreview(null);
    sendDraft.current = null;
    try {
      const result = await api.discoverModels(projectId, request.signal);
      if (currentSelection(request.signal, target)) setModels(result);
    } catch (cause) {
      if (currentSelection(request.signal, target)) report(cause, actionError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) {
        setBusy(false);
        setDiscoveryOpen(false);
      }
    }
  }

  async function createPreview() {
    const target = selectedId;
    if (
      !target ||
      !modelId ||
      !models.some((item) => item.id === modelId) ||
      !text.trim() ||
      new TextEncoder().encode(text).byteLength > 8192
    )
      return;
    const request = controller();
    setBusy(true);
    setError('');
    setPreviewError('');
    setRecoveryAvailable(false);
    setPreview(null);
    sendDraft.current = null;
    const exactText = text;
    const selectedModel = modelId;
    try {
      const result = await api.createPreview(
        projectId,
        target,
        { text: exactText, modelId: selectedModel },
        request.signal,
      );
      if (!currentSelection(request.signal, target)) return;
      setPreview(result);
      sendDraft.current = { preview: result, key: null };
    } catch (cause) {
      if (currentSelection(request.signal, target)) report(cause, actionError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function confirmSend() {
    const target = selectedId;
    if (!target || !sendDraft.current) return;
    const draft = sendDraft.current;
    const firstAttempt = draft.key === null;
    const request = controller();
    setBusy(true);
    setPreviewError('');
    setRecoveryAvailable(false);
    try {
      if (firstAttempt && historyRevision !== null) {
        const current = await api.getConversation(projectId, target, request.signal);
        if (!currentSelection(request.signal, target)) return;
        if (current.historyRevision !== historyRevision) {
          setPreview(null);
          sendDraft.current = null;
          setError(
            '会話履歴が更新されたため、送信プレビューを破棄しました。もう一度プレビューしてください。',
          );
          return;
        }
      }
      if (!draft.key) {
        draft.key = crypto.randomUUID();
        sendDraft.current = draft;
      }
      const admitted = await api.confirmPreview(
        projectId,
        target,
        {
          previewId: draft.preview.previewId,
          snapshotHash: draft.preview.snapshotHash,
          confirmed: true,
        },
        draft.key,
        request.signal,
      );
      if (!currentSelection(request.signal, target)) return;
      sequence.current = admitted.lastSequence;
      setRun(admitted);
      setPreview(null);
      sendDraft.current = null;
      setSelectionRetry((value) => value + 1);
    } catch (cause) {
      if (currentSelection(request.signal, target)) {
        const apiError = cause instanceof ApiError ? cause : null;
        if (apiError?.status === 401) onAuthenticationError(apiError);
        const knownRejection = apiError !== null && apiError.status < 500;
        const busyConflict = apiError?.code === 'CHAT_BUSY';
        setRecoveryAvailable(apiError === null || apiError.status >= 500);
        setPreviewError(
          knownRejection
            ? busyConflict
              ? translateRef.current(
                  '別の会話で生成中です。生成が完了してから新しいプレビューを作成してください。',
                )
              : translateRef.current(apiError.message)
            : uncertainError,
        );
      }
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function cancelRun() {
    if (!run || !activeStates.has(run.state)) return;
    const target = run.conversationId;
    const request = controller();
    setBusy(true);
    setError('');
    try {
      const result = await api.cancelRun(projectId, run.id, request.signal);
      if (!currentSelection(request.signal, target)) return;
      setRun(result);
      sequence.current = result.lastSequence;
    } catch (cause) {
      if (currentSelection(request.signal, target)) report(cause, actionError);
    } finally {
      release(request);
      if (currentOwner(request.signal)) setBusy(false);
    }
  }

  async function recoverRun() {
    if (!run) return;
    const target = run.conversationId;
    const request = controller();
    try {
      const current = await api.getRun(projectId, run.id, request.signal);
      if (currentSelection(request.signal, target)) {
        sequence.current = current.lastSequence;
        setRun(current);
        setError('');
        setReconnect((value) => value + 1);
      }
    } catch (cause) {
      if (currentSelection(request.signal, target)) report(cause, genericError);
    } finally {
      release(request);
    }
  }

  const selected = conversations.find((item) => item.id === selectedId);
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <aside className="w-56 shrink-0 overflow-y-auto border-r pr-3">
        <ChatConversations
          items={conversations}
          selectedId={selectedId}
          disabled={busy}
          onCreate={() => void createConversation()}
          onSelect={(id) => {
            selectedRef.current = id;
            setSelectedId(id);
          }}
          t={t}
        />
        {conversationCursor && (
          <button type="button" disabled={busy} onClick={() => void loadMoreConversations()}>
            {t('会話をさらに表示')}
          </button>
        )}
      </aside>
      <section aria-label={t('AIチャット')} className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!selected || busy} onClick={() => setDiscoveryOpen(true)}>
            {t('モデルを更新')}
          </button>
          <label className="flex items-center gap-2">
            {t('モデル')}
            <select
              aria-label={t('モデル')}
              disabled={busy || models.length === 0}
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value);
                setPreview(null);
                sendDraft.current = null;
              }}
            >
              <option value="">{t('モデルを選択')}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {run && <span role="status">{runLabel(run.state, t)}</span>}
        </div>
        {error && (
          <div role="alert" className="rounded border border-destructive/50 p-2 text-sm">
            <span>{error}</span>
            <button type="button" onClick={() => setConversationRetry((value) => value + 1)}>
              {t('再試行')}
            </button>
            <button type="button" onClick={() => setSelectionRetry((value) => value + 1)}>
              {t('会話を再読み込み')}
            </button>
            {run && activeStates.has(run.state) && (
              <button type="button" onClick={() => void recoverRun()}>
                {t('再接続')}
              </button>
            )}
          </div>
        )}
        {loading && <p role="status">{t('会話を読み込んでいます')}</p>}
        {!selected && !loading && <p>{t('会話を選択するか、新しい会話を作成してください。')}</p>}
        <div aria-label={t('会話履歴')} className="min-h-0 flex-1 overflow-y-auto">
          {turns.map((item) => (
            <article key={item.id} className="my-2 whitespace-pre-wrap rounded border p-3">
              <p className="text-xs text-muted-foreground">
                {t(item.role === 'user' ? 'あなた' : 'AI')}
              </p>
              <p>{item.text}</p>
            </article>
          ))}
          {turnCursor && (
            <button type="button" disabled={busy} onClick={() => void loadMoreTurns()}>
              {t('履歴をさらに表示')}
            </button>
          )}
          {run?.answer && (
            <article
              aria-label={t('生成中の回答')}
              className="my-2 whitespace-pre-wrap rounded border p-3"
            >
              <p className="text-xs text-muted-foreground">{t('AI')}</p>
              <p>{run.answer}</p>
            </article>
          )}
        </div>
        {run && activeStates.has(run.state) && (
          <button type="button" disabled={busy} onClick={() => void cancelRun()}>
            {t('生成をキャンセル')}
          </button>
        )}
        <label className="flex flex-col gap-2">
          {t('メッセージ')}
          <textarea
            aria-label={t('メッセージ')}
            value={text}
            maxLength={8192}
            disabled={!selected || busy}
            onChange={(event) => {
              setText(event.target.value);
              setPreview(null);
              sendDraft.current = null;
            }}
          />
        </label>
        <button
          type="button"
          disabled={
            !selected ||
            !modelId ||
            !models.some((item) => item.id === modelId) ||
            !text.trim() ||
            new TextEncoder().encode(text).byteLength > 8192 ||
            busy
          }
          onClick={() => void createPreview()}
        >
          {t('プレビュー')}
        </button>
        <Dialog.Root open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
          <Dialog.Portal>
            {discoveryOpen && (
              <>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
                <Dialog.Content
                  aria-modal="true"
                  className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border bg-card p-6 text-foreground shadow-xl"
                >
                  <Dialog.Title className="font-semibold">{t('モデル一覧の取得')}</Dialog.Title>
                  <p>
                    {t(
                      'モデル一覧を取得するには、GitHub アカウントへの一覧取得リクエストを確認してください。',
                    )}
                  </p>
                  <div className="flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={() => setDiscoveryOpen(false)}>
                      {t('戻る')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void discoverModels()}>
                      {t('モデル一覧を取得する')}
                    </button>
                  </div>
                </Dialog.Content>
              </>
            )}
          </Dialog.Portal>
        </Dialog.Root>
        {preview && (
          <ChatConfirmation
            preview={preview}
            busy={busy}
            error={previewError}
            recoveryAvailable={recoveryAvailable}
            onConfirm={() => void confirmSend()}
            onRecover={() => void confirmSend()}
            onClose={() => {
              setPreview(null);
              sendDraft.current = null;
              setPreviewError('');
              setRecoveryAvailable(false);
            }}
            t={t}
          />
        )}
      </section>
    </div>
  );
}
