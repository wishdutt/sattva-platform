'use client';

import { Alert, Button, Field, Input } from '@lsp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import { errorMessage, safeNext, useQueryParam } from '@/lib/hooks';

export default function SignUpPage() {
  const auth = useAuth();
  const router = useRouter();
  const next = safeNext(useQueryParam('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // With an external OIDC provider, registration happens on the provider's hosted page.
  const { oidcRedirect } = auth;
  useEffect(() => {
    if (config.authMode !== 'oidc') return;
    void oidcRedirect(safeNext(new URLSearchParams(window.location.search).get('next')), { signUp: true });
    // Run once on mount; oidcRedirect is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signUp(email, password, name);
      router.push(`/verify?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Create your account" subtitle="Use the email address your invitation was sent to.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name" htmlFor="name">
          <Input id="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 12 characters with upper/lowercase letters, a number and a symbol.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already registered?{' '}
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-medium text-brand-600">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
