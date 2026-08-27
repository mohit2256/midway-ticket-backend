// ─────────────────────────────────────────────────────────────────────────────
// In-process LFU cache — for FAIR ("event") data, deliberately NOT LRU.
//
// Fairs behave differently from rides: a fair's detail page gets hit
// consistently over its whole multi-day/multi-week run (marketing links,
// repeat visitors checking ride hours, operators checking their own listing),
// not in short recency bursts. A small number of fairs (the featured one on
// the homepage, a big-city mela) get disproportionately more total traffic
// than the rest for the *entire* period they're active — that's a frequency
// pattern, which LRU handles badly (a fair someone visited 500 times today
// gets evicted the moment 10 different unpopular fairs are viewed once each,
// right after). LFU keeps the genuinely popular fair cached and evicts the
// long tail of one-off lookups instead.
//
// Same caveat as LruCache: local to one process, sits in front of Redis/DB,
// never a source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export class LfuCache<K, V> {
  private readonly values = new Map<K, V>();
  private readonly freq = new Map<K, number>();

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("LfuCache capacity must be > 0");
  }

  get(key: K): V | undefined {
    if (!this.values.has(key)) return undefined;
    this.freq.set(key, (this.freq.get(key) ?? 0) + 1);
    return this.values.get(key);
  }

  set(key: K, value: V): void {
    if (!this.values.has(key) && this.values.size >= this.capacity) {
      this.evictLeastFrequent();
    }
    this.values.set(key, value);
    // A fresh entry starts at frequency 1 rather than 0 — a value that was
    // just written is at least as "wanted" as one that's been read once.
    if (!this.freq.has(key)) this.freq.set(key, 1);
  }

  delete(key: K): void {
    this.values.delete(key);
    this.freq.delete(key);
  }

  has(key: K): boolean {
    return this.values.has(key);
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
    this.freq.clear();
  }

  private evictLeastFrequent(): void {
    let minKey: K | undefined;
    let minFreq = Infinity;
    for (const [key, count] of this.freq) {
      if (count < minFreq) {
        minFreq = count;
        minKey = key;
      }
    }
    if (minKey !== undefined) this.delete(minKey);
  }
}
