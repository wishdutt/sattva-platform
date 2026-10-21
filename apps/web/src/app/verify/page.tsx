'use client';

import { Alert, Button, Field, Input } from '@lsp/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { errorMessage, safeNext, useQueryParam } from '@/lib/hooks';

export default function VerifyPage() {
  const auth = useAuth();
  const router = useRouter();
  const emailParam = useQueryParam('email');
  const next = safeNext(useQueryParam('next'));
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (emailParam) setEmail(emailParam);
  }, [emailParam]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.confirmSignUp(email, code);
      router.push(`/login?next=${encodeURIComponent(next)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Verify your email" subtitle="We sent a 6-digit code to your inbox.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Verification code" htmlFor="code">
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {error && <Alert>{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          Verify email
        </Button>
        <button
          type="button"
          className="w-full text-sm font-medium text-brand-600"
          onClick={async () => {
            try {
              await auth.resendCode(email);
              setInfo('A new code is on its way.');
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          Resend code
        </button>
      </form>
    </AuthCard>
  );
}
