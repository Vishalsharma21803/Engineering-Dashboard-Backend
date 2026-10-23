export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

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

  return <T>(task: () => Promise<T>) =>
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
}

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: Limiter,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item) => limit(() => fn(item))));
}
