/**
 * Local development server on :4000 (no cloud accounts needed).
 *
 *  - Store: in-memory (data resets on restart)       ← MOCK
 *  - Email: captured; view at GET /dev/outbox        ← MOCK
 *  - Auth:  dev tokens "dev:<email>[:organizer|admin]" unless AUTH_MODE=cognito
 *  - LiveKit: REAL if LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET are set, otherwise MOCK
 *
 * For a production-like local stack (Postgres, MinIO, OIDC) use docker compose or `npm run start:standalone`.
 */
import { createLocalDeps } from '../bootstrap';
import { createHttpServer } from '../server/http-server';
import { startScheduler } from '../server/scheduler';

const port = Number(process.env.PORT ?? 4000);
const deps = createLocalDeps();

createHttpServer(deps, {
  corsOrigins: [process.env.WEB_BASE_URL ?? 'http://localhost:3000'],
  devOutbox: true,
}).listen(port, () => {
  deps.logger.info(`Local API listening on http://localhost:${port}`, { mode: deps.mode });
});

// Reconciliation only makes sense against real LiveKit (mock rooms are always empty).
if (deps.mode.livekit === 'real') startScheduler(deps);
