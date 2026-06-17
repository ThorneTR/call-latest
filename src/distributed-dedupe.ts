/**
 * Distributed Deduplication — edge-level request coalescing.
 *
 * When 10,000 users search 'iphone' at the same time:
 * - 1 backend request
 * - 10,000 users get the result
 */

export type DistributedDedupeOptions = {
  coalescingWindowMs?: number;   // default 100
  maxWaiters?: number;           // default 10000
  edgeEndpoint?: string;
  fetcher?: typeof fetch;
  hashFn?: (key: string) => string;
  onCoalesced?: (key: string, waiterCount: number) => void;
};

export type DedupeStats = {
  totalRequests: number;
  coalescedRequests: number;
  uniqueRequests: number;
  savedRequests: number;
  avgWaitersPerKey: number;
};

type PendingEntry<T> = {
  promise: Promise<T>;
  waiterCount: number;
  createdAt: number;
};

// ─── DistributedDeduplicator (client-side) ──────────────────────────────────

export class DistributedDeduplicator<T> {
  private readonly coalescingWindowMs: number;
  private readonly maxWaiters: number;
  private readonly hashFn: (key: string) => string;
  private readonly onCoalesced?: (key: string, waiterCount: number) => void;

  private readonly inflight = new Map<string, PendingEntry<T>>();

  private _totalRequests = 0;
  private _coalescedRequests = 0;
  private _uniqueRequests = 0;
  private _totalWaiters = 0;
  private _completedKeys = 0;

  constructor(options?: DistributedDedupeOptions) {
    this.coalescingWindowMs = options?.coalescingWindowMs ?? 100;
    this.maxWaiters = options?.maxWaiters ?? 10000;
    this.hashFn = options?.hashFn ?? defaultHash;
    this.onCoalesced = options?.onCoalesced;
  }

  async dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    this._totalRequests++;
    const normalizedKey = this.hashFn(key);

    const existing = this.inflight.get(normalizedKey);
    if (existing) {
      // Within coalescing window and under max waiters
      const withinWindow = (Date.now() - existing.createdAt) < this.coalescingWindowMs;
      if (withinWindow && existing.waiterCount < this.maxWaiters) {
        existing.waiterCount++;
        this._coalescedRequests++;
        return existing.promise;
      }

      // Even if outside window, if still in-flight, share the promise
      if (existing.waiterCount < this.maxWaiters) {
        existing.waiterCount++;
        this._coalescedRequests++;
        return existing.promise;
      }

      // Over max waiters — fall through to new request
    }

    this._uniqueRequests++;

    const entry: PendingEntry<T> = {
      promise: null!,  // will be assigned below
      waiterCount: 1,
      createdAt: Date.now(),
    };

    const promise = fn().then(
      (result) => {
        if (this.inflight.get(normalizedKey) === entry) {
          this.inflight.delete(normalizedKey);
          if (entry.waiterCount > 1) {
            this.onCoalesced?.(key, entry.waiterCount);
          }
          this._totalWaiters += entry.waiterCount;
          this._completedKeys++;
        }
        return result;
      },
      (error) => {
        if (this.inflight.get(normalizedKey) === entry) {
          this.inflight.delete(normalizedKey);
          this._totalWaiters += entry.waiterCount;
          this._completedKeys++;
        }
        throw error;
      },
    );

    entry.promise = promise;
    this.inflight.set(normalizedKey, entry);
    return promise;
  }

  pending(): number {
    return this.inflight.size;
  }

  stats(): DedupeStats {
    const avgWaitersPerKey = this._completedKeys > 0
      ? this._totalWaiters / this._completedKeys
      : 0;

    return {
      totalRequests: this._totalRequests,
      coalescedRequests: this._coalescedRequests,
      uniqueRequests: this._uniqueRequests,
      savedRequests: this._coalescedRequests,
      avgWaitersPerKey,
    };
  }

  reset(): void {
    this.inflight.clear();
    this._totalRequests = 0;
    this._coalescedRequests = 0;
    this._uniqueRequests = 0;
    this._totalWaiters = 0;
    this._completedKeys = 0;
  }
}

// ─── EdgeCoalescer (edge/worker-side) ───────────────────────────────────────

type EdgePendingEntry<T> = {
  promise: Promise<T>;
  waiterCount: number;
};

export class EdgeCoalescer<T> {
  private readonly maxWaiters: number;
  private readonly coalescingWindowMs: number;
  private readonly inflight = new Map<string, EdgePendingEntry<T>>();

  private _totalRequests = 0;
  private _coalescedRequests = 0;
  private _uniqueRequests = 0;
  private _totalWaiters = 0;
  private _completedKeys = 0;

  constructor(options?: { maxWaiters?: number; coalescingWindowMs?: number }) {
    this.maxWaiters = options?.maxWaiters ?? 10000;
    this.coalescingWindowMs = options?.coalescingWindowMs ?? 100;
  }

  async handle(key: string, fn: () => Promise<T>): Promise<T> {
    this._totalRequests++;

    const existing = this.inflight.get(key);
    if (existing && existing.waiterCount < this.maxWaiters) {
      existing.waiterCount++;
      this._coalescedRequests++;
      return existing.promise;
    }

    this._uniqueRequests++;

    const entry: EdgePendingEntry<T> = {
      promise: null!,
      waiterCount: 1,
    };

    const promise = fn().then(
      (result) => {
        if (this.inflight.get(key) === entry) {
          this.inflight.delete(key);
          this._totalWaiters += entry.waiterCount;
          this._completedKeys++;
        }
        return result;
      },
      (error) => {
        if (this.inflight.get(key) === entry) {
          this.inflight.delete(key);
          this._totalWaiters += entry.waiterCount;
          this._completedKeys++;
        }
        throw error;
      },
    );

    entry.promise = promise;
    this.inflight.set(key, entry);
    return promise;
  }

  activeKeys(): string[] {
    return [...this.inflight.keys()];
  }

  stats(): DedupeStats {
    const avgWaitersPerKey = this._completedKeys > 0
      ? this._totalWaiters / this._completedKeys
      : 0;

    return {
      totalRequests: this._totalRequests,
      coalescedRequests: this._coalescedRequests,
      uniqueRequests: this._uniqueRequests,
      savedRequests: this._coalescedRequests,
      avgWaitersPerKey,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultHash(key: string): string {
  // Simple string hash for normalization — trims and lowercases
  return key.trim().toLowerCase();
}
