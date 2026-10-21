'use client';

import { Spinner } from '@lsp/ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signed_in') router.replace('/events');
    if (status === 'signed_out') router.replace('/login');
  }, [status, router]);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}
