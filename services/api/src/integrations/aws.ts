import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Logger } from '../lib/logger';

// ------------------------------------------------------------------ Mailer
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export class SesMailer implements Mailer {
  private readonly client = new SESv2Client({});
  constructor(
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {}

  async send(message: EmailMessage) {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        ConfigurationSetName: this.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  }
}

/** MOCK — keeps sent mail in memory (and logs it) for tests and local development. */
export class OutboxMailer implements Mailer {
  outbox: EmailMessage[] = [];
  constructor(private readonly logger?: Logger) {}
  async send(message: EmailMessage) {
    this.outbox.push(message);
    // Local dev only: print the link so the invite flow can be completed without SES.
    this.logger?.info('[mock mailer] email captured', { subject: message.subject, body: message.text });
  }
}

// ------------------------------------------------------------------ Object storage
export interface ObjectStorage {
  presignGet(key: string, expiresSeconds: number, downloadName?: string): Promise<string>;
  presignPut(key: string, contentType: string, contentLength: number, expiresSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface S3StorageOptions {
  /** Custom endpoint for S3-compatible services (Cloudflare R2, MinIO, Backblaze B2, Wasabi…). */
  endpoint?: string;
  /**
   * Endpoint browsers/devices use for presigned URLs when it differs from the server-side one
   * (e.g. http://minio:9000 inside Docker vs http://localhost:9000 outside).
   */
  publicEndpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(
    private readonly bucket: string,
    opts: S3StorageOptions = {},
  ) {
    const base = { region: opts.region, forcePathStyle: opts.forcePathStyle, credentials: opts.credentials };
    this.client = new S3Client({ ...base, endpoint: opts.endpoint });
    this.signer = opts.publicEndpoint ? new S3Client({ ...base, endpoint: opts.publicEndpoint }) : this.client;
  }

  presignGet(key: string, expiresSeconds: number, downloadName?: string) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `inline; filename="${downloadName}"` : undefined,
      }),
      { expiresIn: expiresSeconds },
    );
  }

  presignPut(key: string, contentType: string, contentLength: number, expiresSeconds: number) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: expiresSeconds },
    );
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** MOCK — returns non-functional URLs. */
export class MockStorage implements ObjectStorage {
  deleted: string[] = [];
  async presignGet(key: string, expiresSeconds: number) {
    return `https://mock-storage.invalid/${encodeURI(key)}?expires=${expiresSeconds}`;
  }
  async presignPut(key: string) {
    return `https://mock-storage.invalid/upload/${encodeURI(key)}`;
  }
  async delete(key: string) {
    this.deleted.push(key);
  }
}

// ------------------------------------------------------------------ Domain event bus
export interface DomainEvent {
  type: string;
  detail: Record<string, unknown>;
}

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
}

export class EventBridgeBus implements EventBus {
  private readonly client = new EventBridgeClient({});
  constructor(
    private readonly busName: string,
    private readonly logger: Logger,
  ) {}

  async publish(event: DomainEvent) {
    try {
      const res = await this.client.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: this.busName,
              Source: 'lsp.api',
              DetailType: event.type,
              Detail: JSON.stringify(event.detail),
            },
          ],
        }),
      );
      if (res.FailedEntryCount) this.logger.warn('EventBridge entry failed', { type: event.type });
    } catch (err) {
      // Domain events are best-effort notifications; never fail the user request because of them.
      this.logger.warn('EventBridge publish failed', { type: event.type, err });
    }
  }
}

export class MemoryBus implements EventBus {
  events: DomainEvent[] = [];
  async publish(event: DomainEvent) {
    this.events.push(event);
  }
}

// ------------------------------------------------------------------ Secrets
const secretCache = new Map<string, { value: unknown; expires: number }>();
const secretsClient = () => new SecretsManagerClient({});

/** Reads a JSON secret with a 5-minute in-memory cache (per Lambda container). */
export async function getJsonSecret<T>(secretArn: string): Promise<T> {
  const cached = secretCache.get(secretArn);
  if (cached && cached.expires > Date.now()) return cached.value as T;
  const res = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) throw new Error(`Secret ${secretArn} has no string value`);
  const value = JSON.parse(res.SecretString) as T;
  secretCache.set(secretArn, { value, expires: Date.now() + 5 * 60_000 });
  return value;
}
