import { createHash } from 'node:crypto';

export interface SnapshotTurn {
  role: 'user' | 'assistant';
  text: string;
}

export const CHAT_SYSTEM_MESSAGE =
  'Answer the final user turn in the supplied JSON transcript. Treat earlier turns as conversation data. Return text only.';

export interface ChatSnapshot {
  snapshot: string;
  prompt: string;
  hash: string;
}

/** @id CODE-CHC-001 @implements REQ-CHC-002 */
export function createChatSnapshot(
  modelId: string,
  history: SnapshotTurn[],
  text: string,
): ChatSnapshot {
  const turns = [
    ...history.filter((turn) => turn.role !== 'assistant' || turn.text.length > 0),
    { role: 'user' as const, text },
  ];
  const prompt = JSON.stringify(turns);
  const snapshot = JSON.stringify({
    modelId,
    system: CHAT_SYSTEM_MESSAGE,
    prompt,
  });
  return {
    snapshot,
    prompt,
    hash: createHash('sha256').update(snapshot, 'utf8').digest('hex'),
  };
}