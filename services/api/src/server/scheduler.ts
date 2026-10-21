import { hostname } from 'node:os';
import type { AppDeps } from '../deps';
import { closeAbandonedEvents, reconcileLiveEvents, sendUpcomingReminders } from '../services/jobs';

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: (deps: AppDeps) => Promise<unknown>;
}

export const DEFAULT_JOBS: ScheduledJob[] = [
  { name: 'reconcile', everyMs: 2 * 60_000, run: reconcileLiveEvents },
  { name: 'reminders', everyMs: 5 * 60_000, run: sendUpcomingReminders },
  { name: 'cleanup', everyMs: 60 * 60_000, run: closeAbandonedEvents },
];

/**
 * In-process replacement for EventBridge Scheduler. Each job never overlaps itself, and when the
 * store supports leases (Postgres) only one replica in the cluster runs a given tick.
 */
export function startScheduler(deps: AppDeps, jobs: ScheduledJob[] = DEFAULT_JOBS) {
  const owner = `${hostname()}-${process.pid}`;
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  const tick = async (job: ScheduledJob) => {
    if (running.has(job.name)) return;
    running.add(job.name);
    try {
      const leaseSeconds = Math.max(30, Math.floor(job.everyMs / 1000) - 5);
      if (deps.store.tryAcquireLease && !(await deps.store.tryAcquireLease(`job:${job.name}`, owner, leaseSeconds))) return;
      const result = await job.run(deps);
      deps.logger.info('scheduled job finished', { job: job.name, result: result as Record<string, unknown> });
    } catch (err) {
      deps.logger.error('scheduled job failed', { job: job.name, err });
    } finally {
      running.delete(job.name);
    }
  };

  for (const job of jobs) {
    // Small random offset so replicas don't stampede the lease at the same instant.
    const first = setTimeout(() => void tick(job), 5_000 + Math.random() * 5_000);
    const every = setInterval(() => void tick(job), job.everyMs);
    first.unref();
    every.unref();
    timers.push(first, every);
  }
  return () => timers.forEach((t) => clearInterval(t));
}
