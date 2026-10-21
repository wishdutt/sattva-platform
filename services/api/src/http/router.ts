import { API_PREFIX, type ApiErrorBody } from '@lsp/shared';
import { bearerFrom, type AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { AppError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: string | undefined;
  requestId?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RouteContext {
  deps: AppDeps;
  user: AuthUser;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

type Handler = (ctx: RouteContext) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  status: number;
  idempotent: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: { status?: number; idempotent?: boolean } = {}) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        (API_PREFIX + path).replace(/\{(\w+)\}/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, pattern, keys, handler, status: opts.status ?? 200, idempotent: !!opts.idempotent });
    return this;
  }

  match(method: string, path: string) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
    if (pathMatched) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return null;
  }

  async handle(deps: AppDeps, req: HttpRequest): Promise<HttpResponse> {
    const requestId = req.requestId ?? newId('req');
    const log = deps.logger.child({ requestId, method: req.method, path: req.path });
    const started = Date.now();
    try {
      const matched = this.match(req.method, req.path);
      if (!matched) throw notFound('Route');
      const user = await deps.verifier.verify(bearerFrom(lowerKeys(req.headers)));

      let body: unknown = undefined;
      if (req.body) {
        if (req.body.length > 64 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
        try {
          body = JSON.parse(req.body);
        } catch {
          throw badRequest('Body must be valid JSON');
        }
      }

      // Idempotency-Key support for creation endpoints: replay the first response for 24h.
      const idemHeader = lowerKeys(req.headers)['idempotency-key'];
      const idemKey =
        matched.route.idempotent && idemHeader && /^[\w-]{8,100}$/.test(idemHeader)
          ? `${user.userId}#${req.method}#${req.path}#${idemHeader}`
          : null;
      if (idemKey) {
        const cached = await deps.store.getIdempotentResponse(idemKey);
        if (cached) return json(cached.status, cached.body, requestId, { 'Idempotent-Replay': 'true' });
      }

      const result = await matched.route.handler({ deps, user, params: matched.params, query: req.query, body });
      const status = result === undefined ? 204 : matched.route.status;
      if (idemKey) await deps.store.putIdempotentResponse(idemKey, { status, body: result ?? null }, 86_400);
      log.info('request', { status, ms: Date.now() - started, userId: user.userId });
      return json(status, result, requestId);
    } catch (err) {
      return errorResponse(err, requestId, log);
    }
  }
}

export function lowerKeys(h: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { ...SECURITY_HEADERS, 'X-Request-Id': requestId, ...extra },
    body: status === 204 || body === undefined ? '' : JSON.stringify(body),
  };
}

export function errorResponse(
  err: unknown,
  requestId: string,
  log: { warn: (m: string, d?: Record<string, unknown>) => void; error: (m: string, d?: Record<string, unknown>) => void },
) {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error('request failed', { code: err.code, err });
    else log.warn('request rejected', { status: err.status, code: err.code });
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details, requestId } };
    return json(err.status, body, requestId);
  }
  log.error('unhandled error', { err });
  const body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong', requestId } };
  return json(500, body, requestId);
}
