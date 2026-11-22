// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { PublicClientApplication } from '@azure/msal-browser';
import type { AccountInfo } from '@azure/msal-browser';
import { createBrowserAuth } from '../src/client/auth';

afterEach(() => vi.restoreAllMocks());

/** @id TEST-UI-006 @verifies REQ-UI-001 REQ-UI-003 */
it('TEST-UI-006 uses the registered blank logout URI and keeps invalidated cached accounts signed out', async () => {
  const cached: AccountInfo = {
    homeAccountId: 'alice.tenant',
    localAccountId: 'alice',
    environment: 'login.microsoftonline.com',
    tenantId: '11111111-1111-4111-8111-111111111111',
    username: 'test@example.invalid',
  };
  let active: AccountInfo | null = cached;
  const prototype = PublicClientApplication.prototype;
  vi.spyOn(prototype, 'initialize').mockResolvedValue();
  vi.spyOn(prototype, 'getActiveAccount').mockImplementation(() => active);
  vi.spyOn(prototype, 'getAllAccounts').mockReturnValue([cached]);
  vi.spyOn(prototype, 'setActiveAccount').mockImplementation((account) => {
    active = account;
  });
  const logout = vi.spyOn(prototype, 'logoutPopup').mockResolvedValue();
  const config = {
    tenantId: cached.tenantId,
    spaClientId: '33333333-3333-4333-8333-333333333333',
    apiClientId: '22222222-2222-4222-8222-222222222222',
    publicOrigin: 'http://localhost:5173',
    scope: 'api://22222222-2222-4222-8222-222222222222/access_as_user',
  };
  const auth = await createBrowserAuth(config);
  await auth.signOut();
  expect(logout).toHaveBeenCalledWith(
    expect.objectContaining({
      postLogoutRedirectUri: 'http://localhost:5173/auth-redirect.html',
    }),
  );
  active = cached;
  expect(auth.invalidate).toBeTypeOf('function');
  auth.invalidate?.();
  const reloaded = await createBrowserAuth(config);
  expect(reloaded.account()).toBeNull();
});
