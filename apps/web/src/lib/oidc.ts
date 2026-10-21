'use client';

import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { config } from './config';

let manager: UserManager | null = null;

/**
 * Generic OpenID Connect client (Authorization Code + PKCE). Works with Keycloak, Auth0, Zitadel,
 * Authentik, Okta, Clerk, Logto… The provider's hosted pages handle sign-up, email verification
 * and password reset.
 */
export function oidcManager(): UserManager {
  if (manager) return manager;
  const origin = window.location.origin;
  manager = new UserManager({
    authority: config.oidc.authority,
    client_id: config.oidc.clientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: `${origin}/login`,
    silent_redirect_uri: `${origin}/auth/silent`,
    response_type: 'code',
    scope: config.oidc.scope,
    // Persist the session across tabs and reloads; tokens are renewed before they expire.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
  return manager;
}

/** ID token for API calls (it carries email / email_verified / groups). Renews silently if expired. */
export async function oidcIdToken(): Promise<string | null> {
  const um = oidcManager();
  let user = await um.getUser();
  if (user?.expired) {
    try {
      user = await um.signinSilent();
    } catch {
      await um.removeUser();
      return null;
    }
  }
  return user?.id_token ?? null;
}
