import type { Transporter } from 'nodemailer';
import type { EmailMessage, Mailer } from './aws';

/** Sends via any SMTP server (Postmark, Mailgun, SendGrid, Gmail Workspace relay, Mailpit for dev…). */
export class SmtpMailer implements Mailer {
  private transport: Promise<Transporter>;

  constructor(
    private readonly from: string,
    url: string,
  ) {
    // e.g. smtps://user:pass@smtp.example.com:465 or smtp://mailpit:1025
    this.transport = import('nodemailer').then((m) => m.default.createTransport(url));
  }

  async send(message: EmailMessage) {
    const transport = await this.transport;
    await transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

/** Sends via the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!res.ok) throw new Error(`Resend rejected email: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
}
