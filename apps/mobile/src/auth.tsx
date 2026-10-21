import AsyncStorage from '@react-native-async-storage/async-storage';
import { Amplify } from 'aws-amplify';
import {
  confirmResetPassword,
  fetchAuthSession,
  resetPassword,
  signIn,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import { createApiClient, type ApiClient, type MeDto } from '@lsp/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { config } from './config';

const DEV_TOKEN_KEY = 'lsp.devToken';

if (config.authMode === 'cognito') {
  // Amplify persists and refreshes tokens in AsyncStorage via @aws-amplify/react-native.
  Amplify.configure({
    Auth: { Cognito: { userPoolId: config.cognito.userPoolId, userPoolClientId: config.cognito.clientId, loginWith: { email: true } } },
  });
}

async function getIdToken(): Promise<string | null> {
  if (config.authMode === 'dev') return AsyncStorage.getItem(DEV_TOKEN_KEY);
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

interface AuthValue {
  status: 'loading' | 'signed_in' | 'signed_out';
  me: MeDto | null;
  api: ApiClient;
  signIn(email: string, password: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthValue['status']>('loading');
  const [me, setMe] = useState<MeDto | null>(null);
  const api = useMemo(() => createApiClient({ baseUrl: config.apiUrl, getToken: getIdToken }), []);

  const refresh = useCallback(async () => {
    if (!(await getIdToken())) {
      setStatus('signed_out');
      setMe(null);
      return;
    }
    try {
      setMe(await api.me());
      setStatus('signed_in');
    } catch {
      setStatus('signed_out');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: AuthValue = {
    status,
    me,
    api,
    async signIn(email, password) {
      const username = email.trim().toLowerCase();
      if (config.authMode === 'dev') {
        await AsyncStorage.setItem(DEV_TOKEN_KEY, `dev:${username}`);
      } else {
        const res = await signIn({ username, password });
        if (!res.isSignedIn) {
          throw new Error(
            res.nextStep.signInStep === 'CONFIRM_SIGN_UP'
              ? 'Please verify your email first (use the link in the website sign-up flow).'
              : `Additional sign-in step required: ${res.nextStep.signInStep}`,
          );
        }
      }
      await refresh();
    },
    async requestPasswordReset(email) {
      await resetPassword({ username: email.trim().toLowerCase() });
    },
    async confirmPasswordReset(email, code, password) {
      await confirmResetPassword({ username: email.trim().toLowerCase(), confirmationCode: code.trim(), newPassword: password });
    },
    async signOut() {
      if (config.authMode === 'dev') await AsyncStorage.removeItem(DEV_TOKEN_KEY);
      else await amplifySignOut();
      setMe(null);
      setStatus('signed_out');
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
