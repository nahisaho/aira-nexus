import { EventType, PublicClientApplication } from '@azure/msal-browser';
import type { AccountInfo } from '@azure/msal-browser';
import type { PublicConfig } from '../shared/contracts';

export interface UserAccount {
  id: string;
  name: string;
}

export interface BrowserAuth {
  account(): UserAccount | null;
  signIn(): Promise<UserAccount>;
  accessToken(): Promise<string>;
  signOut(): Promise<void>;
  subscribe?(listener: () => void): () => void;
  invalidate?(): void;
}

const userAccount = (account: AccountInfo): UserAccount => ({
  id: account.homeAccountId,
  name: account.name ?? account.username,
});

/** @id CODE-UI-001 @implements REQ-UI-001 REQ-UI-003 */
export async function createBrowserAuth(config: PublicConfig): Promise<BrowserAuth> {
  const redirectUri = `${config.publicOrigin}/auth-redirect.html`;
  const client = new PublicClientApplication({
    auth: {
      clientId: config.spaClientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri,
      postLogoutRedirectUri: redirectUri,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await client.initialize();
  return {
    account: () => {
      const current = client.getActiveAccount();
      return current ? userAccount(current) : null;
    },
    signIn: async () => {
      const result = await client.loginPopup({
        scopes: [config.scope],
        prompt: 'select_account',
        redirectUri,
      });
      if (!result.account) throw new Error('No signed-in account returned.');
      client.setActiveAccount(result.account);
      return userAccount(result.account);
    },
    accessToken: async () => {
      const account = client.getActiveAccount();
      if (!account) throw new Error('Sign-in is required.');
      const result = await client.acquireTokenSilent({
        account,
        scopes: [config.scope],
        redirectUri,
      });
      if (client.getActiveAccount()?.homeAccountId !== account.homeAccountId)
        throw new Error('Account changed during authentication.');
      return result.accessToken;
    },
    invalidate: () => {
      client.setActiveAccount(null);
    },
    signOut: async () => {
      const account = client.getActiveAccount();
      client.setActiveAccount(null);
      await client.logoutPopup({
        account,
        postLogoutRedirectUri: redirectUri,
        mainWindowRedirectUri: config.publicOrigin,
      });
    },
    subscribe: (listener) => {
      const id = client.addEventCallback((event) => {
        if (
          event.eventType === EventType.ACTIVE_ACCOUNT_CHANGED ||
          event.eventType === EventType.ACCOUNT_REMOVED ||
          event.eventType === EventType.LOGOUT_SUCCESS
        )
          listener();
      });
      return () => {
        if (id) client.removeEventCallback(id);
      };
    },
  };
}
