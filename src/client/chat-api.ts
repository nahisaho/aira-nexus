import type { ChatConversation, ChatEvent, ChatPage, ChatRun, ChatTurn } from '../shared/chat';
import { z } from 'zod';
import { ApiError, authorizedFetch } from './api';
import type { BrowserAuth } from './auth';

export interface ChatModel {
  id: string;
  name: string;
}

export interface ChatPreview {
  previewId: string;
  modelId: string;
  snapshot: string;
  prompt: string;
  snapshotHash: string;
  expiresAt: string;
}

export interface ChatApi {
  listConversations(
    projectId: string,
    signal: AbortSignal,
    cursor?: string | null,
  ): Promise<ChatPage<ChatConversation>>;
  createConversation(projectId: string, signal: AbortSignal): Promise<ChatConversation>;
  getConversation(
    projectId: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ChatConversation>;
  listTurns(
    projectId: string,
    conversationId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<ChatPage<ChatTurn>>;
  discoverModels(projectId: string, signal: AbortSignal): Promise<ChatModel[]>;
  createPreview(
    projectId: string,
    conversationId: string,
    input: { text: string; modelId: string },
    signal: AbortSignal,
  ): Promise<ChatPreview>;
  confirmPreview(
    projectId: string,
    conversationId: string,
    input: { previewId: string; snapshotHash: string; confirmed: true },
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ChatRun>;
  getRun(projectId: string, runId: string, signal: AbortSignal): Promise<ChatRun>;
  subscribe(
    projectId: string,
    runId: string,
    after: number,
    receive: (event: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  cancelRun(projectId: string, runId: string, signal: AbortSignal): Promise<ChatRun>;
}

const uuid = z.uuid();
const chatState = z.enum([
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
]);
const failureCode = z.enum([
  'handler_failed',
  'interrupted',
  'cancellation_unconfirmed',
  'invalid_input',
]);
const boundedUtf8 = (limit: number) =>
  z.string().refine((value) => new TextEncoder().encode(value).byteLength <= limit);
const conversationSchema = z.strictObject({
  id: uuid,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  historyRevision: z.number().int().nonnegative(),
  preview: boundedUtf8(4096),
  latestRunId: uuid.nullable(),
  activeRunId: uuid.nullable(),
});
const turnSchema = z.strictObject({
  id: uuid,
  conversationId: uuid,
  sequence: z.number().int().positive(),
  role: z.enum(['user', 'assistant']),
  text: boundedUtf8(262144),
  createdAt: z.iso.datetime(),
});
const runSchema = z.strictObject({
  id: uuid,
  conversationId: uuid,
  state: chatState,
  modelId: z.string().min(1).max(128),
  answer: boundedUtf8(1_000_000),
  failureCode: failureCode.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSequence: z.number().int().nonnegative().max(2147483647),
});
const modelSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  name: z.string().refine((value) => {
    const length = Array.from(value).length;
    return length > 0 && length <= 200 && !/\p{Cc}/u.test(value);
  }),
});
const previewSchema = z.strictObject({
  previewId: uuid,
  modelId: z.string().min(1).max(128),
  snapshot: boundedUtf8(262144),
  prompt: boundedUtf8(262144),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});
const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item).max(100), nextCursor: z.string().max(512).nullable() });
/** @id CODE-SVC-018 @implements REQ-SVC-002 */
const eventSchema = z.strictObject({
  id: z.string().min(1).max(64),
  sequence: z.number().int().positive().max(2147483647),
  type: z.enum(['delta', 'status']),
  text: boundedUtf8(16384).optional(),
  state: chatState.nullable().optional(),
  failureCode: failureCode.nullable().optional(),
  runId: uuid,
});
const apiErrorSchema = z.strictObject({
  error: z
    .strictObject({
      code: z.string().max(64),
      message: z.string().max(1024),
      requestId: z.string().max(128).optional(),
    })
    .optional(),
});
const errorMessages: Record<string, string> = {
  NOT_FOUND: 'プロジェクトまたは会話が見つかりません。再読み込みしてください。',
  INVALID_INPUT: '入力を確認してください。必要な場合はプレビューを作成し直してください。',
  CONSENT_REQUIRED: 'モデルを更新して、送信内容をプレビューし直してください。',
  IDEMPOTENCY_CONFLICT: '送信結果を確認できません。会話を再読み込みしてください。',
  CHAT_BUSY: '別の会話で生成中です。生成が完了するまでお待ちください。',
  COPILOT_CONNECTION_REQUIRED: 'GitHub を再接続して、モデル一覧を更新してください。',
  CHAT_UNAVAILABLE: 'チャットを利用できません。設定を確認してください。',
};

function safeId(value: string): string {
  return uuid.parse(value);
}

async function request(
  auth: BrowserAuth,
  path: string,
  method: 'GET' | 'POST',
  signal: AbortSignal,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const response = await authorizedFetch(auth, path, {
    method,
    signal,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let message = 'チャット操作に失敗しました。再試行してください。';
    const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
    if (parsed.success && parsed.data.error) {
      message = errorMessages[parsed.data.error.code] ?? parsed.data.error.message ?? message;
    }
    throw new ApiError(
      response.status,
      message,
      0,
      parsed.success ? parsed.data.error?.code : undefined,
    );
  }
  return response;
}

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json());
}

/** @id CODE-CHU-005 @implements REQ-CHU-001 REQ-CHU-002 REQ-CHU-003 REQ-CHU-004 */
export function createChatApi(auth: BrowserAuth): ChatApi {
  return {
    listConversations: async (projectId, signal, cursor) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          'GET',
          signal,
        ),
        pageSchema(conversationSchema),
      ),
    createConversation: async (projectId, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations`,
          'POST',
          signal,
          {},
        ),
        conversationSchema,
      ),
    getConversation: async (projectId, conversationId, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations/${safeId(conversationId)}`,
          'GET',
          signal,
        ),
        conversationSchema,
      ),
    listTurns: async (projectId, conversationId, cursor, signal) => {
      const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations/${safeId(conversationId)}/turns${query}`,
          'GET',
          signal,
        ),
        pageSchema(turnSchema),
      );
    },
    discoverModels: async (projectId, signal) => {
      const models = await json(
        await request(auth, `/api/projects/${safeId(projectId)}/chat/models`, 'POST', signal, {
          confirmed: true,
        }),
        z.strictObject({
          models: z.array(modelSchema).max(1000),
          expiresAt: z.iso.datetime(),
        }),
      );
      if (new Set(models.models.map(({ id }) => id)).size !== models.models.length)
        throw new Error('Model response contains duplicate IDs.');
      return models.models;
    },
    createPreview: async (projectId, conversationId, input, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations/${safeId(conversationId)}/previews`,
          'POST',
          signal,
          input,
        ),
        previewSchema,
      ),
    confirmPreview: async (projectId, conversationId, input, idempotencyKey, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/conversations/${safeId(conversationId)}/runs`,
          'POST',
          signal,
          input,
          { 'Idempotency-Key': idempotencyKey },
        ),
        runSchema,
      ),
    getRun: async (projectId, runId, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/runs/${safeId(runId)}`,
          'GET',
          signal,
        ),
        runSchema,
      ),
    subscribe: async (projectId, runId, after, receive, signal) => {
      const response = await request(
        auth,
        `/api/projects/${safeId(projectId)}/chat/runs/${safeId(runId)}/stream?after=${after}`,
        'GET',
        signal,
        undefined,
        { Accept: 'text/event-stream' },
      );
      if (!response.body) throw new Error('Chat event stream has no body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sequence = after;
      let terminal = false;
      try {
        while (!signal.aborted) {
          const part = await reader.read();
          buffer += decoder.decode(part.value, { stream: !part.done });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) {
              const parsed = eventSchema.parse(JSON.parse(data));
              if (parsed.id !== `${parsed.runId}:${parsed.sequence}`)
                throw new Error('Chat event ID does not match its sequence.');
              if (parsed.runId !== runId) throw new Error('Chat event belongs to another run.');
              if (parsed.sequence > sequence) {
                if (parsed.sequence !== sequence + 1)
                  throw new Error('Chat event sequence has a gap.');
                sequence = parsed.sequence;
                if (
                  parsed.type === 'status' &&
                  (parsed.state === 'succeeded' ||
                    parsed.state === 'failed' ||
                    parsed.state === 'cancelled')
                )
                  terminal = true;
                receive({
                  sequence,
                  eventKey: `${runId}:${sequence}`,
                  type: parsed.type,
                  text: parsed.text ?? '',
                  state: parsed.state ?? null,
                  reason: parsed.failureCode ?? null,
                  createdAt: new Date().toISOString(),
                });
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
          if (part.done) {
            if (!signal.aborted && !terminal)
              throw new Error('Chat event stream ended before a terminal state.');
            return;
          }
        }
      } finally {
        if (!signal.aborted) await reader.cancel();
        reader.releaseLock();
      }
    },
    cancelRun: async (projectId, runId, signal) =>
      json(
        await request(
          auth,
          `/api/projects/${safeId(projectId)}/chat/runs/${safeId(runId)}/cancel`,
          'POST',
          signal,
        ),
        runSchema,
      ),
  };
}
