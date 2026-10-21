import { createHash } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { COGNITO_GROUPS, type PlatformRole } from '@lsp/shared';
import { unauthorized } from '../lib/errors';

export interface AuthUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  groups: string[];
  platformRole: PlatformRole;
}

export interface AuthVerifier {
  verify(bearerToken: string): Promise<AuthUser>;
}

export function platformRoleFromGroups(groups: string[]): PlatformRole {
  if (groups.includes(COGNITO_GROUPS.admin)) return 'ADMIN';
  if (groups.includes(COGNITO_GROUPS.organizer)) return 'ORGANIZER';
  return 'USER';
}

function toAuthUser(claims: Record<string, unknown>): AuthUser {
  const groups = Array.isArray(claims['cognito:groups']) ? (claims['cognito:groups'] as string[]) : [];
  const email = String(claims.email ?? '').toLowerCase();
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : email.split('@')[0];
  return {
    userId: String(claims.sub),
    email,
    // Cognito emits email_verified as boolean in ID tokens; older pools may emit the string "true".
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    displayName: (name ?? 'Participant').slice(0, 80),
    groups,
    platformRole: platformRoleFromGroups(groups),
  };
}

/**
 * Verifies Cognito ID tokens (signature, issuer, audience, expiry, token_use).
 * API Gateway's JWT authorizer validates the same token first; this is defense in depth
 * and lets the handler read verified email/group claims.
 */
export function createCognitoVerifier(userPoolId: string, clientIds: string[]): AuthVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId: clientIds });
  return {
    async verify(token) {
      try {
        const claims = await verifier.verify(token);
        return toAuthUser(claims as unknown as Record<string, unknown>);
      } catch {
        throw unauthorized('Invalid or expired session');
      }
    },
  };
}

/**
 * LOCAL DEVELOPMENT ONLY. Accepts `dev:<email>[:admin|organizer]` bearer tokens so the full
 * workflow can be exercised without Cognito. Refuses to construct inside Lambda.
 */
export function createDevVerifier(): AuthVerifier {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('Dev auth verifier must never run in AWS Lambda');
  }
  return {
    async verify(token) {
      const match = /^dev:([^:\s]+@[^:\s]+)(?::(admin|organizer))?$/.exec(token);
      if (!match) throw unauthorized('Invalid dev token');
      const email = match[1]!.toLowerCase();
      const groups =
        match[2] === 'admin' ? [COGNITO_GROUPS.admin] : match[2] === 'organizer' ? [COGNITO_GROUPS.organizer] : [];
      return toAuthUser({
        sub: `dev-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
        email,
        email_verified: true,
        'cognito:groups': groups,
      });
    },
  };
}

export function bearerFrom(headers: Record<string, string | undefined>): string {
  const raw = headers.authorization ?? headers.Authorization;
  if (!raw?.startsWith('Bearer ')) throw unauthorized();
  return raw.slice('Bearer '.length).trim();
}
