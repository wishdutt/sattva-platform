import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppDeps } from '../deps';
import { OutboxMailer } from '../integrations/aws';
import { errorResponse } from '../http/router';
import { buildRouter } from '../http/routes';
import { newId } from '../lib/ids';
import { handleLiveKitWebhook } from '../services/webhooks';

export interface HttpServerOptions {
  /** Allowed browser origins for CORS (exact match). */
  corsOrigins: string[];
  /** Expose GET /dev/outbox (local development only). */
  devOutbox?: boolean;
  /** Readiness probe, e.g. a `SELECT 1`. */
  ready?: () => Promise<void>;
  maxBodyBytes?: number;
}

const readBody = (req: IncomingMessage, max: number) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/** Plain Node HTTP server exposing the same router as the Lambda (standalone + local dev). */
export function createHttpServer(deps: AppDeps, opts: HttpServerOptions) {
  const router = buildRouter();
  const maxBody = opts.maxBodyBytes ?? 128 * 1024;

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin || !opts.corsOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'X-Request-Id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = corsHeaders(req);
    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 100) || newId('req');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname === '/ready') {
      try {
        await opts.ready?.();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ready":true}');
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"ready":false}');
      }
      return;
    }
    if (opts.devOutbox && url.pathname === '/dev/outbox' && deps.mailer instanceof OutboxMailer) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify(deps.mailer.outbox));
      return;
    }

    let body: string;
    try {
      body = await readBody(req, maxBody);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json', ...cors }).end('{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Request body too large"}}');
      return;
    }

    if (url.pathname === '/api/v1/webhooks/livekit' && req.method === 'POST') {
      try {
        await handleLiveKitWebhook(deps, body, req.headers.authorization);
        res.writeHead(200).end();
      } catch (err) {
        const r = errorResponse(err, requestId, deps.logger);
        res.writeHead(r.status, r.headers).end(r.body);
      }
      return;
    }

    const result = await router.handle(deps, {
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: req.headers as Record<string, string>,
      query: Object.fromEntries(url.searchParams),
      body: body || undefined,
      requestId,
    });
    res.writeHead(result.status, { ...result.headers, ...cors }).end(result.body);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      deps.logger.error('unhandled server error', { err });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"INTERNAL","message":"Something went wrong"}}');
    });
  });
}
