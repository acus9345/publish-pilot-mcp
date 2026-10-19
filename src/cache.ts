/**
 * Short-lived memo for slow lookups (gh/npm logins, tool versions). Calls made while one is in
 * flight share it. Only results that `keep` accepts are remembered, so "not logged in" or
 * "not installed" is always checked again: the user may have just fixed it.
 */
const entries = new Map<string, { expires: number; value: Promise<unknown> }>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const value = fn();
  entries.set(key, { expires: Date.now() + ttlMs, value });
  value.then(
    (v) => {
      if (!keep(v) && entries.get(key)?.value === value) entries.delete(key);
    },
    () => {
      if (entries.get(key)?.value === value) entries.delete(key);
    },
  );
  return value;
}

/** Forget cached entries whose key starts with `prefix` (all when omitted). */
export function clearCache(prefix = ""): void {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}
