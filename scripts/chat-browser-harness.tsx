import { createRoot } from 'react-dom/client';
import type { BrowserAuth } from '../src/client/auth';
import type { ChatApi, ChatModel, ChatPreview } from '../src/client/chat-api';
import { ProjectChat } from '../src/client/components/project-chat';
import type { ChatConversation, ChatEvent, ChatRun, ChatTurn } from '../src/shared/chat';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const model: ChatModel = { id: 'gpt-test', name: 'Offline synthetic model' };
const timestamp = '2026-11-21T00:00:00.000Z';

type ReplayState = {
  commitRemaining(): void;
  stats(): {
    confirmationKeys: string[];
    subscriptionOffsets: number[];
    abortedSubscriptions: number;
    committedRunCount: number;
  };
};

declare global {
  interface Window {
    __chatReplay?: ReplayState;
  }
}

function conversation(id: string): ChatConversation {
  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    historyRevision: 0,
    preview: '',
    latestRunId: null,
    activeRunId: null,
  };
}

export function mountChatBrowserReplay(): void {
  const conversations = [conversation(firstId), conversation(secondId)];
  const events: ChatEvent[] = [];
  const confirmationKeys: string[] = [];
  const subscriptionOffsets: number[] = [];
  let abortedSubscriptions = 0;
  let lostResponse = false;
  let committedRunCount = 0;
  let activeRun: ChatRun | null = null;
  const preview: ChatPreview = {
    previewId: '44444444-4444-4444-8444-444444444444',
    modelId: model.id,
    snapshot: '{"modelId":"gpt-test","prompt":"exact browser snapshot"}',
    prompt: 'exact browser snapshot',
    snapshotHash: 'a'.repeat(64),
    expiresAt: '2026-11-21T00:05:00.000Z',
  };
  const turns = new Map<string, ChatTurn[]>([
    [firstId, []],
    [secondId, []],
  ]);
  const auth: BrowserAuth = {
    account: () => ({ id: 'synthetic-browser-user', name: 'Offline owner' }),
    accessToken: async () => 'synthetic-browser-token',
    signIn: async () => ({ id: 'synthetic-browser-user', name: 'Offline owner' }),
    signOut: async () => {},
  };
  const api: ChatApi = {
    listConversations: async () => ({ items: conversations, nextCursor: null }),
    createConversation: async () => conversation(secondId),
    getConversation: async (_project, id) => {
      const current = conversations.find((item) => item.id === id);
      if (!current) throw new Error('Unknown synthetic conversation.');
      return {
        ...current,
        latestRunId: id === firstId ? (activeRun?.id ?? null) : null,
        activeRunId:
          id === firstId &&
          activeRun &&
          ['queued', 'running', 'cancel_requested'].includes(activeRun.state)
            ? activeRun.id
            : null,
      };
    },
    listTurns: async (_project, id) => ({ items: turns.get(id) ?? [], nextCursor: null }),
    discoverModels: async () => [model],
    createPreview: async () => preview,
    confirmPreview: async (_project, _conversationId, _input, key) => {
      confirmationKeys.push(key);
      if (!lostResponse) {
        lostResponse = true;
        throw new Error('Synthetic response loss after durable admission.');
      }
      if (confirmationKeys[0] !== key) throw new Error('Recovery changed the idempotency key.');
      if (!activeRun) {
        committedRunCount += 1;
        activeRun = {
          id: runId,
          conversationId: firstId,
          state: 'running',
          modelId: model.id,
          answer: '',
          failureCode: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastSequence: 0,
        };
        conversations[0] = { ...conversations[0]!, latestRunId: runId, activeRunId: runId };
        const admitted = { ...activeRun };
        events.push({
          sequence: 1,
          eventKey: `${runId}:1`,
          type: 'delta',
          text: 'committed ',
          state: null,
          reason: null,
          createdAt: timestamp,
        });
        activeRun = { ...activeRun, answer: 'committed ', lastSequence: 1 };
        return admitted;
      }
      return activeRun;
    },
    getRun: async () => {
      if (!activeRun) throw new Error('Synthetic run is not admitted.');
      return activeRun;
    },
    subscribe: async (_project, _runId, after, receive, signal) => {
      subscriptionOffsets.push(after);
      for (const event of events.filter((item) => item.sequence > after)) {
        if (signal.aborted) return;
        receive(event);
      }
      if (events.some((event) => event.type === 'status' && event.state === 'succeeded')) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            abortedSubscriptions += 1;
            resolve();
          },
          { once: true },
        );
      });
    },
    cancelRun: async () => {
      if (!activeRun) throw new Error('Synthetic run is not admitted.');
      activeRun = { ...activeRun, state: 'cancel_requested' };
      return activeRun;
    },
  };

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Browser harness root is missing.');
  createRoot(rootElement).render(
    <ProjectChat
      api={api}
      auth={auth}
      accountId="synthetic-browser-user"
      projectId={projectId}
      scopeKey="synthetic-browser-project"
      connectionEpoch={0}
      t={(text) => text}
      onAuthenticationError={() => {}}
    />,
  );

  window.__chatReplay = {
    commitRemaining() {
      if (!activeRun) throw new Error('Cannot replay before admission.');
      events.push(
        {
          sequence: 2,
          eventKey: `${runId}:2`,
          type: 'delta',
          text: 'after reconnect',
          state: null,
          reason: null,
          createdAt: timestamp,
        },
        {
          sequence: 3,
          eventKey: `${runId}:3`,
          type: 'status',
          text: '',
          state: 'succeeded',
          reason: null,
          createdAt: timestamp,
        },
      );
      activeRun = {
        ...activeRun,
        answer: 'committed after reconnect',
        lastSequence: 1,
      };
    },
    stats: () => ({
      confirmationKeys,
      subscriptionOffsets,
      abortedSubscriptions,
      committedRunCount,
    }),
  };
}
