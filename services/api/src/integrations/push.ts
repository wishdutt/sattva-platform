import type { Logger } from '../lib/logger';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<void>;
}

/** Sends notifications through the Expo push service (which relays to APNs / FCM). */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly logger: Logger,
    private readonly accessToken?: string,
  ) {}

  async send(messages: PushMessage[]) {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(chunk.map((m) => ({ ...m, sound: 'default' }))),
      });
      if (!res.ok) this.logger.warn('Expo push request failed', { status: res.status });
    }
  }
}

export class MemoryPush implements PushSender {
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    this.sent.push(...messages);
  }
}
