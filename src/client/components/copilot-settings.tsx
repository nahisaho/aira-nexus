import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Settings, X } from 'lucide-react';
import { z } from 'zod';
import type { BrowserAuth } from '../auth';
import { ApiError, authorizedFetch } from '../api';
import type { CopilotAttempt, CopilotState, CopilotStatus } from '../../shared/copilot';
import { isCopilotState } from '../../shared/copilot';
import { Button } from './ui/button';
import type { PreferenceControls } from '../use-user-preferences';
import type { TextSizeControls } from '../use-text-size';

const stateSchema = z.custom<CopilotState>(isCopilotState);
const attemptSchema = z.strictObject({
  id: z.uuid(),
  state: stateSchema,
  expiresAt: z.iso.datetime(),
  nextPollAt: z.iso.datetime(),
  userCode: z
    .string()
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i)
    .optional(),
  verificationUri: z.literal('https://github.com/login/device').optional(),
});
const statusSchema = z.strictObject({
  configured: z.boolean(),
  status: z.enum(['disconnected', 'connected', 'reconnect_required']),
  attempt: attemptSchema.nullable(),
});
const messages: Record<CopilotState, string> = {
  starting: '認証コードを準備しています。',
  pending: 'GitHub で認証を完了してください。',
  approved: 'GitHub に接続しました。',
  denied: 'GitHub で認証が拒否されました。',
  expired: '認証コードの有効期限が切れました。もう一度接続してください。',
  cancelled: '認証をキャンセルしました。',
  failed: '認証を開始できませんでした。再試行してください。',
};

/** @id CODE-CON-008 @implements REQ-CON-001 */
/** @id CODE-PREF-005 @implements REQ-PREF-003 REQ-PREF-005 */
export function CopilotSettings({
  auth,
  accountId,
  onAuthenticationError,
  onConnectionChange,
  preferences,
  textSize,
}: {
  auth: BrowserAuth;
  accountId: string;
  onAuthenticationError: (cause: unknown) => void;
  onConnectionChange?: () => void;
  preferences: PreferenceControls;
  textSize: TextSizeControls;
}) {
  const { t } = preferences;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CopilotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const epoch = useRef(0);
  const controller = useRef(new AbortController());
  const valid = useCallback(
    (generation: number, signal: AbortSignal) =>
      !signal.aborted && epoch.current === generation && auth.account()?.id === accountId,
    [auth, accountId],
  );
  const request = useCallback(
    async (path: string, method: string, signal: AbortSignal) => {
      const response = await authorizedFetch(auth, `/api/settings/copilot${path}`, {
        method,
        signal,
      });
      if (!response.ok) {
        const retry = response.headers.get('Retry-After');
        const seconds = retry === null ? 0 : Number(retry);
        if (!Number.isSafeInteger(seconds) || seconds < 0)
          throw new ApiError(502, 'サーバーの待機時間を確認できませんでした。再試行してください。');
        const text =
          response.status === 401
            ? '認証の有効期限が切れました。もう一度サインインしてください。'
            : response.status === 429
              ? '次の確認までお待ちください。'
              : response.status === 503
                ? 'GitHub 接続を利用できません。管理者に設定を確認してください。'
                : 'GitHub 接続の操作に失敗しました。再試行してください。';
        throw new ApiError(response.status, text, seconds);
      }
      return response;
    },
    [auth],
  );
  const report = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onAuthenticationError(cause);
      setError(
        cause instanceof ApiError
          ? cause.message
          : '接続結果を確認できませんでした。再試行してください。',
      );
      setRetryAt(
        Date.now() + Math.max(5000, cause instanceof ApiError ? cause.retryAfter * 1000 : 0),
      );
    },
    [onAuthenticationError],
  );
  useEffect(() => {
    if (!open) return;
    const generation = ++epoch.current;
    const active = new AbortController();
    controller.current = active;
    setData(null);
    setBusy(true);
    setError('');
    setRetryAt(0);
    void request('', 'GET', active.signal)
      .then(async (response) => {
        const result = statusSchema.parse(await response.json());
        if (valid(generation, active.signal)) setData(result);
      })
      .catch((cause: unknown) => {
        if (valid(generation, active.signal)) report(cause);
      })
      .finally(() => {
        if (valid(generation, active.signal)) setBusy(false);
      });
    return () => {
      active.abort();
    };
  }, [open, request, report, valid]);
  const perform = useCallback(
    async (path: string, method: string) => {
      const generation = epoch.current;
      const signal = controller.current.signal;
      if (!valid(generation, signal)) return;
      setBusy(true);
      setError('');
      try {
        const response = await request(path, method, signal);
        if (!valid(generation, signal)) return;
        if (method !== 'GET') onConnectionChange?.();
        if (method === 'DELETE' && path === '') {
          setData({ configured: true, status: 'disconnected', attempt: null });
        } else if (method === 'GET') {
          const status = statusSchema.parse(await response.json());
          if (valid(generation, signal)) setData(status);
        } else {
          const attempt: CopilotAttempt = attemptSchema.parse(await response.json());
          if (!valid(generation, signal)) return;
          if (attempt.state === 'approved') {
            setData(null);
            const status = statusSchema.parse(await (await request('', 'GET', signal)).json());
            if (valid(generation, signal)) setData(status);
          } else setData((previous) => (previous ? { ...previous, attempt } : previous));
        }
      } catch (cause) {
        if (valid(generation, signal)) report(cause);
      } finally {
        if (valid(generation, signal)) setBusy(false);
      }
    },
    [onConnectionChange, request, report, valid],
  );
  useEffect(() => {
    if (!open || !retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.max(1, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [open, retryAt]);
  useEffect(() => {
    const attempt = data?.attempt;
    if (!open || busy || !attempt || !['starting', 'pending'].includes(attempt.state)) return;
    const wake = Math.max(
      retryAt,
      Math.min(Date.parse(attempt.nextPollAt), Date.parse(attempt.expiresAt)),
    );
    const timer = setTimeout(
      () =>
        void perform(
          attempt.state === 'starting' ? '' : `/attempts/${attempt.id}/poll`,
          attempt.state === 'starting' ? 'GET' : 'POST',
        ),
      Math.max(50, wake - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [open, busy, data, perform, retryAt]);
  const changeOpen = (next: boolean) => {
    if (!next) {
      epoch.current++;
      controller.current.abort();
      setData(null);
      setError('');
    }
    setOpen(next);
  };
  const waiting = data?.attempt?.state === 'pending' || data?.attempt?.state === 'starting';
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      {!open && preferences.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(preferences.error)}
        </p>
      )}
      <Dialog.Trigger asChild>
        <Button variant="outline" className="w-full justify-start" aria-label={t('設定')}>
          <Settings aria-hidden="true" />
          {t('設定')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-modal="true"
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] overflow-y-auto w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2 space-y-5 rounded-xl border bg-card p-6 text-foreground shadow-xl"
        >
          <Dialog.Title className="text-xl font-semibold">{t('ユーザー設定')}</Dialog.Title>
          <Dialog.Description className="text-sm leading-6 text-muted-foreground">
            {t(
              'アプリへのサインインは Entra ID、ご自身の Copilot 利用には GitHub 接続を使用します。',
            )}
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3"
              aria-label={t('設定を閉じる')}
            >
              <X aria-hidden="true" />
            </Button>
          </Dialog.Close>
          <fieldset className="space-y-3 border-b pb-5">
            <legend className="mb-3 font-semibold">{t('表示設定')}</legend>
            <label className="flex items-center justify-between gap-4">
              <span>{t('言語')}</span>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={preferences.value.language}
                disabled={preferences.disabled}
                onChange={(event) => {
                  const language = event.currentTarget.value;
                  if (language === 'ja' || language === 'en') void preferences.save({ language });
                }}
              >
                <option value="ja">日本語</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-4">
              <span>{t('画面モード')}</span>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={preferences.value.theme}
                disabled={preferences.disabled}
                onChange={(event) => {
                  const theme = event.currentTarget.value;
                  if (theme === 'light' || theme === 'dark') void preferences.save({ theme });
                }}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            {preferences.saving && <p role="status">{t('保存中…')}</p>}
            {preferences.error && (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>{t(preferences.error)}</p>
                <Button
                  variant="outline"
                  disabled={preferences.saving}
                  onClick={preferences.reload}
                >
                  {t('設定を再読み込み')}
                </Button>
              </div>
            )}
          </fieldset>
          <div className="space-y-3 border-b pb-5">
            <label className="flex items-center justify-between gap-4">
              <span>{t('文字サイズ')}</span>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={textSize.value.size}
                disabled={textSize.disabled}
                onChange={(event) => {
                  const size = event.currentTarget.value;
                  if (
                    size === 'large' ||
                    size === 'medium' ||
                    size === 'small' ||
                    size === 'extra-small'
                  )
                    void textSize.save({ size });
                }}
              >
                <option value="large">{t('大')}</option>
                <option value="medium">{t('中')}</option>
                <option value="small">{t('小')}</option>
                <option value="extra-small">{t('極小')}</option>
              </select>
            </label>
            {textSize.saving && <p role="status">{t('保存中…')}</p>}
            {textSize.unsaved && <p>{t('未保存の標準サイズを表示しています。')}</p>}
            {textSize.error && (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>{t(textSize.error)}</p>
                <Button variant="outline" disabled={textSize.saving} onClick={textSize.reload}>
                  {t('設定を再読み込み')}
                </Button>
              </div>
            )}
          </div>
          <h2 className="font-semibold">GitHub</h2>
          <Button
            disabled={busy || retryAt !== 0 || !data?.configured || waiting}
            onClick={() => void perform('/attempts', 'POST')}
          >
            {t('GitHub に接続')}
          </Button>
          {error && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{t(error)}</p>
              <Button
                variant="outline"
                disabled={busy || retryAt !== 0}
                onClick={() => void perform('', 'GET')}
              >
                {t('再読み込み')}
              </Button>
            </div>
          )}
          {!data ? (
            <p role="status">{t(busy ? '読み込み中…' : '設定を取得できませんでした。')}</p>
          ) : !data.configured ? (
            <p>{t('管理者が GitHub 接続を設定していません。')}</p>
          ) : (
            <div className="space-y-4">
              <p role="status">
                {t(
                  data.status === 'connected'
                    ? 'GitHub 接続済み'
                    : data.status === 'reconnect_required'
                      ? '再接続が必要です'
                      : '未接続',
                )}
              </p>
              <p className="text-xs leading-6 text-muted-foreground">
                {t(
                  '接続済みの表示は Copilot の利用資格を保証しません。チャット送信時にも個別の確認が必要です。',
                )}
              </p>
              {data.attempt && (
                <div className="space-y-3 text-sm">
                  <p>{t(messages[data.attempt.state])}</p>
                  {data.attempt.state === 'pending' && data.attempt.userCode && (
                    <>
                      <p>
                        {t('認証コード:')}{' '}
                        <code className="rounded border px-3 py-1 font-mono">
                          {data.attempt.userCode}
                        </code>
                      </p>
                      <a
                        className="text-primary underline"
                        href="https://github.com/login/device"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('GitHub で認証する')}
                      </a>
                      <p className="text-xs text-muted-foreground">
                        {t('有効期限:')}{' '}
                        {new Date(data.attempt.expiresAt).toLocaleTimeString(
                          preferences.value.language === 'ja' ? 'ja-JP' : 'en-US',
                        )}
                      </p>
                    </>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {waiting && data.attempt && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (data.attempt) void perform(`/attempts/${data.attempt.id}`, 'DELETE');
                    }}
                  >
                    {t('認証をキャンセル')}
                  </Button>
                )}
                {(data.status !== 'disconnected' || waiting) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform('', 'DELETE')}
                  >
                    {t('接続を解除')}
                  </Button>
                )}
              </div>
              <p className="text-xs leading-6 text-muted-foreground">
                {t(
                  '閉じると認証確認を一時停止します。接続解除はアプリ内の保存情報を削除する操作で、GitHub 側の許可は取り消しません。',
                )}
              </p>
            </div>
          )}
          <Dialog.Close asChild>
            <Button variant="secondary">{t('閉じる')}</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
