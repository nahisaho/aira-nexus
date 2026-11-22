import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import { createTokenVerifier } from '../../src/server/identity.js';
import type { AppConfig } from '../../src/server/config.js';

export const config: AppConfig = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  apiClientId: '22222222-2222-4222-8222-222222222222',
  spaClientId: '33333333-3333-4333-8333-333333333333',
  publicOrigin: 'http://localhost:5173',
  databaseUrl: 'postgresql://test:test@localhost/aira_test',
  port: 3000,
};
export const alice = '44444444-4444-4444-8444-444444444444';
export const bob = '55555555-5555-4555-8555-555555555555';

export async function identityFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
  const sign = async (overrides: JWTPayload = {}, omitted: string[] = []) => {
    const now = Math.floor(Date.now() / 1000);
    const claims: JWTPayload = {
      iss: issuer,
      aud: config.apiClientId,
      tid: config.tenantId,
      oid: alice,
      azp: config.spaClientId,
      scp: 'access_as_user',
      ver: '2.0',
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      ...overrides,
    };
    for (const name of omitted) delete claims[name];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);
  };
  return {
    sign,
    privateKey,
    jwk,
    verify: createTokenVerifier(config, createLocalJWKSet({ keys: [jwk] })),
  };
}
