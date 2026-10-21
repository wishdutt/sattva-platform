'use client';

import { ApiError, type InvitationPreviewDto } from '@lsp/shared';
import { Alert, Button, Spinner } from '@lsp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthCard } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/hooks';

const PENDING_KEY = 'lsp.pendingInvite';

/**
 * Invitation landing page. The token alone grants nothing: the user must sign in (or sign up)
 * with the invited, verified email address, then explicitly accept.
 */
export default function InvitePage() {
  const { status, me, api, signOut } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) {
      // Keep the token across the sign-up / verification round trip, then strip it from the URL.
      sessionStorage.setItem(PENDING_KEY, fromUrl);
      window.history.replaceState(null, '', '/invite');
    }
    setToken(fromUrl ?? sessionStorage.getItem(PENDING_KEY));
  }, []);

  useEffect(() => {
    if (status !== 'signed_in' || !token) return;
    api
      .previewInvitation(token)
      .then(setPreview)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [status, token, api]);

  async function accept() {
    if (!token) return;
    setBusy(true);
    try {
      const res = await api.acceptInvitation(token);
      sessionStorage.removeItem(PENDING_KEY);
      router.push(`/events/${res.eventId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Invitation link missing">
        <Alert>Open the link from your invitation email again.</Alert>
      </AuthCard>
    );
  }

  if (status === 'loading') {
    return (
      <AuthCard title="Checking your invitation…">
        <Spinner />
      </AuthCard>
    );
  }

  if (status === 'signed_out') {
    return (
      <AuthCard title="You're invited" subtitle="Sign in or create an account with the email address this invitation was sent to.">
        <div className="space-y-3">
          <Link href="/login?next=/invite" className="block">
            <Button className="w-full">Sign in</Button>
          </Link>
          <Link href="/signup?next=/invite" className="block">
            <Button variant="secondary" className="w-full">
              Create account
            </Button>
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={preview ? preview.eventTitle : 'Invitation'} subtitle={preview ? `You're invited as a ${preview.role.toLowerCase()}.` : undefined}>
      {error ? (
        <div className="space-y-4">
          <Alert title="This invitation can't be used">{error}</Alert>
          <p className="text-sm text-slate-500">
            Signed in as <strong>{me?.email}</strong>.
          </p>
          <Button variant="secondary" className="w-full" onClick={() => void signOut()}>
            Sign in with a different account
          </Button>
        </div>
      ) : !preview ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Accepting adds this event to <strong>{me?.email}</strong>. The link stops working once used.
          </p>
          <Button className="w-full" size="lg" loading={busy} onClick={() => void accept()}>
            Accept invitation
          </Button>
        </div>
      )}
    </AuthCard>
  );
}
