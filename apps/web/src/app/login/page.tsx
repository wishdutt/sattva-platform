'use client';

import { Alert, Button, Field, Input, Select } from '@lsp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import { safeNext, useQueryParam } from '@/lib/hooks';

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const next = safeNext(useQueryParam('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devRole, setDevRole] = useState<'viewer' | 'organizer' | 'admin'>('organizer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.status === 'signed_in') router.replace(next);
  }, [auth.status, next, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (config.authMode === 'dev') {
        await auth.devSignIn(email, devRole);
        return;
      }
      const res = await auth.signIn(email, password);
      if (res.status === 'confirm_sign_up') router.push(`/verify?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
      else if (res.status === 'error') setError(res.message);
    } finally {
      setBusy(false);
    }
  }

  if (config.authMode === 'oidc') {
    return (
      <AuthCard title="Sign in" subtitle="Welcome back. Sign in to see your events.">
        <div className="space-y-3">
          <Button className="w-full" size="lg" loading={busy} onClick={() => { setBusy(true); void auth.oidcRedirect(next); }}>
            Continue with {config.oidc.providerName}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => void auth.oidcRedirect(next, { signUp: true })}>
            Create account
          </Button>
          <p className="pt-2 text-center text-xs text-slate-500">
            Password reset and email verification are handled on the sign-in page you will be redirected to.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" subtitle="Welcome back. Sign in to see your events.">
      {config.authMode === 'dev' && (
        <div className="mb-4">
          <Alert tone="warning" title="Local development sign-in">
            Cognito is bypassed. Use only with the local API.
          </Alert>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {config.authMode === 'dev' ? (
          <Field label="Platform role" htmlFor="role">
            <Select id="role" value={devRole} onChange={(e) => setDevRole(e.target.value as typeof devRole)}>
              <option value="organizer">Organizer</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
        ) : (
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy} disabled={!email}>
          Sign in
        </Button>
      </form>
      {config.authMode === 'cognito' && (
        <div className="mt-6 flex items-center justify-between text-sm">
          <Link href="/forgot-password" className="font-medium text-brand-600 hover:text-brand-500">
            Forgot password?
          </Link>
          <Link href={`/signup?next=${encodeURIComponent(next)}`} className="font-medium text-brand-600 hover:text-brand-500">
            Create account
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
