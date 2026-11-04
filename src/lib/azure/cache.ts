const MAX_ENTRIES = 1_000;
/** Cached responses may hold at most this much text in total; the oldest go first. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** A single response larger than this is never cached (it would push out everything else). */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
  sizeBytes: number;
}

const store = new Map<string, CacheEntry>();
let totalBytes = 0;

function entryKey(credentialId: string, key: string): string {
  return `${credentialId}\u0000${key}`;
}

function remove(fullKey: string): void {
  const entry = store.get(fullKey);

  if (entry) {
    totalBytes -= entry.sizeBytes;
    store.delete(fullKey);
  }
}

export function getCached<T>(credentialId: string, key: string): T | undefined {
  const fullKey = entryKey(credentialId, key);
  const entry = store.get(fullKey);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    remove(fullKey);
    return undefined;
  }

  return entry.value as T;
}

/** `sizeBytes`: how large the cached response is (its text), counted against the total budget. */
export function setCached(
  credentialId: string,
  key: string,
  value: unknown,
  ttlMs: number,
  sizeBytes = 0
): void {
  const fullKey = entryKey(credentialId, key);
  remove(fullKey);

  if (sizeBytes > MAX_ENTRY_BYTES) {
    return;
  }

  // Oldest entries go first (Map keeps insertion order) until both limits hold.
  while (store.size > 0 && (store.size >= MAX_ENTRIES || totalBytes + sizeBytes > MAX_TOTAL_BYTES)) {
    const oldestKey = store.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    remove(oldestKey);
  }

  store.set(fullKey, {
    expiresAt: Date.now() + ttlMs,
    value,
    sizeBytes,
  });
  totalBytes += sizeBytes;
}

export function clearAzureCache(credentialId?: string): void {
  if (credentialId === undefined) {
    store.clear();
    totalBytes = 0;
    return;
  }

  const prefix = `${credentialId}\u0000`;

  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      remove(key);
    }
  }
}

/** Exposed for tests. */
export function azureCacheStatsForTests(): { entries: number; totalBytes: number } {
  return { entries: store.size, totalBytes };
}
