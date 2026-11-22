import type { Project } from '../shared/contracts';
import type { BrowserAuth } from './auth';
import { AuthError } from '@azure/msal-browser';
import { z } from 'zod';

export interface ProjectsApi {
  list(signal?: AbortSignal): Promise<Project[]>;
  create(name: string, signal?: AbortSignal): Promise<Project>;
  rename(project: Project, name: string, signal?: AbortSignal): Promise<Project>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter = 0,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** @id CODE-CON-007 @implements REQ-CON-001 REQ-UI-003 */
export async function authorizedFetch(
  auth: BrowserAuth,
  path: string,
  init: { method: string; signal?: AbortSignal; headers?: Record<string, string>; body?: BodyInit },
): Promise<Response> {
  const accountId = auth.account()?.id;
  if (!accountId) throw new ApiError(401, 'サインインしてください。');
  let token: string;
  try {
    token = await auth.accessToken();
  } catch (error) {
    if (error instanceof AuthError)
      throw new ApiError(401, '認証の有効期限が切れました。もう一度サインインしてください。');
    throw error;
  }
  init.signal?.throwIfAborted();
  if (auth.account()?.id !== accountId)
    throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  init.signal?.throwIfAborted();
  if (auth.account()?.id !== accountId)
    throw new ApiError(401, 'アカウントが変更されました。もう一度サインインしてください。');
  return response;
}

const projectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** @id CODE-UI-002 @implements REQ-UI-002 REQ-UI-003 */
export function createProjectsApi(auth: BrowserAuth): ProjectsApi {
  async function request(
    path: string,
    method: string,
    signal?: AbortSignal,
    body?: { name: string },
    version?: number,
  ): Promise<unknown> {
    const response = await authorizedFetch(auth, `/api/projects${path}`, {
      method,
      signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: '入力を確認してください。名前は制御文字を含まない1〜100文字です。',
        401: '認証の有効期限が切れました。もう一度サインインしてください。',
        403: '利用権限がありません。管理者にアプリの割り当てを確認してください。',
        404: 'プロジェクトが見つかりません。再読み込みしてください。',
        409: '競合しました。再読み込みしてから変更してください。',
        413: '入力が大きすぎます。名前を短くしてください。',
        503: 'サービスを利用できません。時間をおいて再試行してください。',
      };
      const requestId = response.headers.get('X-Request-ID');
      throw new ApiError(
        response.status,
        `${messages[response.status] ?? '操作に失敗しました。再試行してください。'}${requestId ? ` 受付番号: ${requestId}` : ''}`,
      );
    }
    return response.json();
  }
  return {
    list: async (signal) => z.array(projectSchema).parse(await request('', 'GET', signal)),
    create: async (name, signal) =>
      projectSchema.parse(await request('', 'POST', signal, { name })),
    rename: async (project, name, signal) =>
      projectSchema.parse(
        await request(`/${project.id}`, 'PATCH', signal, { name }, project.version),
      ),
  };
}
