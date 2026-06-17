import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DistributedDeduplicator,
  EdgeCoalescer,
} from './distributed-dedupe.js';

describe('DistributedDeduplicator', () => {
  let deduper: DistributedDeduplicator<string>;

  beforeEach(() => {
    deduper = new DistributedDeduplicator<string>();
  });

  it('should deduplicate concurrent calls sharing one promise', async () => {
    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = deduper.dedupe('iphone', fn);
    const p2 = deduper.dedupe('iphone', fn);
    const p3 = deduper.dedupe('iphone', fn);

    resolveOuter!('result');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(r3).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should coalesce within the coalescing window', async () => {
    const shortWindow = new DistributedDeduplicator<string>({
      coalescingWindowMs: 50,
    });

    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = shortWindow.dedupe('query', fn);
    const p2 = shortWindow.dedupe('query', fn);

    resolveOuter!('coalesced');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('coalesced');
    expect(r2).toBe('coalesced');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should handle different keys independently', async () => {
    const fnA = vi.fn().mockResolvedValue('result-a');
    const fnB = vi.fn().mockResolvedValue('result-b');

    const [rA, rB] = await Promise.all([
      deduper.dedupe('key-a', fnA),
      deduper.dedupe('key-b', fnB),
    ]);

    expect(rA).toBe('result-a');
    expect(rB).toBe('result-b');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('should report accurate stats', async () => {
    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = deduper.dedupe('key', fn);
    const p2 = deduper.dedupe('key', fn);
    const p3 = deduper.dedupe('key', fn);

    resolveOuter!('done');
    await Promise.all([p1, p2, p3]);

    const stats = deduper.stats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.uniqueRequests).toBe(1);
    expect(stats.coalescedRequests).toBe(2);
    expect(stats.savedRequests).toBe(2);
    expect(stats.avgWaitersPerKey).toBe(3);
  });

  it('should propagate errors to all waiters', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    const p1 = deduper.dedupe('fail', fn);
    const p2 = deduper.dedupe('fail', fn);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should report pending() count', async () => {
    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    expect(deduper.pending()).toBe(0);

    const p1 = deduper.dedupe('key', fn);
    expect(deduper.pending()).toBe(1);

    resolveOuter!('done');
    await p1;
    expect(deduper.pending()).toBe(0);
  });

  it('should reset and clear all state', async () => {
    const fn = vi.fn().mockResolvedValue('val');
    await deduper.dedupe('key', fn);

    deduper.reset();
    const stats = deduper.stats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.uniqueRequests).toBe(0);
    expect(stats.coalescedRequests).toBe(0);
    expect(deduper.pending()).toBe(0);
  });

  it('should fire onCoalesced callback', async () => {
    const onCoalesced = vi.fn();
    const d = new DistributedDeduplicator<string>({ onCoalesced });

    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = d.dedupe('key', fn);
    const p2 = d.dedupe('key', fn);

    resolveOuter!('done');
    await Promise.all([p1, p2]);

    expect(onCoalesced).toHaveBeenCalledWith('key', 2);
  });

  it('should use custom hash function for key normalization', async () => {
    const d = new DistributedDeduplicator<string>({
      hashFn: (key) => key.toUpperCase(),
    });

    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = d.dedupe('iPhone', fn);
    const p2 = d.dedupe('iphone', fn); // should match 'iPhone' after hash

    resolveOuter!('normalized');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('normalized');
    expect(r2).toBe('normalized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should allow new requests after previous key completes', async () => {
    const fn1 = vi.fn().mockResolvedValue('first');
    const fn2 = vi.fn().mockResolvedValue('second');

    const r1 = await deduper.dedupe('key', fn1);
    expect(r1).toBe('first');

    const r2 = await deduper.dedupe('key', fn2);
    expect(r2).toBe('second');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

describe('EdgeCoalescer', () => {
  let coalescer: EdgeCoalescer<string>;

  beforeEach(() => {
    coalescer = new EdgeCoalescer<string>();
  });

  it('should coalesce concurrent handle() calls', async () => {
    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = coalescer.handle('search-key', fn);
    const p2 = coalescer.handle('search-key', fn);
    const p3 = coalescer.handle('search-key', fn);

    resolveOuter!('edge-result');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe('edge-result');
    expect(r2).toBe('edge-result');
    expect(r3).toBe('edge-result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should report activeKeys', async () => {
    let resolveA: (v: string) => void;
    let resolveB: (v: string) => void;

    const fnA = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveA = r; }),
    );
    const fnB = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveB = r; }),
    );

    const pA = coalescer.handle('key-a', fnA);
    const pB = coalescer.handle('key-b', fnB);

    const active = coalescer.activeKeys();
    expect(active).toContain('key-a');
    expect(active).toContain('key-b');

    resolveA!('a');
    resolveB!('b');
    await Promise.all([pA, pB]);

    expect(coalescer.activeKeys()).toHaveLength(0);
  });

  it('should track stats correctly', async () => {
    let resolveOuter: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((r) => { resolveOuter = r; }),
    );

    const p1 = coalescer.handle('k', fn);
    const p2 = coalescer.handle('k', fn);

    resolveOuter!('v');
    await Promise.all([p1, p2]);

    const stats = coalescer.stats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.uniqueRequests).toBe(1);
    expect(stats.coalescedRequests).toBe(1);
    expect(stats.avgWaitersPerKey).toBe(2);
  });

  it('should propagate errors to all waiters', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('edge-error'));

    const p1 = coalescer.handle('fail', fn);
    const p2 = coalescer.handle('fail', fn);

    await expect(p1).rejects.toThrow('edge-error');
    await expect(p2).rejects.toThrow('edge-error');
  });

  it('should handle different keys independently', async () => {
    const fnA = vi.fn().mockResolvedValue('val-a');
    const fnB = vi.fn().mockResolvedValue('val-b');

    const [rA, rB] = await Promise.all([
      coalescer.handle('a', fnA),
      coalescer.handle('b', fnB),
    ]);

    expect(rA).toBe('val-a');
    expect(rB).toBe('val-b');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
