'use client';

import { Alert, Spinner } from '@lsp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { safeNext } from '@/lib/hooks';
import { oidcManager } from '@/lib/oidc';

/** OIDC redirect target: exchanges the authorization code (PKCE) for tokens. */
export default function OidcCallbackPage() {
  const { refresh } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return; // StrictMode double-invoke would reuse the single-use code
    handled.current = true;
    oidcManager()
      .signinRedirectCallback()
      .then(async (user) => {
        await refresh();
        const next = (user.state as { next?: string } | undefined)?.next ?? null;
        router.replace(safeNext(next));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Sign-in failed'));
  }, [refresh, router]);

  return (
    <AuthCard title={error ? 'Sign-in failed' : 'Signing you in…'}>
      {error ? (
        <div className="space-y-4">
          <Alert>{error}</Alert>
          <Link href="/login" className="text-sm font-medium text-brand-600">
            Try again
          </Link>
        </div>
      ) : (
        <Spinner />
      )}
    </AuthCard>
  );
}
