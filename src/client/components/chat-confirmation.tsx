import type { ChatPreview } from '../chat-api';
import { Dialog } from 'radix-ui';

export function ChatConfirmation({
  preview,
  busy,
  error,
  recoveryAvailable,
  onConfirm,
  onRecover,
  onClose,
  t,
}: {
  preview: ChatPreview;
  busy: boolean;
  error: string;
  recoveryAvailable: boolean;
  onConfirm: () => void;
  onRecover: () => void;
  onClose: () => void;
  t: (text: string) => string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-modal="true"
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(90vw,40rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl"
        >
          <Dialog.Title className="font-semibold">{t('送信内容の確認')}</Dialog.Title>
          <p className="text-sm text-muted-foreground">
            {t('モデル')}: {preview.modelId}
          </p>
          <p className="text-sm text-muted-foreground">{t('送信される文章と履歴')}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">
            {preview.snapshot}
          </pre>
          <p className="text-sm text-muted-foreground">{t('送信形式')}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">
            {preview.prompt}
          </pre>
          <p className="text-sm">
            {t(
              '送信時に、確認済みの文章と履歴が GitHub Copilot に送信されます。外部サービス側の保持・取消は保証されません。',
            )}
          </p>
          <p className="text-sm">
            {t('送信を確認すると、このスナップショットに対するモデルの確認も行います。')}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={onClose}>
              {t('戻る')}
            </button>
            {!error && (
              <button type="button" disabled={busy} onClick={onConfirm}>
                {t('送信を確認')}
              </button>
            )}
            {error && recoveryAvailable && (
              <button type="button" disabled={busy} onClick={onRecover}>
                {t('同じ送信を回復')}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
