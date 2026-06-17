/**
 * Multi-Level Cache: L1 RAM → L2 IndexedDB → L3 Edge → L4 API
 *
 * Layers are tried in order. Read promotion writes back to higher layers.
 * Write-through sends writes to all layers simultaneously.
 */

export interface CacheLayer<T> {
  readonly name: string;
  readonly level: number;
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
}

export type MultiLevelCacheOptions = {
  writePolicy?: 'write-through' | 'write-back';  // default 'write-through'
  promotionPolicy?: 'promote-on-read' | 'no-promote';  // default 'promote-on-read'
  onLayerHit?: (layerName: string, key: string) => void;
  onLayerMiss?: (layerName: string, key: string) => void;
};

export type CacheHitResult<T> = {
  value: T;
  layer: string;
  level: number;
  latencyMs: number;
};

// ─── MemoryCacheLayer ───────────────────────────────────────────────────────

type MemoryEntry<T> = { value: T; expiresAt: number };

export class MemoryCacheLayer<T> implements CacheLayer<T> {
  readonly name = 'memory';
  readonly level = 1;
  private readonly store = new Map<string, MemoryEntry<T>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = options?.maxEntries ?? 1000;
    this.defaultTtlMs = options?.ttlMs ?? 60_000;
  }

  async get(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // LRU touch
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
    // Evict oldest if over limit
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }
}

// ─── IndexedDBCacheLayer ────────────────────────────────────────────────────

function hasIndexedDB(): boolean {
  try {
    return typeof globalThis !== 'undefined'
      && typeof (globalThis as Record<string, unknown>).indexedDB !== 'undefined'
      && (globalThis as Record<string, unknown>).indexedDB !== null;
  } catch {
    return false;
  }
}

type IDBEntry<T> = { key: string; value: T; expiresAt: number };

export class IndexedDBCacheLayer<T> implements CacheLayer<T> {
  readonly name = 'indexeddb';
  readonly level = 2;
  private readonly dbName: string;
  private readonly storeName = 'cache-store';
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryFallback: MemoryCacheLayer<T> | null = null;

  constructor(options?: { dbName?: string; maxEntries?: number; ttlMs?: number }) {
    this.dbName = options?.dbName ?? 'call-latest-mlc';
    this.maxEntries = options?.maxEntries ?? 5000;
    this.defaultTtlMs = options?.ttlMs ?? 300_000;

    if (!hasIndexedDB()) {
      this.memoryFallback = new MemoryCacheLayer<T>({
        maxEntries: this.maxEntries,
        ttlMs: this.defaultTtlMs,
      });
    }
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          this.memoryFallback = new MemoryCacheLayer<T>({
            maxEntries: this.maxEntries,
            ttlMs: this.defaultTtlMs,
          });
          reject(req.error);
        };
      } catch (err) {
        this.memoryFallback = new MemoryCacheLayer<T>({
          maxEntries: this.maxEntries,
          ttlMs: this.defaultTtlMs,
        });
        reject(err);
      }
    }).catch(() => null as unknown as IDBDatabase);
    return this.dbPromise;
  }

  private async db(): Promise<IDBDatabase | null> {
    if (this.memoryFallback) return null;
    const db = await this.openDB();
    return db || null;
  }

  async get(key: string): Promise<T | null> {
    if (this.memoryFallback) return this.memoryFallback.get(key);
    const db = await this.db();
    if (!db) return this.memoryFallback!.get(key);

    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);
        req.onsuccess = () => {
          const entry = req.result as IDBEntry<T> | undefined;
          if (!entry) { resolve(null); return; }
          if (Date.now() > entry.expiresAt) { resolve(null); return; }
          resolve(entry.value);
        };
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    if (this.memoryFallback) return this.memoryFallback.set(key, value, ttlMs);
    const db = await this.db();
    if (!db) return this.memoryFallback!.set(key, value, ttlMs);

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put({ key, value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async delete(key: string): Promise<void> {
    if (this.memoryFallback) return this.memoryFallback.delete(key);
    const db = await this.db();
    if (!db) return this.memoryFallback!.delete(key);

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async clear(): Promise<void> {
    if (this.memoryFallback) return this.memoryFallback.clear();
    const db = await this.db();
    if (!db) return this.memoryFallback!.clear();

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async has(key: string): Promise<boolean> {
    const v = await this.get(key);
    return v !== null;
  }
}

// ─── EdgeCacheLayer ─────────────────────────────────────────────────────────

export class EdgeCacheLayer<T> implements CacheLayer<T> {
  readonly name = 'edge';
  readonly level = 3;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultTtlMs: number;

  constructor(options: { endpoint: string; fetcher?: typeof fetch; ttlMs?: number }) {
    this.endpoint = options.endpoint;
    this.fetcher = options.fetcher ?? fetch;
    this.defaultTtlMs = options.ttlMs ?? 600_000;
  }

  async get(key: string): Promise<T | null> {
    try {
      const res = await this.fetcher(`${this.endpoint}?key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const body = await res.json();
      return (body as { value: T }).value ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      await this.fetcher(this.endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, ttlMs: ttlMs ?? this.defaultTtlMs }),
      });
    } catch {
      // best-effort
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.fetcher(`${this.endpoint}?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    } catch {
      // best-effort
    }
  }

  async clear(): Promise<void> {
    try {
      await this.fetcher(this.endpoint, { method: 'DELETE' });
    } catch {
      // best-effort
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.endpoint}?key=${encodeURIComponent(key)}`, {
        method: 'HEAD',
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── MultiLevelCache ────────────────────────────────────────────────────────

type LayerStats = { name: string; hits: number; misses: number };

export class MultiLevelCache<T> {
  private readonly layers: CacheLayer<T>[];
  private readonly writePolicy: 'write-through' | 'write-back';
  private readonly promotionPolicy: 'promote-on-read' | 'no-promote';
  private readonly onLayerHit?: (layerName: string, key: string) => void;
  private readonly onLayerMiss?: (layerName: string, key: string) => void;
  private readonly layerStatsMap = new Map<string, { hits: number; misses: number }>();

  constructor(layers: CacheLayer<T>[], options?: MultiLevelCacheOptions) {
    // Sort layers by level ascending
    this.layers = [...layers].sort((a, b) => a.level - b.level);
    this.writePolicy = options?.writePolicy ?? 'write-through';
    this.promotionPolicy = options?.promotionPolicy ?? 'promote-on-read';
    this.onLayerHit = options?.onLayerHit;
    this.onLayerMiss = options?.onLayerMiss;

    for (const layer of this.layers) {
      this.layerStatsMap.set(layer.name, { hits: 0, misses: 0 });
    }
  }

  async get(key: string): Promise<CacheHitResult<T> | null> {
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const start = Date.now();
      const value = await layer.get(key);
      const latencyMs = Date.now() - start;

      if (value !== null) {
        const stats = this.layerStatsMap.get(layer.name)!;
        stats.hits++;
        this.onLayerHit?.(layer.name, key);

        // Mark misses for all layers before this one
        for (let j = 0; j < i; j++) {
          const missedLayer = this.layers[j];
          const missStats = this.layerStatsMap.get(missedLayer.name)!;
          missStats.misses++;
          this.onLayerMiss?.(missedLayer.name, key);
        }

        // Promote to higher layers
        if (this.promotionPolicy === 'promote-on-read' && i > 0) {
          for (let j = 0; j < i; j++) {
            void this.layers[j].set(key, value);
          }
        }

        return { value, layer: layer.name, level: layer.level, latencyMs };
      }
    }

    // Total miss on all layers
    for (const layer of this.layers) {
      const stats = this.layerStatsMap.get(layer.name)!;
      stats.misses++;
      this.onLayerMiss?.(layer.name, key);
    }

    return null;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    if (this.writePolicy === 'write-through') {
      // Write to all layers
      await Promise.all(this.layers.map((layer) => layer.set(key, value, ttlMs)));
    } else {
      // Write-back: only write to the first (fastest) layer
      if (this.layers.length > 0) {
        await this.layers[0].set(key, value, ttlMs);
      }
    }
  }

  async invalidate(key: string): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.delete(key)));
  }

  async clear(): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.clear()));
  }

  stats(): { layerStats: LayerStats[] } {
    const layerStats: LayerStats[] = this.layers.map((layer) => {
      const s = this.layerStatsMap.get(layer.name)!;
      return { name: layer.name, hits: s.hits, misses: s.misses };
    });
    return { layerStats };
  }
}
