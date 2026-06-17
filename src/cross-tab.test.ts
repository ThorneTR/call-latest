import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CrossTabDeduplicator } from './cross-tab.js';
import type { CrossTabMessage } from './cross-tab.js';

// ─── BroadcastChannel Mock ──────────────────────────────────────────────────

type Listener = (event: { data: unknown }) => void;

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  readonly name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private listeners: Array<{ type: string; handler: Listener }> = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('Channel closed');
    // Broadcast to all OTHER instances with the same name
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && !instance.closed) {
        // Simulate async delivery
        const event = { data } as MessageEvent;
        if (instance.onmessage) {
          instance.onmessage(event);
        }
        for (const l of instance.listeners) {
          if (l.type === 'message') {
            l.handler({ data });
          }
        }
      }
    }
  }

  addEventListener(type: string, handler: Listener): void {
    this.listeners.push({ type, handler });
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.handler === handler),
    );
  }

  close(): void {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }

  static reset(): void {
    for (const inst of [...MockBroadcastChannel.instances]) {
      inst.closed = true;
    }
    MockBroadcastChannel.instances = [];
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('CrossTabDeduplicator', () => {
  let originalBC: typeof globalThis.BroadcastChannel;

  beforeEach(() => {
    MockBroadcastChannel.reset();
    originalBC = globalThis.BroadcastChannel;
    (globalThis as Record<string, unknown>).BroadcastChannel = MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    if (originalBC) {
      (globalThis as Record<string, unknown>).BroadcastChannel = originalBC;
    } else {
      delete (globalThis as Record<string, unknown>).BroadcastChannel;
    }
  });

  it('should perform basic dedupe - leader fetches and returns', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({ role: 'leader' });
    const fn = vi.fn().mockResolvedValue('result');

    const result = await deduplicator.dedupe('key1', fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);

    deduplicator.destroy();
  });

  it('should handle leader election - first tab claims and fetches', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({ role: 'leader' });
    const fn = vi.fn().mockResolvedValue('leader-result');

    const result = await deduplicator.dedupe('search-key', fn);
    expect(result).toBe('leader-result');
    expect(fn).toHaveBeenCalledTimes(1);

    const stats = deduplicator.stats();
    expect(stats.served).toBe(1);

    deduplicator.destroy();
  });

  it('should allow follower to receive result from leader via broadcast', async () => {
    const leader = new CrossTabDeduplicator<string>({ role: 'leader' });
    const follower = new CrossTabDeduplicator<string>({
      role: 'follower',
      responseTimeoutMs: 5000,
    });

    const leaderFn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'shared-result';
    });

    const followerFn = vi.fn().mockResolvedValue('follower-fallback');

    // Start follower waiting first, then leader fetches
    const followerPromise = follower.dedupe('key1', followerFn);

    // Small delay then leader fetches
    await new Promise((r) => setTimeout(r, 5));
    await leader.dedupe('key1', leaderFn);

    const followerResult = await followerPromise;
    expect(followerResult).toBe('shared-result');
    expect(followerFn).not.toHaveBeenCalled();

    leader.destroy();
    follower.destroy();
  });

  it('should timeout and fallback when leader does not respond', async () => {
    const follower = new CrossTabDeduplicator<string>({
      role: 'follower',
      responseTimeoutMs: 50,
    });

    const fallbackFn = vi.fn().mockResolvedValue('fallback-result');
    const result = await follower.dedupe('key1', fallbackFn);

    expect(result).toBe('fallback-result');
    expect(fallbackFn).toHaveBeenCalledTimes(1);

    const stats = follower.stats();
    expect(stats.timeouts).toBe(1);

    follower.destroy();
  });

  it('should clean up on destroy', () => {
    const deduplicator = new CrossTabDeduplicator<string>();
    expect(deduplicator.activeCount()).toBe(0);
    deduplicator.destroy();
    // After destroy, calls should just run the function directly
  });

  it('should track stats correctly', async () => {
    const leader = new CrossTabDeduplicator<string>({ role: 'leader' });
    const fn = vi.fn().mockResolvedValue('data');

    await leader.dedupe('key1', fn);
    await leader.dedupe('key2', fn);

    const stats = leader.stats();
    expect(stats.served).toBe(2);
    expect(stats.received).toBe(0);
    expect(stats.timeouts).toBe(0);

    leader.destroy();
  });

  it('should be SSR-safe when BroadcastChannel is unavailable', async () => {
    delete (globalThis as Record<string, unknown>).BroadcastChannel;

    const deduplicator = new CrossTabDeduplicator<string>();
    const fn = vi.fn().mockResolvedValue('ssr-result');

    const result = await deduplicator.dedupe('key1', fn);
    expect(result).toBe('ssr-result');
    expect(fn).toHaveBeenCalledTimes(1);

    deduplicator.destroy();
  });

  it('should handle concurrent requests for same key', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({ role: 'leader' });
    let resolvePromise: (value: string) => void;
    const slowFn = vi.fn().mockImplementation(() =>
      new Promise<string>((r) => { resolvePromise = r; }),
    );

    const p1 = deduplicator.dedupe('same-key', slowFn);
    const p2 = deduplicator.dedupe('same-key', slowFn);

    // Both should share the same in-flight promise
    await Promise.resolve(); // yield to microtask just in case
    resolvePromise!('shared');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('shared');
    expect(r2).toBe('shared');
    expect(slowFn).toHaveBeenCalledTimes(1);

    deduplicator.destroy();
  });

  it('should not interfere between different keys', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({ role: 'leader' });
    const fn1 = vi.fn().mockResolvedValue('result-a');
    const fn2 = vi.fn().mockResolvedValue('result-b');

    const [r1, r2] = await Promise.all([
      deduplicator.dedupe('key-a', fn1),
      deduplicator.dedupe('key-b', fn2),
    ]);

    expect(r1).toBe('result-a');
    expect(r2).toBe('result-b');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);

    deduplicator.destroy();
  });

  it('should propagate errors from leader', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({ role: 'leader' });
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(deduplicator.dedupe('key1', fn)).rejects.toThrow('fetch failed');

    deduplicator.destroy();
  });

  it('should run function directly after destroy', async () => {
    const deduplicator = new CrossTabDeduplicator<string>();
    deduplicator.destroy();

    const fn = vi.fn().mockResolvedValue('post-destroy');
    const result = await deduplicator.dedupe('key1', fn);
    expect(result).toBe('post-destroy');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should report activeCount correctly', async () => {
    const deduplicator = new CrossTabDeduplicator<string>({
      role: 'follower',
      responseTimeoutMs: 200,
    });

    expect(deduplicator.activeCount()).toBe(0);

    const promise = deduplicator.dedupe('key1', async () => 'val');
    // During the timeout wait, there should be a pending request
    expect(deduplicator.activeCount()).toBe(1);

    await promise;
    expect(deduplicator.activeCount()).toBe(0);

    deduplicator.destroy();
  });

  it('should use custom channel name', async () => {
    const d1 = new CrossTabDeduplicator<string>({
      channelName: 'custom-channel',
      role: 'leader',
    });
    const d2 = new CrossTabDeduplicator<string>({
      channelName: 'other-channel',
      role: 'follower',
      responseTimeoutMs: 50,
    });

    const leaderFn = vi.fn().mockResolvedValue('custom-result');
    const followerFn = vi.fn().mockResolvedValue('fallback');

    await d1.dedupe('key1', leaderFn);
    // d2 is on a different channel, so it should timeout and use fallback
    const result = await d2.dedupe('key1', followerFn);
    expect(result).toBe('fallback');
    expect(followerFn).toHaveBeenCalledTimes(1);

    d1.destroy();
    d2.destroy();
  });
});
