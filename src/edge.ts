/**
 * Edge Runtime support for call-latest.
 *
 * Optimized for Cloudflare Workers, Vercel Edge Functions, Deno Deploy,
 * and Fastly Compute@Edge. Includes request handlers, cache adapters,
 * and streaming response builders.
 */

export type EdgeRuntime = 'cloudflare' | 'vercel-edge' | 'deno-deploy' | 'fastly' | 'generic';

/**
 * Detect the current edge runtime, or null if not running in an edge environment.
 */
export function detectEdgeRuntime(): EdgeRuntime | null {
  if (typeof globalThis === 'undefined') return null;

  const g = globalThis as Record<string, unknown>;

  // Cloudflare Workers
  if (typeof g['caches'] !== 'undefined' && typeof g['HTMLRewriter'] === 'function') {
    return 'cloudflare';
  }

  // Vercel Edge
  if (typeof g['EdgeRuntime'] === 'string') {
    return 'vercel-edge';
  }

  // Deno Deploy
  if ('Deno' in globalThis) {
    return 'deno-deploy';
  }

  // Fastly
  if (typeof g['fastly'] !== 'undefined') {
    return 'fastly';
  }

  // Generic edge: has fetch + caches but no window/document
  if (
    typeof g['fetch'] === 'function' &&
    typeof g['caches'] !== 'undefined' &&
    typeof g['window'] === 'undefined'
  ) {
    return 'generic';
  }

  return null;
}

// ─── Edge Search Handler ─────────────────────────────────────────────

export type EdgeSearchHandlerOptions<TItem> = {
  runtime?: EdgeRuntime;
  maxCoalescingWaiters?: number;
  coalescingWindowMs?: number;
  cacheControl?: string;
  corsOrigins?: string | string[];
  onRequest?: (query: string, headers: Record<string, string>) => void;
  onResponse?: (query: string, itemCount: number, durationMs: number) => void;
};

type CoalescingEntry<TItem> = {
  promise: Promise<{ items: TItem[]; version?: string }>;
  waiters: number;
  timestamp: number;
};

/**
 * Create an edge-optimized request handler for search endpoints.
 *
 * Features:
 * - Request coalescing (concurrent same queries share one execution)
 * - CORS support
 * - Cache-Control headers
 * - Stats tracking
 */
export function createEdgeSearchHandler<TItem>(
  searchFn: (query: string, signal: AbortSignal) => Promise<{ items: TItem[]; version?: string }>,
  options?: EdgeSearchHandlerOptions<TItem>,
): {
  handle(request: Request): Promise<Response>;
  handleCancel(request: Request): Promise<Response>;
  stats(): { totalRequests: number; coalescedRequests: number; avgLatencyMs: number };
} {
  const maxWaiters = options?.maxCoalescingWaiters ?? 100;
  const coalescingWindowMs = options?.coalescingWindowMs ?? 50;
  const cacheControl = options?.cacheControl ?? 'no-cache';
  const corsOrigins = options?.corsOrigins;

  // Stats
  let totalRequests = 0;
  let coalescedRequests = 0;
  let totalLatencyMs = 0;

  // Coalescing map
  const inflight = new Map<string, CoalescingEntry<TItem>>();

  function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
    if (!corsOrigins) return {};

    const origins = Array.isArray(corsOrigins) ? corsOrigins : [corsOrigins];

    if (origins.includes('*')) {
      return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
    }

    if (requestOrigin && origins.includes(requestOrigin)) {
      return {
        'Access-Control-Allow-Origin': requestOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      };
    }

    return {};
  }

  function buildHeaders(requestOrigin?: string | null): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      ...getCorsHeaders(requestOrigin),
    };
  }

  async function handle(request: Request): Promise<Response> {
    totalRequests++;
    const startTime = Date.now();

    // Handle OPTIONS for CORS preflight
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin),
      });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';
    const origin = request.headers.get('Origin');

    // Extract headers for callback
    const headerRecord: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    options?.onRequest?.(query, headerRecord);

    try {
      let result: { items: TItem[]; version?: string };

      // Check for coalescing opportunity
      const existing = inflight.get(query);
      if (
        existing &&
        existing.waiters < maxWaiters &&
        (Date.now() - existing.timestamp) < coalescingWindowMs
      ) {
        existing.waiters++;
        coalescedRequests++;
        result = await existing.promise;
      } else {
        // Start new search
        const controller = new AbortController();
        const promise = searchFn(query, controller.signal);
        const entry: CoalescingEntry<TItem> = {
          promise,
          waiters: 1,
          timestamp: Date.now(),
        };
        inflight.set(query, entry);

        try {
          result = await promise;
        } finally {
          inflight.delete(query);
        }
      }

      const durationMs = Date.now() - startTime;
      totalLatencyMs += durationMs;
      options?.onResponse?.(query, result.items.length, durationMs);

      const responseHeaders = buildHeaders(origin);
      if (result.version) {
        responseHeaders['ETag'] = result.version;
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      totalLatencyMs += durationMs;

      const message = err instanceof Error ? err.message : 'Internal server error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: buildHeaders(origin),
      });
    }
  }

  async function handleCancel(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin),
      });
    }

    // Accept cancel notification — in a real system this would abort in-flight work
    try {
      const _body = await request.json();
    } catch {
      // Ignore parse errors
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: buildHeaders(origin),
    });
  }

  function stats() {
    return {
      totalRequests,
      coalescedRequests,
      avgLatencyMs: totalRequests > 0 ? totalLatencyMs / totalRequests : 0,
    };
  }

  return { handle, handleCancel, stats };
}

// ─── Edge Cache Adapter ──────────────────────────────────────────────

/**
 * Edge-specific cache wrapper using the Cache API.
 * Falls back to in-memory Map when Cache API is unavailable.
 */
export class EdgeCacheAdapter<T> {
  private readonly _cacheName: string;
  private readonly _memoryFallback: Map<string, { value: T; expires: number }>;
  private _cacheAvailable: boolean | null = null;

  constructor(cacheName?: string) {
    this._cacheName = cacheName ?? 'call-latest-edge-cache';
    this._memoryFallback = new Map();
  }

  private async _getCache(): Promise<Cache | null> {
    if (this._cacheAvailable === false) return null;

    try {
      if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['caches'] !== 'undefined') {
        const cache = await caches.open(this._cacheName);
        this._cacheAvailable = true;
        return cache;
      }
    } catch {
      // Cache API not available
    }
    this._cacheAvailable = false;
    return null;
  }

  private _cacheKey(key: string): string {
    return `https://cache.local/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<T | null> {
    // Try Cache API first
    const cache = await this._getCache();
    if (cache) {
      const response = await cache.match(this._cacheKey(key));
      if (response) {
        try {
          return (await response.json()) as T;
        } catch {
          return null;
        }
      }
      return null;
    }

    // Memory fallback
    const entry = this._memoryFallback.get(key);
    if (!entry) return null;
    if (entry.expires > 0 && Date.now() > entry.expires) {
      this._memoryFallback.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const cache = await this._getCache();
    if (cache) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        headers['Cache-Control'] = `max-age=${ttlSeconds}`;
      }
      const response = new Response(JSON.stringify(value), { headers });
      await cache.put(this._cacheKey(key), response);
      return;
    }

    // Memory fallback
    const expires = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this._memoryFallback.set(key, { value, expires });
  }

  async delete(key: string): Promise<boolean> {
    const cache = await this._getCache();
    if (cache) {
      return cache.delete(this._cacheKey(key));
    }

    return this._memoryFallback.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const result = await this.get(key);
    return result !== null;
  }
}

// ─── Streaming Edge Response ─────────────────────────────────────────

/**
 * Create a streaming edge response from an async iterable of item batches.
 * Each batch is sent as a newline-delimited JSON chunk.
 */
export function createEdgeStreamResponse<TItem>(
  items: AsyncIterable<TItem[]>,
  options?: { headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const batch of items) {
          const chunk = JSON.stringify(batch) + '\n';
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      ...(options?.headers ?? {}),
    },
  });
}
