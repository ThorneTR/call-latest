import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  MemoryCacheLayer,
  EdgeCacheLayer,
  MultiLevelCache,
} from './multi-level-cache.js';
import type { CacheLayer, CacheHitResult } from './multi-level-cache.js';

describe('MemoryCacheLayer', () => {
  let layer: MemoryCacheLayer<string>;

  beforeEach(() => {
    layer = new MemoryCacheLayer<string>({ maxEntries: 100, ttlMs: 60_000 });
  });

  it('should get/set/delete values', async () => {
    await layer.set('k1', 'v1');
    expect(await layer.get('k1')).toBe('v1');
    await layer.delete('k1');
    expect(await layer.get('k1')).toBeNull();
  });

  it('should expire entries after TTL', async () => {
    const shortLayer = new MemoryCacheLayer<string>({ ttlMs: 10 });
    await shortLayer.set('temp', 'value');
    await new Promise((r) => setTimeout(r, 20));
    expect(await shortLayer.get('temp')).toBeNull();
  });

  it('should clear all entries', async () => {
    await layer.set('a', '1');
    await layer.set('b', '2');
    await layer.clear();
    expect(await layer.has('a')).toBe(false);
    expect(await layer.has('b')).toBe(false);
  });

  it('should evict oldest when over maxEntries', async () => {
    const small = new MemoryCacheLayer<string>({ maxEntries: 2, ttlMs: 60_000 });
    await small.set('a', '1');
    await small.set('b', '2');
    await small.set('c', '3');
    expect(await small.has('a')).toBe(false);
    expect(await small.has('c')).toBe(true);
  });
});

describe('EdgeCacheLayer', () => {
  it('should fetch from edge endpoint on get', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: 'edge-val' }),
    });

    const edge = new EdgeCacheLayer<string>({
      endpoint: 'https://edge.example.com/cache',
      fetcher: mockFetch as unknown as typeof fetch,
    });

    const result = await edge.get('key1');
    expect(result).toBe('edge-val');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://edge.example.com/cache?key=key1',
    );
  });

  it('should return null on failed get', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    const edge = new EdgeCacheLayer<string>({
      endpoint: 'https://edge.example.com/cache',
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(await edge.get('missing')).toBeNull();
  });

  it('should PUT on set', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const edge = new EdgeCacheLayer<string>({
      endpoint: 'https://edge.example.com/cache',
      fetcher: mockFetch as unknown as typeof fetch,
    });

    await edge.set('k', 'v', 5000);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://edge.example.com/cache',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ key: 'k', value: 'v', ttlMs: 5000 }),
      }),
    );
  });

  it('should handle network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const edge = new EdgeCacheLayer<string>({
      endpoint: 'https://edge.example.com/cache',
      fetcher: mockFetch as unknown as typeof fetch,
    });

    expect(await edge.get('key')).toBeNull();
    await expect(edge.set('k', 'v')).resolves.toBeUndefined();
    await expect(edge.delete('k')).resolves.toBeUndefined();
  });
});

describe('MultiLevelCache', () => {
  let l1: MemoryCacheLayer<string>;
  let l2: MemoryCacheLayer<string>;
  let cache: MultiLevelCache<string>;

  beforeEach(() => {
    l1 = new MemoryCacheLayer<string>({ maxEntries: 100, ttlMs: 60_000 });
    l2 = new MemoryCacheLayer<string>({ maxEntries: 1000, ttlMs: 300_000 });
    // Override l2's level and name for testing
    Object.defineProperty(l2, 'name', { value: 'l2-memory', writable: false });
    Object.defineProperty(l2, 'level', { value: 2, writable: false });
  });

  it('should return L1 hit immediately', async () => {
    cache = new MultiLevelCache([l1, l2]);
    await l1.set('fast', 'L1-value');

    const result = await cache.get('fast');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('L1-value');
    expect(result!.layer).toBe('memory');
    expect(result!.level).toBe(1);
  });

  it('should fall through to L2 on L1 miss and promote to L1', async () => {
    cache = new MultiLevelCache([l1, l2]);
    await l2.set('deep', 'L2-value');

    const result = await cache.get('deep');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('L2-value');
    expect(result!.layer).toBe('l2-memory');

    // Should have been promoted to L1
    const l1Result = await l1.get('deep');
    expect(l1Result).toBe('L2-value');
  });

  it('should not promote when policy is no-promote', async () => {
    cache = new MultiLevelCache([l1, l2], { promotionPolicy: 'no-promote' });
    await l2.set('no-promo', 'value');

    await cache.get('no-promo');
    const l1Result = await l1.get('no-promo');
    expect(l1Result).toBeNull();
  });

  it('should write-through to all layers', async () => {
    cache = new MultiLevelCache([l1, l2], { writePolicy: 'write-through' });
    await cache.set('shared', 'value');

    expect(await l1.get('shared')).toBe('value');
    expect(await l2.get('shared')).toBe('value');
  });

  it('should write-back to only first layer', async () => {
    cache = new MultiLevelCache([l1, l2], { writePolicy: 'write-back' });
    await cache.set('l1-only', 'value');

    expect(await l1.get('l1-only')).toBe('value');
    expect(await l2.get('l1-only')).toBeNull();
  });

  it('should invalidate from all layers', async () => {
    cache = new MultiLevelCache([l1, l2]);
    await cache.set('to-remove', 'value');
    await cache.invalidate('to-remove');

    expect(await l1.get('to-remove')).toBeNull();
    expect(await l2.get('to-remove')).toBeNull();
  });

  it('should track stats per layer', async () => {
    cache = new MultiLevelCache([l1, l2]);
    await l2.set('l2-only', 'val');

    await cache.get('l2-only'); // L1 miss, L2 hit
    await cache.get('l2-only'); // L1 hit (after promotion)

    const { layerStats } = cache.stats();
    const l1Stats = layerStats.find((s) => s.name === 'memory')!;
    const l2Stats = layerStats.find((s) => s.name === 'l2-memory')!;

    expect(l1Stats.hits).toBe(1);
    expect(l1Stats.misses).toBe(1);
    expect(l2Stats.hits).toBe(1);
  });

  it('should clear all layers', async () => {
    cache = new MultiLevelCache([l1, l2]);
    await cache.set('x', '1');
    await cache.set('y', '2');
    await cache.clear();

    expect(await l1.get('x')).toBeNull();
    expect(await l2.get('x')).toBeNull();
  });

  it('should respect layer ordering (sorted by level)', async () => {
    // Pass in reverse order — should still check L1 first
    cache = new MultiLevelCache([l2, l1]);
    await l1.set('ordered', 'L1');
    await l2.set('ordered', 'L2');

    const result = await cache.get('ordered');
    expect(result!.value).toBe('L1');
    expect(result!.level).toBe(1);
  });

  it('should return null on complete miss', async () => {
    cache = new MultiLevelCache([l1, l2]);
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should handle edge layer with mock fetch', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: 'edge-data' }),
      });

    const edge = new EdgeCacheLayer<string>({
      endpoint: 'https://edge.test/cache',
      fetcher: mockFetch as unknown as typeof fetch,
    });

    cache = new MultiLevelCache([l1, edge]);

    // First get misses both
    const miss = await cache.get('key1');
    expect(miss).toBeNull();

    // Second get: L1 miss, edge hit
    const hit = await cache.get('key1');
    expect(hit).not.toBeNull();
    expect(hit!.value).toBe('edge-data');
    expect(hit!.layer).toBe('edge');
  });

  it('should support TTL per layer via set', async () => {
    const shortL1 = new MemoryCacheLayer<string>({ ttlMs: 10 });
    cache = new MultiLevelCache([shortL1, l2]);
    await cache.set('ttl-test', 'value', 10);

    await new Promise((r) => setTimeout(r, 20));
    // L1 should have expired
    expect(await shortL1.get('ttl-test')).toBeNull();
  });

  it('should call onLayerHit and onLayerMiss callbacks', async () => {
    const onHit = vi.fn();
    const onMiss = vi.fn();

    cache = new MultiLevelCache([l1, l2], {
      onLayerHit: onHit,
      onLayerMiss: onMiss,
    });

    await l2.set('callback-key', 'val');
    await cache.get('callback-key');

    expect(onMiss).toHaveBeenCalledWith('memory', 'callback-key');
    expect(onHit).toHaveBeenCalledWith('l2-memory', 'callback-key');
  });
});
