import type { ChatConversation } from '../../shared/chat';

export function ChatConversations({
  items,
  selectedId,
  onSelect,
  onCreate,
  disabled,
  t,
}: {
  items: ChatConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  disabled: boolean;
  t: (text: string) => string;
}) {
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'ja-JP';
  return (
    <nav aria-label={t('会話一覧')} className="flex flex-col gap-1">
      <button type="button" disabled={disabled} onClick={onCreate}>
        {t('新しい会話')}
      </button>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-label={`${t('会話')} ${item.id}`}
          aria-current={item.id === selectedId ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
          className="truncate rounded px-2 py-1 text-left text-sm hover:bg-muted"
        >
          {item.preview || new Date(item.createdAt).toLocaleString(locale)}
        </button>
      ))}
    </nav>
  );
}