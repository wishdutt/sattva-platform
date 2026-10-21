'use client';

import { Avatar, Badge, Button, Card } from '@lsp/ui';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';
import { config } from '@/lib/config';

export default function ProfilePage() {
  const { me, signOut } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <Card className="flex items-center gap-4 p-6">
          <Avatar name={me?.displayName ?? '?'} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{me?.displayName}</p>
            <p className="truncate text-sm text-slate-500">{me?.email}</p>
          </div>
          <Badge tone="brand">{me?.platformRole.toLowerCase()}</Badge>
        </Card>
        <Card className="space-y-3 p-6 text-sm text-slate-600">
          <p>
            Your name and email are managed by your account. {config.authMode === 'cognito' && 'To change your password, sign out and use “Forgot password”.'}
          </p>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </Card>
      </div>
    </AppShell>
  );
}
