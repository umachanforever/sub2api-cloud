import {Database} from './db.ts';

export const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

// Keep short crash-recovery leases alive only while the request is active.
export function keepRequestLease(db: Database, lease: string, signal: AbortSignal, failed: AbortController, intervalMs = 60_000): () => void {
  let stopped = false, pending = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener('abort', stop);
  };
  const timer = setInterval(async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      const renewed = await db.rpc<boolean>('s2a_personal_lease_renew', {p_lease_id: lease});
      if (!stopped && !renewed) failed.abort(new Error('request_lease_expired'));
    } catch {
      if (!stopped) failed.abort(new Error('request_lease_renew_failed'));
    } finally { pending = false; }
  }, intervalMs);
  (timer as unknown as {unref?: () => void}).unref?.();
  signal.addEventListener('abort', stop, {once: true});
  if (signal.aborted) stop();
  return stop;
}
