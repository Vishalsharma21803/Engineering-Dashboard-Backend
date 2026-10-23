const MAX_ENTRIES = 1_000;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const store = new Map<string, CacheEntry>();

function entryKey(credentialId: string, key: string): string {
  return `${credentialId}\u0000${key}`;
}

export function getCached<T>(credentialId: string, key: string): T | undefined {
  const fullKey = entryKey(credentialId, key);
  const entry = store.get(fullKey);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(fullKey);
    return undefined;
  }

  return entry.value as T;
}

export function setCached(
  credentialId: string,
  key: string,
  value: unknown,
  ttlMs: number
): void {
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;

    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }

  store.set(entryKey(credentialId, key), {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

export function clearAzureCache(credentialId?: string): void {
  if (credentialId === undefined) {
    store.clear();
    return;
  }

  const prefix = `${credentialId}\u0000`;

  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}
