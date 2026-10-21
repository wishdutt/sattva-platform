'use client';

import { Amplify } from 'aws-amplify';
import {
  confirmResetPassword,
  confirmSignUp,
  fetchAuthSession,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut as amplifySignOut,
  signUp,
} from 'aws-amplify/auth';
import { createApiClient, type ApiClient, type MeDto } from '@lsp/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { config } from './config';
import { oidcIdToken, oidcManager } from './oidc';

const DEV_TOKEN_KEY = 'lsp.devToken';

let amplifyConfigured = false;
function ensureAmplify() {
  if (amplifyConfigured || config.authMode !== 'cognito') return;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.cognito.userPoolId,
        userPoolClientId: config.cognito.clientId,
        loginWith: { email: true },
        signUpVerificationMethod: 'code',
      },
    },
  });
  amplifyConfigured = true;
}

/** Returns a current ID token, refreshing it through Amplify when it is close to expiry. */
async function getIdToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (config.authMode === 'dev') return window.localStorage.getItem(DEV_TOKEN_KEY);
  if (config.authMode === 'oidc') return oidcIdToken();
  ensureAmplify();
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

export type SignInResult = { status: 'signed_in' } | { status: 'confirm_sign_up' } | { status: 'error'; message: string };

interface AuthContextValue {
  status: 'loading' | 'signed_in' | 'signed_out';
  me: MeDto | null;
  api: ApiClient;
  signIn(email: string, password: string): Promise<SignInResult>;
  devSignIn(email: string, role: 'viewer' | 'organizer' | 'admin'): Promise<void>;
  /** OIDC mode: redirect to the identity provider. `signUp` asks it to show registration (prompt=create). */
  oidcRedirect(next: string, opts?: { signUp?: boolean }): Promise<void>;
  signUp(email: string, password: string, name: string): Promise<void>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [me, setMe] = useState<MeDto | null>(null);
  const api = useMemo(() => createApiClient({ baseUrl: config.apiUrl, getToken: getIdToken }), []);

  const refresh = useCallback(async () => {
    const token = await getIdToken();
    if (!token) {
      setMe(null);
      setStatus('signed_out');
      return;
    }
    try {
      setMe(await api.me());
      setStatus('signed_in');
    } catch {
      setMe(null);
      setStatus('signed_out');
    }
  }, [api]);

  useEffect(() => {
    ensureAmplify();
    void refresh();
  }, [refresh]);

  const value: AuthContextValue = {
    status,
    me,
    api,
    refresh,
    async signIn(email, password) {
      ensureAmplify();
      try {
        const res = await signIn({ username: email.trim().toLowerCase(), password });
        if (res.nextStep.signInStep === 'CONFIRM_SIGN_UP') return { status: 'confirm_sign_up' };
        if (!res.isSignedIn) return { status: 'error', message: `Additional step required: ${res.nextStep.signInStep}` };
        await refresh();
        return { status: 'signed_in' };
      } catch (err) {
        return { status: 'error', message: (err as Error).message || 'Sign-in failed' };
      }
    },
    async devSignIn(email, role) {
      const suffix = role === 'viewer' ? '' : `:${role}`;
      window.localStorage.setItem(DEV_TOKEN_KEY, `dev:${email.trim().toLowerCase()}${suffix}`);
      await refresh();
    },
    async oidcRedirect(next, opts) {
      await oidcManager().signinRedirect({
        state: { next },
        ...(opts?.signUp ? { prompt: 'create' } : {}),
      });
    },
    async signUp(email, password, name) {
      ensureAmplify();
      await signUp({
        username: email.trim().toLowerCase(),
        password,
        options: { userAttributes: { email: email.trim().toLowerCase(), name: name.trim() } },
      });
    },
    async confirmSignUp(email, code) {
      ensureAmplify();
      await confirmSignUp({ username: email.trim().toLowerCase(), confirmationCode: code.trim() });
    },
    async resendCode(email) {
      ensureAmplify();
      await resendSignUpCode({ username: email.trim().toLowerCase() });
    },
    async requestPasswordReset(email) {
      ensureAmplify();
      await resetPassword({ username: email.trim().toLowerCase() });
    },
    async confirmPasswordReset(email, code, newPassword) {
      ensureAmplify();
      await confirmResetPassword({ username: email.trim().toLowerCase(), confirmationCode: code.trim(), newPassword });
    },
    async signOut() {
      setMe(null);
      setStatus('signed_out');
      if (config.authMode === 'dev') window.localStorage.removeItem(DEV_TOKEN_KEY);
      else if (config.authMode === 'oidc') {
        const um = oidcManager();
        // End the provider session too when it supports RP-initiated logout.
        await um.signoutRedirect().catch(() => um.removeUser());
      } else await amplifySignOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const useApi = () => useAuth().api;
