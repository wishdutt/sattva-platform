import { registerDeviceSchema, type MeDto } from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { parse } from './validate';

export async function getMe(deps: AppDeps, user: AuthUser): Promise<MeDto> {
  const now = deps.now().toISOString();
  await deps.store.upsertUser({
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    platformRole: user.platformRole,
    createdAt: now,
    updatedAt: now,
  });
  return {
    userId: user.userId,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    platformRole: user.platformRole,
    canCreateEvents: user.platformRole !== 'USER',
  };
}

export async function registerDevice(deps: AppDeps, user: AuthUser, body: unknown) {
  const input = parse(registerDeviceSchema, body);
  await deps.store.putDevice({
    userId: user.userId,
    pushToken: input.pushToken,
    platform: input.platform,
    updatedAt: deps.now().toISOString(),
  });
}
