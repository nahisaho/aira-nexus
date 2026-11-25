import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Principal } from '../shared/contracts.js';
import type { AppConfig } from './config.js';
import { uuid } from './config.js';

export type AuthResult =
  { ok: true; principal: Principal } | { ok: false; status: 401 | 403 | 503; code: string };

export type TokenVerifier = (token: string) => Promise<AuthResult>;

class KeyServiceError extends Error {}

/** @id CODE-ID-001 @implements REQ-ID-001 REQ-ID-002 */
export function createTokenVerifier(
  config: AppConfig,
  suppliedKeys?: JWTVerifyGetKey,
): TokenVerifier {
  const keys =
    suppliedKeys ??
    createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
      { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 },
    );
  const resolveKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await keys(header, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) throw error;
      throw new KeyServiceError();
    }
  };
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, resolveKey, {
        algorithms: ['RS256'],
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        audience: config.apiClientId,
        requiredClaims: ['tid', 'oid', 'exp', 'iat', 'nbf', 'azp', 'scp', 'ver'],
        clockTolerance: 5,
      });
      if (
        payload.ver !== '2.0' ||
        typeof payload.tid !== 'string' ||
        !uuid.safeParse(payload.tid).success ||
        payload.tid.toLowerCase() !== config.tenantId ||
        typeof payload.oid !== 'string' ||
        !uuid.safeParse(payload.oid).success ||
        typeof payload.azp !== 'string' ||
        !uuid.safeParse(payload.azp).success ||
        typeof payload.scp !== 'string'
      )
        return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (
        payload.azp.toLowerCase() !== config.spaClientId ||
        !payload.scp.split(' ').includes('access_as_user')
      )
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      return {
        ok: true,
        principal: { tenantId: payload.tid.toLowerCase(), objectId: payload.oid.toLowerCase() },
      };
    } catch (error) {
      if (error instanceof KeyServiceError)
        return { ok: false, status: 503, code: 'IDENTITY_UNAVAILABLE' };
      if (error instanceof errors.JOSEError)
        return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      throw error;
    }
  };
}
