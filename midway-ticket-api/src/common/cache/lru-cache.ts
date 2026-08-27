// ─────────────────────────────────────────────────────────────────────────────
// In-process LRU cache — a cache layer that sits IN FRONT of Redis, not
// instead of it.
//
// Why this exists as well as Redis: Redis's `allkeys-lru` (docker-compose.yml)
// evicts at the whole-instance level once memory fills up — it doesn't know
// "rides" are hotter than any other key type. This class gives each API
// process its own tiny, in-memory, per-entity LRU with an explicit bounded
// size, so the ~20 rides someone is actively scanning at a fair stay hot in
// local memory (no network hop at all), while cold rides fall back to Redis,
// then Postgres. Rides are the right fit for LRU specifically because access
// is bursty and recency-driven: whichever ride is being scanned *right now*
// at a gate is overwhelmingly likely to be scanned again in the next few
// seconds, and yesterday's popular ride is irrelevant today.
//
// NOT distributed — this cache is local to one Node process. With multiple
// API replicas (see docker-compose.yml `replicas: 2`), each replica has its
// own copy; that's fine for LRU because it's just a speed optimization on
// top of Redis/Postgres, never the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("LruCache capacity must be > 0");
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // Map iterates in insertion order — the first key is the least
      // recently used one.
      const oldestKey = this.map.keys().next().value as K;
      this.map.delete(oldestKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
