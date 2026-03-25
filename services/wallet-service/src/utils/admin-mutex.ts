/**
 * AdminMutex — serializes all admin-keypair-signed Stellar transactions.
 *
 * Why: The admin's G... account has a monotonically increasing sequence number.
 * Two transactions built concurrently from the same base sequence number will
 * collide on submission with txBAD_SEQ. By funneling every admin-signed
 * operation through this mutex, we guarantee at most one is in-flight at a time.
 *
 * Implementation: promise-chain queue. Each caller chains onto the previous
 * promise, so concurrent callers queue in FIFO order. The lock is automatically
 * released when the current operation settles (success or error).
 *
 * Known limitation — horizontal scaling:
 * This mutex is in-memory and process-scoped. If wallet-service is scaled to
 * multiple instances, each instance has its own queue and concurrent admin
 * transactions across instances will still race. To fix, replace with a
 * distributed lock (e.g. Supabase advisory lock via pg_try_advisory_lock, or
 * Redis SETNX with TTL) before introducing horizontal scaling.
 *
 * Known limitation — process restart:
 * If wallet-service crashes or restarts while a background vault-creation job
 * is running, the mutex state is lost along with the job. The startup recovery
 * in index.ts handles this by querying Supabase for users stuck in
 * VAULT_CREATING for more than 5 minutes and resetting them to FAILED, allowing
 * the user to retry. The 5-minute threshold is conservative: admin sign+submit
 * + RPC polling (15 × 2s) + DeFindex confirmation (20 × 3s) takes at most ~90s
 * under normal network conditions.
 */
export class AdminMutex {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    const result = this.queue.then(async () => {
      console.info(`[AdminMutex] acquire: ${label}`);
      try {
        return await fn();
      } finally {
        console.info(`[AdminMutex] release: ${label}`);
        releaseNext();
      }
    });

    this.queue = next;
    return result;
  }
}

export const adminMutex = new AdminMutex();
