import { createLambdaDeps } from '../bootstrap';
import type { AppDeps } from '../deps';
import { closeAbandonedEvents, reconcileLiveEvents, sendUpcomingReminders } from '../services/jobs';

let depsPromise: Promise<AppDeps> | undefined;

interface JobEvent {
  job?: 'reconcile' | 'reminders' | 'cleanup';
}

/** Invoked by EventBridge Scheduler rules with a constant input: {"job": "..."}. */
export async function handler(event: JobEvent) {
  depsPromise ??= createLambdaDeps();
  const deps = await depsPromise;
  switch (event.job) {
    case 'reconcile':
      return { reconciled: await reconcileLiveEvents(deps) };
    case 'reminders':
      return sendUpcomingReminders(deps);
    case 'cleanup':
      return closeAbandonedEvents(deps);
    default:
      throw new Error(`Unknown job: ${String(event.job)}`);
  }
}
