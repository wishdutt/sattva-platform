/**
 * Local development server. Serves the same router as the Lambda over plain HTTP on :4000.
 *
 *  - Store: in-memory (data resets on restart)       ← MOCK
 *  - Email: captured; view at GET /dev/outbox        ← MOCK
 *  - Auth:  dev tokens "dev:<email>[:organizer|admin]" unless AUTH_MODE=cognito
 *  - LiveKit: REAL if LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET are set, otherwise MOCK
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createLocalDeps } from '../bootstrap';
import { buildRouter } from '../http/routes';
import { OutboxMailer } from '../integrations/aws';
import { handleLiveKitWebhook } from '../services/webhooks';
import { errorResponse } from '../http/router';
import { reconcileLiveEvents } from '../services/jobs';

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
const deps = createLocalDeps();
const router = buildRouter();

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const cors = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ ok: true, mode: deps.mode }));
    return;
  }
  if (url.pathname === '/dev/outbox' && deps.mailer instanceof OutboxMailer) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify(deps.mailer.outbox));
    return;
  }
  const body = await readBody(req);
  if (url.pathname === '/api/v1/webhooks/livekit' && req.method === 'POST') {
    try {
      await handleLiveKitWebhook(deps, body, req.headers.authorization);
      res.writeHead(200).end();
    } catch (err) {
      const r = errorResponse(err, 'local', deps.logger);
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
  });
  res.writeHead(result.status, { ...result.headers, ...cors }).end(result.body);
}).listen(port, () => {
  deps.logger.info(`Local API listening on http://localhost:${port}`, { mode: deps.mode });
});

// Without public webhooks locally, reconcile against real LiveKit every 30s to free stale slots.
if (deps.mode.livekit === 'real') {
  setInterval(() => {
    reconcileLiveEvents(deps).catch((err: unknown) => deps.logger.warn('local reconcile failed', { err }));
  }, 30_000).unref();
}
