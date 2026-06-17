import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  detectEnvironment,
  isBrowser,
  isServer,
  isEdgeRuntime,
  SSRSafeGuard,
  ssrGuard,
} from './ssr.js';

// In the vitest/Node.js test environment, we're running in Node.

describe('detectEnvironment', () => {
  it('returns "node" in Node.js test environment', () => {
    const env = detectEnvironment();
    // In vitest running on Node, this should be 'node'
    expect(env).toBe('node');
  });

  it('returns a valid SSREnvironment value', () => {
    const valid = ['browser', 'node', 'edge', 'deno', 'bun', 'unknown'];
    expect(valid).toContain(detectEnvironment());
  });
});

describe('isBrowser', () => {
  it('returns false in Node.js test environment', () => {
    expect(isBrowser()).toBe(false);
  });
});

describe('isServer', () => {
  it('returns true in Node.js test environment', () => {
    expect(isServer()).toBe(true);
  });
});

describe('isEdgeRuntime', () => {
  it('returns false in Node.js test environment', () => {
    expect(isEdgeRuntime()).toBe(false);
  });
});

describe('SSRSafeGuard', () => {
  it('detects environment correctly', () => {
    const guard = new SSRSafeGuard();
    expect(guard.environment).toBe('node');
  });

  it('feature detection reflects Node.js environment', () => {
    const guard = new SSRSafeGuard();

    // Node.js doesn't have BroadcastChannel by default (it does in Node 18+ but vitest may not expose it)
    // hasPerformanceAPI should be true in Node 18+
    expect(guard.hasAbortController).toBe(true);
    // These are booleans regardless of value
    expect(typeof guard.hasBroadcastChannel).toBe('boolean');
    expect(typeof guard.hasIndexedDB).toBe('boolean');
    expect(typeof guard.hasPerformanceAPI).toBe('boolean');
    expect(typeof guard.hasCrypto).toBe('boolean');
  });

  it('wrapBrowserOnly returns fallback on server', () => {
    const guard = new SSRSafeGuard();
    const browserFn = (x: number) => x * 2;
    const wrapped = guard.wrapBrowserOnly(browserFn as (...args: unknown[]) => unknown, 'fallback' as unknown);

    // In Node environment (server), should return fallback
    expect(wrapped(5)).toBe('fallback');
  });

  it('wrapBrowserOnly returns undefined when no fallback is provided', () => {
    const guard = new SSRSafeGuard();
    const browserFn = (x: number) => x * 2;
    const wrapped = guard.wrapBrowserOnly(browserFn as (...args: unknown[]) => unknown);

    expect(wrapped(5)).toBeUndefined();
  });

  it('generateId returns a non-empty string', () => {
    const guard = new SSRSafeGuard();
    const id = guard.generateId();

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generateId returns unique values', () => {
    const guard = new SSRSafeGuard();
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(guard.generateId());
    }

    expect(ids.size).toBe(100);
  });

  it('now() returns a number', () => {
    const guard = new SSRSafeGuard();
    const time = guard.now();

    expect(typeof time).toBe('number');
    expect(time).toBeGreaterThan(0);
  });

  it('safeRequestIdleCallback works via setTimeout fallback', () => {
    vi.useFakeTimers();
    const guard = new SSRSafeGuard();
    const fn = vi.fn();

    guard.safeRequestIdleCallback(fn, 100);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('respects option overrides for feature detection', () => {
    const guard = new SSRSafeGuard({
      enableBroadcastChannel: false,
      enableIndexedDB: false,
      enablePerformanceAPI: false,
    });

    expect(guard.hasBroadcastChannel).toBe(false);
    expect(guard.hasIndexedDB).toBe(false);
    expect(guard.hasPerformanceAPI).toBe(false);
  });

  it('fallbackCache defaults to memory', () => {
    const guard = new SSRSafeGuard();
    expect(guard.fallbackCache).toBe('memory');
  });

  it('fallbackCache can be set to none', () => {
    const guard = new SSRSafeGuard({ fallbackCache: 'none' });
    expect(guard.fallbackCache).toBe('none');
  });
});

describe('ssrGuard singleton', () => {
  it('is an instance of SSRSafeGuard', () => {
    expect(ssrGuard).toBeInstanceOf(SSRSafeGuard);
  });

  it('has environment set', () => {
    expect(ssrGuard.environment).toBe('node');
  });

  it('all browser guards correctly reflect Node environment', () => {
    // In Node.js test environment:
    // - hasAbortController should be true (Node 18+)
    expect(ssrGuard.hasAbortController).toBe(true);
    // All other booleans should be valid
    expect(typeof ssrGuard.hasBroadcastChannel).toBe('boolean');
    expect(typeof ssrGuard.hasIndexedDB).toBe('boolean');
    expect(typeof ssrGuard.hasPerformanceAPI).toBe('boolean');
    expect(typeof ssrGuard.hasCrypto).toBe('boolean');
  });
});
