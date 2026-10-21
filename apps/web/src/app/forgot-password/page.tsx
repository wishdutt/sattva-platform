'use client';

import { Alert, Button, Field, Input } from '@lsp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/hooks';

export default function ForgotPasswordPage() {
  const auth = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'request') {
        await auth.requestPasswordReset(email);
        setStep('confirm');
      } else {
        await auth.confirmPasswordReset(email, code, password);
        router.push('/login');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle={step === 'request' ? 'We will email you a reset code.' : `Enter the code sent to ${email}.`}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {step === 'request' ? (
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Reset code" htmlFor="code">
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="New password" htmlFor="password">
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
          </>
        )}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          {step === 'request' ? 'Send reset code' : 'Set new password'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="font-medium text-brand-600">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
