import type { UserPreferences, TextSizePreference } from '../shared/preferences';
import { preferencesSchema, textSizeSchema } from '../shared/preferences';
import type { BrowserAuth } from './auth';
import { ApiError, authorizedFetch } from './api';
export interface PreferencesApi {
  get(signal?: AbortSignal): Promise<UserPreferences>;
  patch(changes: Partial<UserPreferences>, signal?: AbortSignal): Promise<UserPreferences>;
}
export interface TextSizeApi {
  get(signal?: AbortSignal): Promise<TextSizePreference>;
  patch(changes: TextSizePreference, signal?: AbortSignal): Promise<TextSizePreference>;
}
export class TextSizeUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, message);
  }
}
/** @id CODE-FONT-006 @implements REQ-FONT-001 REQ-FONT-002 REQ-FONT-004 */
export function createTextSizeApi(auth: BrowserAuth): TextSizeApi {
  async function request(
    method: 'GET' | 'PATCH',
    signal?: AbortSignal,
    changes?: TextSizePreference,
  ) {
    const response = await authorizedFetch(auth, '/api/settings/text-size', {
      method,
      signal,
      ...(changes
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) }
        : {}),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const unavailable =
        response.status === 503 &&
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'object' &&
        body.error !== null &&
        'code' in body.error &&
        body.error.code === 'TEXT_SIZE_UNAVAILABLE';
      const message = unavailable
        ? '文字サイズは利用できません。'
        : method === 'GET'
          ? '文字サイズを取得できませんでした。再試行してください。'
          : '文字サイズを保存できませんでした。再試行してください。';
      const id = response.headers.get('X-Request-ID');
      const detail = `${message}${id ? ` 受付番号: ${id}` : ''}`;
      if (unavailable) throw new TextSizeUnavailableError(detail);
      throw new ApiError(response.status, detail);
    }
    return textSizeSchema.parse(await response.json());
  }
  return {
    get: (signal) => request('GET', signal),
    patch: (changes, signal) => request('PATCH', signal, changes),
  };
}
/** @id CODE-PREF-003 @implements REQ-PREF-003 REQ-PREF-004 */
export function createPreferencesApi(auth: BrowserAuth): PreferencesApi {
  async function request(
    method: 'GET' | 'PATCH',
    signal?: AbortSignal,
    changes?: Partial<UserPreferences>,
  ) {
    const response = await authorizedFetch(auth, '/api/settings/preferences', {
      method,
      signal,
      ...(changes
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) }
        : {}),
    });
    if (!response.ok) {
      const message =
        method === 'GET'
          ? '設定を取得できませんでした。再試行してください。'
          : '設定を保存できませんでした。再試行してください。';
      const id = response.headers.get('X-Request-ID');
      throw new ApiError(response.status, `${message}${id ? ` 受付番号: ${id}` : ''}`);
    }
    return preferencesSchema.parse(await response.json());
  }
  return {
    get: (signal) => request('GET', signal),
    patch: (changes, signal) => request('PATCH', signal, changes),
  };
}
