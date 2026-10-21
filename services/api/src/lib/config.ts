import { LIMITS } from '@lsp/shared';

export interface AppConfig {
  stage: string;
  region: string;
  tableName: string;
  mediaBucket: string;
  webBaseUrl: string;
  sesFromAddress: string;
  sesConfigurationSet?: string;
  eventBusName?: string;
  livekitUrl: string;
  livekitSecretArn?: string;
  /** Recording uploads from LiveKit Egress go here (IAM user scoped to recordings/ prefix). */
  egressS3SecretArn?: string;
  cognitoUserPoolId?: string;
  cognitoClientIds: string[];
  joinTokenTtlSeconds: number;
  invitationTtlHours: number;
  chatRetentionDays: number;
  auditRetentionDays: number;
  /** Seconds an admitted-but-never-connected participant keeps its capacity slot. */
  admissionGraceSeconds: number;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    stage: env.STAGE ?? 'local',
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
    tableName: env.TABLE_NAME ?? 'lsp-local-main',
    mediaBucket: env.MEDIA_BUCKET ?? 'lsp-local-media',
    webBaseUrl: (env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    sesFromAddress: env.SES_FROM_ADDRESS ?? 'no-reply@example.com',
    sesConfigurationSet: env.SES_CONFIGURATION_SET || undefined,
    eventBusName: env.EVENT_BUS_NAME || undefined,
    livekitUrl: env.LIVEKIT_URL ?? 'ws://localhost:7880',
    livekitSecretArn: env.LIVEKIT_SECRET_ARN || undefined,
    egressS3SecretArn: env.EGRESS_S3_SECRET_ARN || undefined,
    cognitoUserPoolId: env.COGNITO_USER_POOL_ID || undefined,
    cognitoClientIds: list(env.COGNITO_CLIENT_IDS),
    joinTokenTtlSeconds: Number(env.JOIN_TOKEN_TTL_SECONDS ?? LIMITS.joinTokenTtlSeconds),
    invitationTtlHours: Number(env.INVITATION_TTL_HOURS ?? LIMITS.invitationTtlHours),
    chatRetentionDays: Number(env.CHAT_RETENTION_DAYS ?? 30),
    auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS ?? 365),
    admissionGraceSeconds: Number(env.ADMISSION_GRACE_SECONDS ?? 120),
  };
}
