/**
 * Persistent Cache using IndexedDB or Memory with LRU eviction and TTL.
 */

export type PersistentCacheStorage = 'memory' | 'indexeddb';

export type PersistentCacheOptions = {
  storage?: PersistentCacheStorage;  // default 'memory'
  dbName?: string;                    // default 'call-latest-cache'
  storeName?: string;                 // default 'search-cache'
  maxEntries?: number;                // default 1000
  ttlMs?: number;                     // default 5 * 60 * 1000 (5 min)
  serialize?: <T>(value: T) => string;
  deserialize?: <T>(raw: string) => T;
};

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

export interface ICacheStorage<T> {
  get(key: string): Promise<CacheEntry<T> | null>;
  set(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  size(): Promise<number>;
  keys(): Promise<string[]>;
  evictOldest(count: number): Promise<void>;
}

// ─── MemoryCacheStorage ─────────────────────────────────────────────────────

export class MemoryCacheStorage<T> implements ICacheStorage<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  async get(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    // LRU touch: delete and re-insert so it moves to the end
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    // LRU: delete first if exists, then re-insert at end
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async size(): Promise<number> {
    return this.store.size;
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async evictOldest(count: number): Promise<void> {
    const keys = [...this.store.keys()];
    const toEvict = keys.slice(0, count);
    for (const k of toEvict) {
      this.store.delete(k);
    }
  }
}

// ─── IndexedDBCacheStorage ──────────────────────────────────────────────────

function hasIndexedDB(): boolean {
  try {
    return typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>).indexedDB !== 'undefined' && (globalThis as Record<string, unknown>).indexedDB !== null;
  } catch {
    return false;
  }
}

export class IndexedDBCacheStorage<T> implements ICacheStorage<T> {
  private readonly dbName: string;
  private readonly storeName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private fallback: MemoryCacheStorage<T> | null = null;

  constructor(dbName = 'call-latest-cache', storeName = 'search-cache') {
    this.dbName = dbName;
    this.storeName = storeName;

    if (!hasIndexedDB()) {
      this.fallback = new MemoryCacheStorage<T>();
    }
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.fallback = new MemoryCacheStorage<T>();
          reject(request.error);
        };
      } catch (err) {
        this.fallback = new MemoryCacheStorage<T>();
        reject(err);
      }
    });

    // If DB open fails, switch to fallback
    this.dbPromise = this.dbPromise.catch(() => {
      this.fallback = this.fallback ?? new MemoryCacheStorage<T>();
      return null as unknown as IDBDatabase;
    });

    return this.dbPromise;
  }

  private async getDB(): Promise<IDBDatabase | null> {
    if (this.fallback) return null;
    const db = await this.openDB();
    if (!db) return null;
    return db;
  }

  async get(key: string): Promise<CacheEntry<T> | null> {
    if (this.fallback) return this.fallback.get(key);
    const db = await this.getDB();
    if (!db) return this.fallback!.get(key);

    return new Promise<CacheEntry<T> | null>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.get(key);
        request.onsuccess = () => resolve((request.result as CacheEntry<T>) ?? null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    if (this.fallback) return this.fallback.set(key, entry);
    const db = await this.getDB();
    if (!db) return this.fallback!.set(key, entry);

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async delete(key: string): Promise<boolean> {
    if (this.fallback) return this.fallback.delete(key);
    const db = await this.getDB();
    if (!db) return this.fallback!.delete(key);

    return new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async clear(): Promise<void> {
    if (this.fallback) return this.fallback.clear();
    const db = await this.getDB();
    if (!db) return this.fallback!.clear();

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async size(): Promise<number> {
    if (this.fallback) return this.fallback.size();
    const db = await this.getDB();
    if (!db) return this.fallback!.size();

    return new Promise<number>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  }

  async keys(): Promise<string[]> {
    if (this.fallback) return this.fallback.keys();
    const db = await this.getDB();
    if (!db) return this.fallback!.keys();

    return new Promise<string[]>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async evictOldest(count: number): Promise<void> {
    if (this.fallback) return this.fallback.evictOldest(count);
    const db = await this.getDB();
    if (!db) return this.fallback!.evictOldest(count);

    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();
        request.onsuccess = () => {
          const entries = (request.result as CacheEntry<T>[])
            .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
          const toDelete = entries.slice(0, count);
          for (const entry of toDelete) {
            store.delete(entry.key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

// ─── PersistentCache ────────────────────────────────────────────────────────

export class PersistentCache<T> {
  private readonly storage: ICacheStorage<T>;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options?: PersistentCacheOptions) {
    const storageType = options?.storage ?? 'memory';
    this.maxEntries = options?.maxEntries ?? 1000;
    this.defaultTtlMs = options?.ttlMs ?? 5 * 60 * 1000;

    if (storageType === 'indexeddb') {
      this.storage = new IndexedDBCacheStorage<T>(
        options?.dbName ?? 'call-latest-cache',
        options?.storeName ?? 'search-cache',
      );
    } else {
      this.storage = new MemoryCacheStorage<T>();
    }
  }

  async get(key: string): Promise<T | null> {
    const entry = await this.storage.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      await this.storage.delete(key);
      this._misses++;
      return null;
    }

    // Update access stats
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    await this.storage.set(key, entry);

    this._hits++;
    return entry.value;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      accessCount: 0,
      lastAccessedAt: now,
    };

    await this.storage.set(key, entry);

    // Enforce maxEntries via LRU eviction
    const currentSize = await this.storage.size();
    if (currentSize > this.maxEntries) {
      const overCount = currentSize - this.maxEntries;
      await this.storage.evictOldest(overCount);
      this._evictions += overCount;
    }
  }

  async has(key: string): Promise<boolean> {
    const entry = await this.storage.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      await this.storage.delete(key);
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async clear(): Promise<void> {
    await this.storage.clear();
  }

  async size(): Promise<number> {
    return this.storage.size();
  }

  async entries(): Promise<CacheEntry<T>[]> {
    const allKeys = await this.storage.keys();
    const result: CacheEntry<T>[] = [];
    for (const key of allKeys) {
      const entry = await this.storage.get(key);
      if (entry) {
        result.push(entry);
      }
    }
    return result;
  }

  async prune(): Promise<number> {
    const allKeys = await this.storage.keys();
    let removed = 0;
    const now = Date.now();
    for (const key of allKeys) {
      const entry = await this.storage.get(key);
      if (entry && now > entry.expiresAt) {
        await this.storage.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async stats(): Promise<{ hits: number; misses: number; evictions: number; size: number }> {
    const currentSize = await this.storage.size();
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: currentSize,
    };
  }
}
