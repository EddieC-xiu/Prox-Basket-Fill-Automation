/**
 * Tiny inline replacements for p-limit and p-retry.
 * Avoids ESM-only packages in a CommonJS project.
 */

/** Cap how many async tasks run simultaneously. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < concurrency) {
      active++;
      return fn().finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    }
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        run(fn).then(resolve, reject);
      });
    });
  }

  return run;
}

export interface RetryOptions {
  retries?: number;
  minTimeout?: number;
  onFailedAttempt?: (err: Error & { attemptNumber: number }) => void;
}

/** Retry an async function with exponential back-off. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { retries = 3, minTimeout = 500, onFailedAttempt } = opts;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > retries) throw err;
      const typedErr = err as Error & { attemptNumber: number };
      typedErr.attemptNumber = attempt;
      onFailedAttempt?.(typedErr);
      await new Promise((r) => setTimeout(r, minTimeout * 2 ** (attempt - 1)));
    }
  }
  // unreachable
  throw new Error("retry loop exited unexpectedly");
}
