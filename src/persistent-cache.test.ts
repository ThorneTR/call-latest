import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  PersistentCache,
  MemoryCacheStorage,
} from './persistent-cache.js';
import type { CacheEntry } from './persistent-cache.js';

describe('MemoryCacheStorage', () => {
  let storage: MemoryCacheStorage<string>;

  beforeEach(() => {
    storage = new MemoryCacheStorage<string>();
  });

  it('should get and set entries', async () => {
    const entry: CacheEntry<string> = {
      key: 'k1',
      value: 'v1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
    };
    await storage.set('k1', entry);
    const result = await storage.get('k1');
    expect(result).toEqual(entry);
  });

  it('should return null for missing keys', async () => {
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should delete entries', async () => {
    const entry: CacheEntry<string> = {
      key: 'k1',
      value: 'v1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
    };
    await storage.set('k1', entry);
    const deleted = await storage.delete('k1');
    expect(deleted).toBe(true);
    expect(await storage.get('k1')).toBeNull();
  });

  it('should clear all entries', async () => {
    const entry: CacheEntry<string> = {
      key: 'k1',
      value: 'v1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
    };
    await storage.set('k1', entry);
    await storage.set('k2', { ...entry, key: 'k2', value: 'v2' });
    await storage.clear();
    expect(await storage.size()).toBe(0);
  });

  it('should evict oldest entries', async () => {
    const makeEntry = (key: string): CacheEntry<string> => ({
      key,
      value: `val-${key}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
    });
    await storage.set('a', makeEntry('a'));
    await storage.set('b', makeEntry('b'));
    await storage.set('c', makeEntry('c'));

    await storage.evictOldest(2);
    expect(await storage.size()).toBe(1);
    expect(await storage.get('c')).not.toBeNull();
    expect(await storage.get('a')).toBeNull();
  });

  it('should return all keys', async () => {
    const entry: CacheEntry<string> = {
      key: 'k1',
      value: 'v1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
    };
    await storage.set('k1', entry);
    await storage.set('k2', { ...entry, key: 'k2' });
    const keys = await storage.keys();
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
    expect(keys).toHaveLength(2);
  });
});

describe('PersistentCache', () => {
  let cache: PersistentCache<string>;

  beforeEach(() => {
    cache = new PersistentCache<string>({ storage: 'memory', ttlMs: 1000 });
  });

  it('should set and get values', async () => {
    await cache.set('greeting', 'hello');
    const result = await cache.get('greeting');
    expect(result).toBe('hello');
  });

  it('should return null for missing keys', async () => {
    const result = await cache.get('missing');
    expect(result).toBeNull();
  });

  it('should expire entries based on TTL', async () => {
    const shortTtlCache = new PersistentCache<string>({
      storage: 'memory',
      ttlMs: 10,
    });
    await shortTtlCache.set('temp', 'value');

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));

    const result = await shortTtlCache.get('temp');
    expect(result).toBeNull();
  });

  it('should enforce maxEntries with LRU eviction', async () => {
    const smallCache = new PersistentCache<string>({
      storage: 'memory',
      maxEntries: 3,
      ttlMs: 60_000,
    });

    await smallCache.set('a', '1');
    await smallCache.set('b', '2');
    await smallCache.set('c', '3');
    await smallCache.set('d', '4'); // should evict 'a'

    expect(await smallCache.get('a')).toBeNull();
    expect(await smallCache.get('d')).toBe('4');
    expect(await smallCache.size()).toBe(3);
  });

  it('should prune expired entries', async () => {
    const shortTtlCache = new PersistentCache<string>({
      storage: 'memory',
      ttlMs: 10,
    });
    await shortTtlCache.set('x', 'val1');
    await shortTtlCache.set('y', 'val2');

    await new Promise((r) => setTimeout(r, 20));

    // Add one that's not expired
    await shortTtlCache.set('z', 'val3', 60_000);

    const pruned = await shortTtlCache.prune();
    expect(pruned).toBe(2);
    expect(await shortTtlCache.size()).toBe(1);
  });

  it('should track cache stats (hits and misses)', async () => {
    await cache.set('key', 'value');
    await cache.get('key');     // hit
    await cache.get('key');     // hit
    await cache.get('missing'); // miss

    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it('should report has() correctly', async () => {
    await cache.set('exists', 'yes');
    expect(await cache.has('exists')).toBe(true);
    expect(await cache.has('nope')).toBe(false);
  });

  it('should clear all entries', async () => {
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(await cache.get('a')).toBeNull();
  });

  it('should return all entries', async () => {
    await cache.set('x', 'val-x');
    await cache.set('y', 'val-y');
    const entries = await cache.entries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).sort()).toEqual(['x', 'y']);
  });

  it('should handle concurrent access without corruption', async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      cache.set(`key-${i}`, `value-${i}`),
    );
    await Promise.all(promises);
    expect(await cache.size()).toBe(20);

    // Read all concurrently
    const reads = await Promise.all(
      Array.from({ length: 20 }, (_, i) => cache.get(`key-${i}`)),
    );
    expect(reads.every((v, i) => v === `value-${i}`)).toBe(true);
  });

  it('should delete individual entries', async () => {
    await cache.set('del-me', 'val');
    expect(await cache.has('del-me')).toBe(true);
    const deleted = await cache.delete('del-me');
    expect(deleted).toBe(true);
    expect(await cache.has('del-me')).toBe(false);
  });

  it('should use IndexedDB storage (falls back to memory in Node)', async () => {
    // In Node.js test env, IndexedDB is not available, so it falls back to memory
    const idbCache = new PersistentCache<string>({
      storage: 'indexeddb',
      ttlMs: 60_000,
    });

    await idbCache.set('idb-key', 'idb-value');
    const result = await idbCache.get('idb-key');
    expect(result).toBe('idb-value');
  });

  it('should track eviction stats', async () => {
    const tinyCache = new PersistentCache<string>({
      storage: 'memory',
      maxEntries: 2,
      ttlMs: 60_000,
    });

    await tinyCache.set('a', '1');
    await tinyCache.set('b', '2');
    await tinyCache.set('c', '3'); // evicts 'a'

    const stats = await tinyCache.stats();
    expect(stats.evictions).toBeGreaterThan(0);
  });

  it('should support custom TTL per entry', async () => {
    await cache.set('long-lived', 'value', 60_000);
    await cache.set('short-lived', 'value', 10);

    await new Promise((r) => setTimeout(r, 20));

    expect(await cache.get('long-lived')).toBe('value');
    expect(await cache.get('short-lived')).toBeNull();
  });

  it('should increment access count on get', async () => {
    await cache.set('counted', 'value');
    await cache.get('counted');
    await cache.get('counted');
    await cache.get('counted');

    const entries = await cache.entries();
    const entry = entries.find((e) => e.key === 'counted');
    expect(entry).toBeDefined();
    expect(entry!.accessCount).toBe(3);
  });
});
