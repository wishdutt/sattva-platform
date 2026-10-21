import { createCognitoVerifier, createDevVerifier, type AuthVerifier } from '../auth/verifier';
import { createOidcVerifier } from '../auth/oidc';
import type { AppDeps, EgressCredentials } from '../deps';
import { MockStorage, OutboxMailer, S3Storage, SesMailer, type EventBus, type Mailer, type ObjectStorage } from '../integrations/aws';
import { LiveKitCloudGateway, MockLiveKit, type LiveKitGateway } from '../integrations/livekit';
import { ResendMailer, SmtpMailer } from '../integrations/mail';
import { ExpoPushSender } from '../integrations/push';
import { loadConfig } from '../lib/config';
import { createLogger, type Logger } from '../lib/logger';
import { MemoryStore } from '../store/memory';
import { PostgresStore, migrate } from '../store/postgres';
import { createPgDatabase, createPgliteDatabase, type SqlDatabase } from '../store/sql';
import type { Store } from '../store/types';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v: string | undefined) => v === 'true' || v === '1';

export interface StandaloneRuntime {
  deps: AppDeps;
  corsOrigins: string[];
  db: SqlDatabase | null;
  modes: Record<string, string>;
}

/** Domain events are logged; wire a webhook/queue here if you need downstream consumers. */
class LogBus implements EventBus {
  constructor(private readonly logger: Logger) {}
  async publish(event: { type: string; detail: Record<string, unknown> }) {
    this.logger.info('domain event', { type: event.type, detail: event.detail });
  }
}

/**
 * Builds dependencies for the non-AWS deployment (Docker / any Node host) from environment
 * variables. See services/api/.env.standalone.example for every variable.
 * In NODE_ENV=production every mock/dev adapter is refused.
 */
export async function createStandaloneDeps(env: NodeJS.ProcessEnv = process.env): Promise<StandaloneRuntime> {
  const production = env.NODE_ENV === 'production';
  const config = loadConfig(env);
  const logger = createLogger({ service: 'lsp-api', stage: config.stage }, (env.LOG_LEVEL as 'info') ?? 'info');
  const problems: string[] = [];
  const devOnly = (what: string) => {
    if (production) problems.push(`${what} is not allowed when NODE_ENV=production`);
  };

  // ---------------- Store
  const storeMode = env.STORE ?? 'postgres';
  let store: Store;
  let db: SqlDatabase | null = null;
  if (storeMode === 'postgres') {
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is required for STORE=postgres');
    else {
      db = await createPgDatabase(env.DATABASE_URL, { max: Number(env.DATABASE_POOL_SIZE ?? 10), ssl: bool(env.DATABASE_SSL) });
      store = new PostgresStore(db);
    }
  } else if (storeMode === 'pglite') {
    devOnly('STORE=pglite');
    db = await createPgliteDatabase(env.PGLITE_DIR || undefined);
    store = new PostgresStore(db);
  } else if (storeMode === 'memory') {
    devOnly('STORE=memory');
    store = new MemoryStore();
  } else problems.push(`Unknown STORE=${storeMode}`);
  if (db && env.MIGRATE_ON_START !== 'false') await migrate(db);

  // ---------------- Auth
  const authMode = env.AUTH_MODE ?? 'oidc';
  let verifier: AuthVerifier | undefined;
  if (authMode === 'oidc') {
    if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCES) problems.push('OIDC_ISSUER and OIDC_AUDIENCES are required for AUTH_MODE=oidc');
    else
      verifier = createOidcVerifier({
        issuer: env.OIDC_ISSUER,
        audiences: list(env.OIDC_AUDIENCES),
        jwksUrl: env.OIDC_JWKS_URL || undefined,
        emailClaim: env.OIDC_EMAIL_CLAIM || undefined,
        emailVerifiedClaim: env.OIDC_EMAIL_VERIFIED_CLAIM || undefined,
        nameClaim: env.OIDC_NAME_CLAIM || undefined,
        groupsClaim: env.OIDC_GROUPS_CLAIM || undefined,
        adminGroup: env.OIDC_ADMIN_GROUP || undefined,
        organizerGroup: env.OIDC_ORGANIZER_GROUP || undefined,
        requireEmailVerified: env.OIDC_REQUIRE_EMAIL_VERIFIED !== 'false',
      });
  } else if (authMode === 'cognito') {
    if (!config.cognitoUserPoolId) problems.push('COGNITO_USER_POOL_ID is required for AUTH_MODE=cognito');
    else verifier = createCognitoVerifier(config.cognitoUserPoolId, config.cognitoClientIds);
  } else if (authMode === 'dev') {
    devOnly('AUTH_MODE=dev');
    verifier = createDevVerifier();
  } else problems.push(`Unknown AUTH_MODE=${authMode}`);

  // ---------------- LiveKit
  let livekit: LiveKitGateway;
  if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    livekit = new LiveKitCloudGateway(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, env.LIVEKIT_API_URL || undefined);
  } else {
    devOnly('Missing LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET (mock LiveKit)');
    livekit = new MockLiveKit();
  }

  // ---------------- Object storage
  let storage: ObjectStorage;
  const s3Credentials =
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
      : undefined;
  if (env.S3_BUCKET) {
    storage = new S3Storage(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT || undefined,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
      region: env.S3_REGION || 'auto',
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE),
      credentials: s3Credentials,
    });
    config.mediaBucket = env.S3_BUCKET;
    config.region = env.S3_REGION || 'auto';
  } else {
    devOnly('Missing S3_BUCKET (mock storage)');
    storage = new MockStorage();
  }

  // ---------------- Email
  const mailFrom = env.MAIL_FROM ?? config.sesFromAddress;
  const mailProvider = env.MAIL_PROVIDER ?? (production ? '' : 'outbox');
  let mailer: Mailer;
  if (mailProvider === 'smtp') {
    if (!env.SMTP_URL) problems.push('SMTP_URL is required for MAIL_PROVIDER=smtp');
    mailer = new SmtpMailer(mailFrom, env.SMTP_URL ?? '');
  } else if (mailProvider === 'resend') {
    if (!env.RESEND_API_KEY) problems.push('RESEND_API_KEY is required for MAIL_PROVIDER=resend');
    mailer = new ResendMailer(mailFrom, env.RESEND_API_KEY ?? '');
  } else if (mailProvider === 'ses') {
    mailer = new SesMailer(mailFrom, config.sesConfigurationSet);
  } else if (mailProvider === 'outbox') {
    devOnly('MAIL_PROVIDER=outbox');
    mailer = new OutboxMailer(logger);
  } else {
    problems.push('MAIL_PROVIDER must be smtp, resend or ses');
    mailer = new OutboxMailer(logger);
  }

  // ---------------- Egress upload credentials (should be an upload-only key for recordings/)
  const egress: EgressCredentials | null =
    (env.EGRESS_S3_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID) && (env.EGRESS_S3_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY)
      ? {
          accessKey: (env.EGRESS_S3_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID)!,
          secret: (env.EGRESS_S3_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY)!,
          // Must be reachable from LiveKit's Egress workers (i.e. a public endpoint for LiveKit Cloud).
          endpoint: env.EGRESS_S3_ENDPOINT ?? env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
          forcePathStyle: bool(env.S3_FORCE_PATH_STYLE),
        }
      : null;

  if (problems.length) {
    await db?.close();
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }

  const corsOrigins = list(env.CORS_ORIGINS).length ? list(env.CORS_ORIGINS) : [config.webBaseUrl];
  const deps: AppDeps = {
    config,
    logger,
    store: store!,
    livekit,
    mailer,
    storage,
    bus: new LogBus(logger),
    push: new ExpoPushSender(logger, env.EXPO_ACCESS_TOKEN),
    verifier: verifier!,
    now: () => new Date(),
    egressCredentials: async () => {
      if (!egress) throw new Error('Recording requires S3 credentials (EGRESS_S3_* or S3_*)');
      return egress;
    },
  };
  return {
    deps,
    corsOrigins,
    db,
    modes: { store: storeMode, auth: authMode, livekit: livekit instanceof MockLiveKit ? 'mock' : 'real', mail: mailProvider, storage: env.S3_BUCKET ? 's3' : 'mock' },
  };
}
