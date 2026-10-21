import type { AuthVerifier } from './auth/verifier';
import type { EventBus, Mailer, ObjectStorage } from './integrations/aws';
import type { LiveKitGateway } from './integrations/livekit';
import type { PushSender } from './integrations/push';
import type { AppConfig } from './lib/config';
import type { Logger } from './lib/logger';
import type { Store } from './store/types';

export interface EgressCredentials {
  accessKey: string;
  secret: string;
}

export interface AppDeps {
  config: AppConfig;
  store: Store;
  livekit: LiveKitGateway;
  mailer: Mailer;
  storage: ObjectStorage;
  bus: EventBus;
  push: PushSender;
  verifier: AuthVerifier;
  logger: Logger;
  now: () => Date;
  egressCredentials: () => Promise<EgressCredentials>;
}
