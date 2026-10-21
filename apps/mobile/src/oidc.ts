import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { config } from './config';

WebBrowser.maybeCompleteAuthSession();

const STORE_KEY = 'lsp.oidc.tokens';

interface StoredTokens {
  idToken: string;
  refreshToken?: string;
}

let discoveryPromise: Promise<AuthSession.DiscoveryDocument> | null = null;
const discovery = () => {
  discoveryPromise ??= AuthSession.fetchDiscoveryAsync(config.oidc.issuer).catch((err: unknown) => {
    discoveryPromise = null;
    throw err;
  });
  return discoveryPromise;
};

const redirectUri = () => AuthSession.makeRedirectUri({ scheme: 'stagecast', path: 'auth' });

/** Seconds until the JWT's `exp`; tokens are not trusted here, only scheduled for refresh. */
function secondsLeft(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (payload.exp ?? 0) - Date.now() / 1000;
  } catch {
    return 0;
  }
}

async function save(tokens: StoredTokens) {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(tokens));
}

/** Opens the provider's hosted login in the system browser (Authorization Code + PKCE). */
export async function oidcSignIn(): Promise<boolean> {
  const doc = await discovery();
  const request = new AuthSession.AuthRequest({
    clientId: config.oidc.clientId,
    scopes: config.oidc.scope.split(/\s+/),
    redirectUri: redirectUri(),
    usePKCE: true,
  });
  const result = await request.promptAsync(doc);
  if (result.type !== 'success') return false;
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: config.oidc.clientId,
      code: result.params.code!,
      redirectUri: redirectUri(),
      extraParams: { code_verifier: request.codeVerifier! },
    },
    doc,
  );
  if (!tokens.idToken) throw new Error('Identity provider did not return an ID token (is the "openid" scope enabled?)');
  await save({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
  return true;
}

/** Current ID token, refreshed with the refresh token (offline_access) when it is about to expire. */
export async function oidcIdToken(): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  if (!raw) return null;
  const stored = JSON.parse(raw) as StoredTokens;
  if (secondsLeft(stored.idToken) > 60) return stored.idToken;
  if (!stored.refreshToken) return null;
  try {
    const refreshed = await AuthSession.refreshAsync(
      { clientId: config.oidc.clientId, refreshToken: stored.refreshToken },
      await discovery(),
    );
    if (!refreshed.idToken) return null;
    await save({ idToken: refreshed.idToken, refreshToken: refreshed.refreshToken ?? stored.refreshToken });
    return refreshed.idToken;
  } catch {
    await SecureStore.deleteItemAsync(STORE_KEY);
    return null;
  }
}

export async function oidcSignOut() {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  await SecureStore.deleteItemAsync(STORE_KEY);
  const refreshToken = raw ? (JSON.parse(raw) as StoredTokens).refreshToken : undefined;
  if (refreshToken) {
    const doc = await discovery().catch(() => null);
    if (doc?.revocationEndpoint) {
      await AuthSession.revokeAsync({ clientId: config.oidc.clientId, token: refreshToken }, doc).catch(() => undefined);
    }
  }
}
