import { createCognitoVerifier, createDevVerifier } from './auth/verifier';
import type { AppDeps, EgressCredentials } from './deps';
import {
  EventBridgeBus,
  MemoryBus,
  MockStorage,
  OutboxMailer,
  S3Storage,
  SesMailer,
  getJsonSecret,
} from './integrations/aws';
import { LiveKitCloudGateway, MockLiveKit, type LiveKitGateway } from './integrations/livekit';
import { ExpoPushSender, MemoryPush } from './integrations/push';
import { loadConfig } from './lib/config';
import { createLogger } from './lib/logger';
import { DynamoStore } from './store/dynamo';
import { MemoryStore } from './store/memory';

interface LiveKitSecret {
  apiKey: string;
  apiSecret: string;
}

/** Production wiring for Lambda: every dependency is the real AWS / LiveKit implementation. */
export async function createLambdaDeps(): Promise<AppDeps> {
  const config = loadConfig();
  const logger = createLogger({ service: 'lsp-api', stage: config.stage }, (process.env.LOG_LEVEL as 'info') ?? 'info');
  if (!config.livekitSecretArn) throw new Error('LIVEKIT_SECRET_ARN is required');
  if (!config.cognitoUserPoolId || config.cognitoClientIds.length === 0) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS are required');
  }
  const lk = await getJsonSecret<LiveKitSecret>(config.livekitSecretArn);
  return {
    config,
    logger,
    store: new DynamoStore(config.tableName),
    livekit: new LiveKitCloudGateway(config.livekitUrl, lk.apiKey, lk.apiSecret),
    mailer: new SesMailer(config.sesFromAddress, config.sesConfigurationSet),
    storage: new S3Storage(config.mediaBucket),
    bus: config.eventBusName ? new EventBridgeBus(config.eventBusName, logger) : new MemoryBus(),
    push: new ExpoPushSender(logger, process.env.EXPO_ACCESS_TOKEN),
    verifier: createCognitoVerifier(config.cognitoUserPoolId, config.cognitoClientIds),
    now: () => new Date(),
    egressCredentials: async () => {
      if (!config.egressS3SecretArn) throw new Error('EGRESS_S3_SECRET_ARN is not configured');
      return getJsonSecret<EgressCredentials>(config.egressS3SecretArn);
    },
  };
}

/**
 * Local development wiring. Uses in-memory store, mock mailer/storage and dev auth.
 * If LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL are set, it talks to real LiveKit
 * (so audio/video can be tested end-to-end locally); otherwise LiveKit is mocked.
 */
export function createLocalDeps(): AppDeps & { mode: { livekit: 'real' | 'mock'; auth: 'dev' | 'cognito' } } {
  const config = loadConfig();
  const logger = createLogger({ service: 'lsp-api-local' }, 'info');
  const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
  const livekit: LiveKitGateway =
    LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL
      ? new LiveKitCloudGateway(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      : new MockLiveKit();
  const useCognito = process.env.AUTH_MODE === 'cognito' && config.cognitoUserPoolId;
  return {
    mode: { livekit: livekit instanceof MockLiveKit ? 'mock' : 'real', auth: useCognito ? 'cognito' : 'dev' },
    config,
    logger,
    store: new MemoryStore(),
    livekit,
    mailer: new OutboxMailer(logger),
    storage: new MockStorage(),
    bus: new MemoryBus(),
    push: new MemoryPush(),
    verifier: useCognito ? createCognitoVerifier(config.cognitoUserPoolId!, config.cognitoClientIds) : createDevVerifier(),
    now: () => new Date(),
    egressCredentials: async () => ({ accessKey: 'local', secret: 'local' }),
  };
}
