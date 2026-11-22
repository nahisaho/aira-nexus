import type { BrowserAuth } from './auth';
import type { ProjectOrderMove, ProjectOrderSnapshot } from '../shared/project-order';
import {
  projectOrderCapabilitySchema,
  projectOrderMoveSchema,
  projectOrderSnapshotSchema,
  projectOrderVersionSchema,
} from '../shared/project-order';
import { z } from 'zod';
import { ApiError, authorizedFetch } from './api';

export interface ProjectOrderApi {
  capabilities(signal?: AbortSignal): Promise<boolean>;
  get(signal?: AbortSignal): Promise<ProjectOrderSnapshot>;
  move(
    version: number,
    move: ProjectOrderMove,
    signal?: AbortSignal,
  ): Promise<ProjectOrderSnapshot>;
}
export class ProjectOrderUnavailable extends ApiError {
  constructor() {
    super(503, '並べ替えは現在利用できません。');
    this.name = 'ProjectOrderUnavailable';
  }
}

/** @id CODE-SID-014 @implements REQ-SID-008 REQ-SID-009 */
export function createProjectOrderApi(auth: BrowserAuth): ProjectOrderApi {
  const unavailable = z.object({
    error: z.object({ code: z.literal('PROJECT_ORDER_UNAVAILABLE') }),
  });
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    move?: { version: number; input: ProjectOrderMove },
  ): Promise<T> {
    const accountId = auth.account()?.id;
    const response = await authorizedFetch(auth, path, {
      method: move ? 'PATCH' : 'GET',
      signal,
      ...(move
        ? {
            headers: { 'Content-Type': 'application/json', 'If-Match': `"${move.version}"` },
            body: JSON.stringify(move.input),
          }
        : {}),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    signal?.throwIfAborted();
    if (auth.account()?.id !== accountId)
      throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
    if (!response.ok) {
      if (response.status === 503 && unavailable.safeParse(body).success)
        throw new ProjectOrderUnavailable();
      const message =
        response.status === 401
          ? '認証の有効期限が切れました。もう一度サインインしてください。'
          : '並び順の操作に失敗しました。再読み込みして再試行してください。';
      throw new ApiError(response.status, message);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(502, '並び順の応答を確認できませんでした。再読み込みしてください。');
    return parsed.data;
  }
  return {
    capabilities: async (signal) =>
      (await request('/api/project-order/capabilities', projectOrderCapabilitySchema, signal))
        .enabled,
    get: (signal) => request('/api/project-order', projectOrderSnapshotSchema, signal),
    move: (version, input, signal) => {
      const parsed = projectOrderMoveSchema.safeParse(input);
      if (!parsed.success || !projectOrderVersionSchema.safeParse(version).success)
        return Promise.reject(new ApiError(400, '並べ替えの入力が不正です。'));
      return request('/api/project-order', projectOrderSnapshotSchema, signal, {
        version,
        input: parsed.data,
      });
    },
  };
}
