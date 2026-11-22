import { vi } from 'vitest';
import type { BrowserAuth, UserAccount } from '../../src/client/auth';
import type { ChatApi, ChatModel, ChatPreview } from '../../src/client/chat-api';
import type { ChatConversation, ChatEvent, ChatRun, ChatTurn } from '../../src/shared/chat';

export const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const firstConversationId = '11111111-1111-4111-8111-111111111111';
export const secondConversationId = '22222222-2222-4222-8222-222222222222';
export const runId = '33333333-3333-4333-8333-333333333333';
export const model: ChatModel = { id: 'gpt-test', name: 'Test model' };
export const conversation = (id: string, preview = ''): ChatConversation => ({
  id,
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  historyRevision: 0,
  preview,
  latestRunId: null,
  activeRunId: null,
});
export const turn = (
  id: string,
  sequence: number,
  role: 'user' | 'assistant',
  text: string,
): ChatTurn => ({
  id,
  conversationId: firstConversationId,
  sequence,
  role,
  text,
  createdAt: '2026-11-21T00:00:00.000Z',
});
export const run = (overrides: Partial<ChatRun> = {}): ChatRun => ({
  id: runId,
  conversationId: firstConversationId,
  state: 'running',
  modelId: model.id,
  answer: '',
  failureCode: null,
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  lastSequence: 0,
  ...overrides,
});
export const preview: ChatPreview = {
  previewId: '44444444-4444-4444-8444-444444444444',
  modelId: model.id,
  snapshot: 'immutable history and prompt',
  prompt: 'exact preview prompt',
  snapshotHash: 'a'.repeat(64),
  expiresAt: '2026-11-21T00:05:00.000Z',
};

export function chatFixture(options: {
  conversations?: ChatConversation[];
  turns?: ChatTurn[];
  activeRun?: ChatRun | null;
  accountId?: string;
} = {}) {
  let account: UserAccount | null = {
    id: options.accountId ?? 'alice',
    name: 'Researcher',
  };
  const auth: BrowserAuth = {
    account: () => account,
    accessToken: vi.fn(async () => 'synthetic'),
    signIn: vi.fn(async () => account ?? { id: 'alice', name: 'Researcher' }),
    signOut: vi.fn(async () => {
      account = null;
    }),
  };
  const activeRunId =
    options.activeRun && ['queued', 'running', 'cancel_requested'].includes(options.activeRun.state)
      ? options.activeRun.id
      : null;
  let conversations = options.conversations ?? [
    { ...conversation(firstConversationId), latestRunId: options.activeRun?.id ?? null, activeRunId },
    conversation(secondConversationId),
  ];
  const defaultTurns = [
    turn('55555555-5555-4555-8555-555555555555', 1, 'user', 'Earlier question'),
    turn('66666666-6666-4666-8666-666666666666', 2, 'assistant', 'Earlier answer'),
  ];
  const turns = options.turns ?? defaultTurns;
  const api: ChatApi = {
    listConversations: vi.fn(async () => ({ items: conversations, nextCursor: null })),
    createConversation: vi.fn(async () => {
      const created = conversation('77777777-7777-4777-8777-777777777777');
      conversations = [created, ...conversations];
      return created;
    }),
    getConversation: vi.fn(async (_projectId, id) => {
      const selected = conversations.find((item) => item.id === id);
      if (!selected) throw new Error('Conversation not found in fixture.');
      return selected;
    }),
    listTurns: vi.fn(async (_projectId, id) => ({
      items: (options.turns && id === firstConversationId ? turns : defaultTurns).map((item) => ({
        ...item,
        conversationId: id,
      })),
      nextCursor: null,
    })),
    discoverModels: vi.fn(async () => [model]),
    createPreview: vi.fn(async () => preview),
    confirmPreview: vi.fn(async () => run({ state: 'queued' })),
    getRun: vi.fn(async () => options.activeRun ?? run({ state: 'succeeded' })),
    subscribe: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => ({
      ...(options.activeRun ?? run()),
      state: 'cancel_requested' as const,
    })),
  };
  return { api, auth, switchAccount: (id: string) => (account = { id, name: 'Other' }) };
}

export function delta(sequence: number, text: string): ChatEvent {
  return {
    sequence,
    eventKey: `event-${sequence}`,
    type: 'delta',
    text,
    state: null,
    reason: null,
    createdAt: '2026-11-21T00:00:00.000Z',
  };
}