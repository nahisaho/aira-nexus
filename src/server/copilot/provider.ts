import { z } from 'zod';
import { CopilotError } from './errors.js';

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}
export type DeviceResult =
  | { type: 'approved'; token: string; expiresIn?: number; retryAfter?: number }
  | {
      type: 'pending' | 'slow_down' | 'denied' | 'expired' | 'failed';
      interval?: number;
      retryAfter?: number;
    };
export interface DeviceProvider {
  start(): Promise<DeviceGrant>;
  poll(code: string): Promise<DeviceResult>;
}
const seconds = z.number().int().positive().max(86400);
const grantSchema = z.object({
  device_code: z.string().min(1).max(8192),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: seconds,
  interval: seconds.optional().default(5),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: seconds.optional(),
});
function unavailable(retryAfter = 0): CopilotError {
  return new CopilotError(
    502,
    'COPILOT_PROVIDER_ERROR',
    'GitHub device authentication is unavailable. Retry after the displayed wait.',
    retryAfter,
  );
}
/** @id CODE-CON-003 @implements REQ-CON-002 */
export class GitHubDeviceProvider implements DeviceProvider {
  constructor(
    private readonly clientId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async post(
    path: '/login/device/code' | '/login/oauth/access_token',
    values: Record<string, string>,
  ) {
    let retryAfter = 0;
    try {
      const response = await this.fetcher(`https://github.com${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ client_id: this.clientId, ...values }),
      });
      const retry = response.headers.get('Retry-After');
      if (retry !== null) {
        retryAfter = /^\d+$/.test(retry)
          ? Number(retry)
          : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000));
        if (
          !Number.isSafeInteger(retryAfter) ||
          retryAfter < 0 ||
          !Number.isFinite(new Date(Date.now() + retryAfter * 1000).getTime())
        )
          throw unavailable();
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16384) {
              await reader.cancel();
              throw unavailable(retryAfter);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (response.status === 429 || response.status >= 500) throw unavailable(retryAfter);
      const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      const envelope = z.record(z.string(), z.unknown()).safeParse(data);
      if (
        !envelope.success ||
        (!response.ok && (response.status !== 400 || typeof envelope.data.error !== 'string'))
      )
        throw unavailable(retryAfter);
      return { data: envelope.data, retryAfter };
    } catch (error) {
      if (error instanceof CopilotError) throw error;
      if (
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        error instanceof DOMException
      )
        throw unavailable(retryAfter);
      throw error;
    }
  }
  async start(): Promise<DeviceGrant> {
    const { data } = await this.post('/login/device/code', { scope: 'read:user' });
    const result = grantSchema.safeParse(data);
    if (!result.success) throw unavailable();
    return {
      deviceCode: result.data.device_code,
      userCode: result.data.user_code,
      expiresIn: result.data.expires_in,
      interval: result.data.interval,
    };
  }
  async poll(code: string): Promise<DeviceResult> {
    const { data, retryAfter } = await this.post('/login/oauth/access_token', {
      device_code: code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (data.error !== undefined) {
      if (data.error === 'authorization_pending') return { type: 'pending', retryAfter };
      if (data.error === 'slow_down') {
        const interval = seconds.optional().safeParse(data.interval);
        if (!interval.success) throw unavailable(retryAfter);
        return { type: 'slow_down', interval: interval.data, retryAfter };
      }
      if (data.error === 'access_denied') return { type: 'denied', retryAfter };
      if (data.error === 'expired_token' || data.error === 'token_expired')
        return { type: 'expired', retryAfter };
      if (
        [
          'incorrect_device_code',
          'incorrect_client_credentials',
          'unsupported_grant_type',
          'device_flow_disabled',
        ].includes(String(data.error))
      )
        return { type: 'failed', retryAfter };
      throw unavailable(retryAfter);
    }
    const result = tokenSchema.safeParse(data);
    if (!result.success) throw unavailable(retryAfter);
    return {
      type: 'approved',
      token: result.data.access_token,
      expiresIn: result.data.expires_in,
      retryAfter,
    };
  }
}
