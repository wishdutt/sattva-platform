/**
 * Standalone API server (non-AWS deployment): Docker, Render, Fly.io, Railway, Kubernetes, a VM…
 * One process serves the REST API, the LiveKit webhook, and the scheduled jobs.
 */
import { createHttpServer } from './http-server';
import { startScheduler } from './scheduler';
import { createStandaloneDeps } from './standalone';

async function main() {
  const runtime = await createStandaloneDeps();
  const { deps, db } = runtime;
  const port = Number(process.env.PORT ?? 4000);

  const server = createHttpServer(deps, {
    corsOrigins: runtime.corsOrigins,
    devOutbox: process.env.NODE_ENV !== 'production',
    ready: db ? async () => void (await db.query('SELECT 1')) : undefined,
  });
  // Keep-alive slightly above typical load-balancer idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const stopScheduler = process.env.SCHEDULER_ENABLED === 'false' ? () => undefined : startScheduler(deps);

  server.listen(port, () => {
    deps.logger.info(`API listening on :${port}`, { modes: runtime.modes, cors: runtime.corsOrigins });
  });

  const shutdown = (signal: string) => {
    deps.logger.info('shutting down', { signal });
    stopScheduler();
    server.close(() => {
      void db?.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
