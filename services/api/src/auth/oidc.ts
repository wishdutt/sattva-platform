import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '../lib/errors';
import { platformRoleFromGroupNames, type AuthUser, type AuthVerifier } from './verifier';

export interface OidcOptions {
  /** Exact `iss` value, e.g. https://auth.example.com/realms/events */
  issuer: string;
  /** Accepted `aud` values (your web and mobile client ids). */
  audiences: string[];
  /** Defaults to the `jwks_uri` advertised at {issuer}/.well-known/openid-configuration. */
  jwksUrl?: string;
  emailClaim?: string;
  emailVerifiedClaim?: string;
  nameClaim?: string;
  /** Dotted path to a string array, e.g. `groups`, `roles`, `realm_access.roles`. */
  groupsClaim?: string;
  adminGroup?: string;
  organizerGroup?: string;
  /**
   * When false, tokens without an email_verified claim are accepted. Only disable this if your
   * identity provider never issues tokens for unverified addresses — invitations rely on it.
   */
  requireEmailVerified?: boolean;
}

const getPath = (obj: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);

async function discoverJwksUrl(issuer: string): Promise<string> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
  return doc.jwks_uri;
}

/**
 * Verifies JWTs from any standards-compliant OpenID Connect provider (signature via JWKS,
 * issuer, audience, expiry, nbf). `keySet` can be injected for tests.
 */
export function createOidcVerifier(opts: OidcOptions, keySet?: JWTVerifyGetKey): AuthVerifier {
  const emailClaim = opts.emailClaim ?? 'email';
  const verifiedClaim = opts.emailVerifiedClaim ?? 'email_verified';
  const nameClaim = opts.nameClaim ?? 'name';
  const groupsClaim = opts.groupsClaim ?? 'groups';
  const requireVerified = opts.requireEmailVerified ?? true;
  let jwks: Promise<JWTVerifyGetKey> | undefined = keySet ? Promise.resolve(keySet) : undefined;

  const getJwks = () => {
    jwks ??= (opts.jwksUrl ? Promise.resolve(opts.jwksUrl) : discoverJwksUrl(opts.issuer))
      .then((url) => createRemoteJWKSet(new URL(url)))
      .catch((err: unknown) => {
        jwks = undefined; // retry discovery on the next request
        throw err;
      });
    return jwks;
  };

  return {
    async verify(token): Promise<AuthUser> {
      let payload: Record<string, unknown>;
      try {
        const result = await jwtVerify(token, await getJwks(), {
          issuer: opts.issuer,
          audience: opts.audiences,
          clockTolerance: 30,
        });
        payload = result.payload as Record<string, unknown>;
      } catch {
        throw unauthorized('Invalid or expired session');
      }
      const sub = payload.sub;
      const email = String(getPath(payload, emailClaim) ?? '').toLowerCase();
      if (typeof sub !== 'string' || !sub || !email) throw unauthorized('Token is missing sub or email');
      const verifiedRaw = getPath(payload, verifiedClaim);
      const emailVerified = verifiedRaw === true || verifiedRaw === 'true' || (verifiedRaw === undefined && !requireVerified);
      const rawGroups = getPath(payload, groupsClaim);
      const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : typeof rawGroups === 'string' ? rawGroups.split(/[\s,]+/) : [];
      const name = getPath(payload, nameClaim);
      return {
        userId: sub,
        email,
        emailVerified,
        displayName: (typeof name === 'string' && name.trim() ? name.trim() : email.split('@')[0]!).slice(0, 80),
        groups,
        platformRole: platformRoleFromGroupNames(groups, opts.adminGroup, opts.organizerGroup),
      };
    },
  };
}
