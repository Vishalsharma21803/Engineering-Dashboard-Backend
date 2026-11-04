export type Limiter = (<T>(task: () => Promise<T>) => Promise<T>) & {
  /** Nothing running and nothing waiting. */
  readonly isIdle: () => boolean;
};

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (active >= concurrency) {
      return;
    }

    const start = queue.shift();

    if (start) {
      active += 1;
      start();
    }
  }

  const limit = <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });

  return Object.assign(limit, { isIdle: () => active === 0 && queue.length === 0 });
}

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: Limiter,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item) => limit(() => fn(item))));
}
