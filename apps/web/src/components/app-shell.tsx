'use client';

import { Avatar, Spinner, cx } from '@lsp/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { CalendarIcon, LogoMark, SettingsIcon } from './icons';

/** Client-side route guard. The API independently authorizes every request. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === 'signed_out') {
      const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathname;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [status, router, pathname]);
  if (status !== 'signed_in') {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  return <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth();
  const pathname = usePathname();
  const nav = [
    { href: '/events', label: 'Events', icon: CalendarIcon },
    ...(me?.platformRole === 'ADMIN' ? [{ href: '/admin', label: 'Admin', icon: SettingsIcon }] : []),
  ];
  return (
    <RequireAuth>
      <div className="min-h-screen">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
            <Link href="/events" className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
              <LogoMark />
              <span>Stagecast</span>
            </Link>
            <nav className="flex items-center gap-1" aria-label="Main">
              {nav.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={cx(
                    'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium',
                    pathname.startsWith(href) ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <Link href="/profile" className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-100">
                <Avatar name={me?.displayName ?? '?'} size="sm" />
                <span className="hidden text-sm font-medium text-slate-700 sm:inline">{me?.displayName}</span>
              </Link>
              <button onClick={() => void signOut()} className="text-sm font-medium text-slate-500 hover:text-slate-900">
                Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      </div>
    </RequireAuth>
  );
}

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-950 via-slate-900 to-slate-950 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2 text-white">
          <LogoMark size={36} />
          <span className="text-2xl font-bold tracking-tight">Stagecast</span>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">Private, invitation-only live events.</p>
      </div>
    </div>
  );
}
