/**
 * SSR (Server-Side Rendering) support for call-latest.
 *
 * Provides environment detection, feature guards, and SSR-safe wrappers
 * that disable browser-only features on the server.
 */

export type SSREnvironment = 'browser' | 'node' | 'edge' | 'deno' | 'bun' | 'unknown';

/**
 * Detect the current runtime environment.
 */
export function detectEnvironment(): SSREnvironment {
  // Deno
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return 'deno';
  }

  // Bun
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) {
    return 'bun';
  }

  // Browser: window + document both available
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>)['window'] !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>)['document'] !== 'undefined'
  ) {
    return 'browser';
  }

  // Edge runtimes (Cloudflare Workers, Vercel Edge, etc.)
  if (
    typeof globalThis !== 'undefined' &&
    (
      'EdgeRuntime' in globalThis ||
      (typeof (globalThis as Record<string, unknown>)['caches'] !== 'undefined' &&
       typeof (globalThis as Record<string, unknown>)['window'] === 'undefined')
    )
  ) {
    return 'edge';
  }

  // Node.js
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined' &&
    typeof ((globalThis as Record<string, unknown>)['process'] as Record<string, unknown>)?.['versions'] !== 'undefined' &&
    typeof (((globalThis as Record<string, unknown>)['process'] as Record<string, unknown>)?.['versions'] as Record<string, unknown>)?.['node'] === 'string'
  ) {
    return 'node';
  }

  return 'unknown';
}

/**
 * Returns true if running in a browser environment.
 */
export function isBrowser(): boolean {
  return detectEnvironment() === 'browser';
}

/**
 * Returns true if running in a server environment (node, deno, bun, or unknown).
 */
export function isServer(): boolean {
  const env = detectEnvironment();
  return env !== 'browser';
}

/**
 * Returns true if running in an edge runtime (Cloudflare Workers, Vercel Edge, etc.).
 */
export function isEdgeRuntime(): boolean {
  return detectEnvironment() === 'edge';
}

// ─── SSR-Safe Guard ──────────────────────────────────────────────────

export type SSRSafeOptions = {
  enableBroadcastChannel?: boolean;
  enableIndexedDB?: boolean;
  enablePerformanceAPI?: boolean;
  fallbackCache?: 'memory' | 'none';
};

/**
 * SSR-safe guard that detects available APIs and provides safe fallbacks.
 */
export class SSRSafeGuard {
  readonly environment: SSREnvironment;
  readonly hasBroadcastChannel: boolean;
  readonly hasIndexedDB: boolean;
  readonly hasPerformanceAPI: boolean;
  readonly hasCrypto: boolean;
  readonly hasAbortController: boolean;

  private readonly _fallbackCache: 'memory' | 'none';

  constructor(options?: SSRSafeOptions) {
    this.environment = detectEnvironment();
    this._fallbackCache = options?.fallbackCache ?? 'memory';

    // Feature detection with option overrides
    this.hasBroadcastChannel = (options?.enableBroadcastChannel ?? true) &&
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['BroadcastChannel'] === 'function';

    this.hasIndexedDB = (options?.enableIndexedDB ?? true) &&
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['indexedDB'] !== 'undefined';

    this.hasPerformanceAPI = (options?.enablePerformanceAPI ?? true) &&
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['performance'] !== 'undefined' &&
      typeof ((globalThis as Record<string, unknown>)['performance'] as Record<string, unknown>)?.['now'] === 'function';

    this.hasCrypto = typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['crypto'] !== 'undefined' &&
      typeof ((globalThis as Record<string, unknown>)['crypto'] as Record<string, unknown>)?.['randomUUID'] === 'function';

    this.hasAbortController = typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['AbortController'] === 'function';
  }

  /**
   * Wrap a function to be SSR-safe. On server environments, returns
   * fallback value instead of calling the function.
   */
  wrapBrowserOnly<T extends (...args: unknown[]) => unknown>(
    fn: T,
    fallback?: ReturnType<T>,
  ): T {
    if (this.environment === 'browser') {
      return fn;
    }
    const fallbackValue = fallback;
    return ((..._args: unknown[]) => fallbackValue) as T;
  }

  /**
   * Safe requestIdleCallback that falls back to setTimeout.
   */
  safeRequestIdleCallback(fn: () => void, timeout?: number): void {
    if (
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as Record<string, unknown>)['requestIdleCallback'] === 'function'
    ) {
      (globalThis as unknown as { requestIdleCallback: (fn: () => void, opts?: { timeout?: number }) => void })
        .requestIdleCallback(fn, timeout !== undefined ? { timeout } : undefined);
    } else {
      setTimeout(fn, timeout ?? 0);
    }
  }

  /**
   * Safe performance.now() that returns a monotonic timestamp.
   * Falls back to Date.now() when Performance API is unavailable.
   */
  now(): number {
    if (this.hasPerformanceAPI) {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Generate a unique ID. Uses crypto.randomUUID() when available,
   * falls back to a timestamp+random based ID.
   */
  generateId(): string {
    if (this.hasCrypto) {
      return crypto.randomUUID();
    }
    // Fallback: timestamp + random hex
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 10);
    return `${ts}-${rand}`;
  }

  /**
   * Get the fallback cache mode.
   */
  get fallbackCache(): 'memory' | 'none' {
    return this._fallbackCache;
  }
}

/**
 * Pre-built SSR guard singleton using default options.
 */
export const ssrGuard: SSRSafeGuard = new SSRSafeGuard();
