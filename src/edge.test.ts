import { describe, expect, it, vi } from 'vitest';
import {
  detectEdgeRuntime,
  createEdgeSearchHandler,
  EdgeCacheAdapter,
  createEdgeStreamResponse,
} from './edge.js';

describe('detectEdgeRuntime', () => {
  it('returns null in Node.js test environment', () => {
    const result = detectEdgeRuntime();
    // Node.js doesn't have edge-specific globals
    expect(result).toBeNull();
  });

  it('returns a valid EdgeRuntime or null', () => {
    const valid = ['cloudflare', 'vercel-edge', 'deno-deploy', 'fastly', 'generic', null];
    expect(valid).toContain(detectEdgeRuntime());
  });
});

describe('createEdgeSearchHandler', () => {
  function createMockSearch() {
    return vi.fn(async (query: string, _signal: AbortSignal) => ({
      items: [{ id: 1, title: `Result for ${query}` }],
      version: 'v1',
    }));
  }

  it('handles GET request with query parameter', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn);

    const request = new Request('https://example.com/search?q=react');
    const response = await handler.handle(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Result for react');
    expect(searchFn).toHaveBeenCalledTimes(1);
  });

  it('handles cancel POST request', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn);

    const request = new Request('https://example.com/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: 1 }),
    });

    const response = await handler.handleCancel(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('includes CORS headers when configured', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn, {
      corsOrigins: '*',
    });

    const request = new Request('https://example.com/search?q=test');
    const response = await handler.handle(request);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('includes specific CORS origin when matching', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn, {
      corsOrigins: ['https://myapp.com'],
    });

    const request = new Request('https://example.com/search?q=test', {
      headers: { Origin: 'https://myapp.com' },
    });

    const response = await handler.handle(request);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://myapp.com');
  });

  it('includes cache-control headers', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn, {
      cacheControl: 'max-age=60',
    });

    const request = new Request('https://example.com/search?q=test');
    const response = await handler.handle(request);

    expect(response.headers.get('Cache-Control')).toBe('max-age=60');
  });

  it('returns 500 on search error', async () => {
    const searchFn = vi.fn(async () => {
      throw new Error('Database connection failed');
    });
    const handler = createEdgeSearchHandler(searchFn);

    const request = new Request('https://example.com/search?q=test');
    const response = await handler.handle(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Database connection failed');
  });

  it('tracks stats', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn);

    const request1 = new Request('https://example.com/search?q=react');
    const request2 = new Request('https://example.com/search?q=vue');

    await handler.handle(request1);
    await handler.handle(request2);

    const s = handler.stats();
    expect(s.totalRequests).toBe(2);
    expect(s.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('calls onRequest and onResponse callbacks', async () => {
    const searchFn = createMockSearch();
    const onRequest = vi.fn();
    const onResponse = vi.fn();

    const handler = createEdgeSearchHandler(searchFn, { onRequest, onResponse });

    const request = new Request('https://example.com/search?q=test');
    await handler.handle(request);

    expect(onRequest).toHaveBeenCalledWith('test', expect.any(Object));
    expect(onResponse).toHaveBeenCalledWith('test', 1, expect.any(Number));
  });

  it('handles OPTIONS preflight request', async () => {
    const searchFn = createMockSearch();
    const handler = createEdgeSearchHandler(searchFn, {
      corsOrigins: '*',
    });

    const request = new Request('https://example.com/search?q=test', {
      method: 'OPTIONS',
    });
    const response = await handler.handle(request);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('coalescing: concurrent same queries share one execution', async () => {
    let callCount = 0;
    const searchFn = vi.fn(async (query: string, _signal: AbortSignal) => {
      callCount++;
      // Small delay to allow coalescing
      await new Promise(resolve => setTimeout(resolve, 10));
      return { items: [{ id: 1, query }] };
    });

    const handler = createEdgeSearchHandler(searchFn, {
      coalescingWindowMs: 100,
    });

    // Fire two concurrent requests for the same query
    const request1 = new Request('https://example.com/search?q=react');
    const request2 = new Request('https://example.com/search?q=react');

    const [response1, response2] = await Promise.all([
      handler.handle(request1),
      handler.handle(request2),
    ]);

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    // Stats should show coalesced requests
    const s = handler.stats();
    expect(s.totalRequests).toBe(2);
    // coalescedRequests should be at least 1 (the second request was coalesced)
    expect(s.coalescedRequests).toBeGreaterThanOrEqual(1);
  });
});

describe('EdgeCacheAdapter (memory fallback)', () => {
  it('get returns null for missing key', async () => {
    const cache = new EdgeCacheAdapter<{ value: string }>();
    expect(await cache.get('missing')).toBeNull();
  });

  it('set and get round-trips correctly', async () => {
    const cache = new EdgeCacheAdapter<{ name: string }>();
    await cache.set('key1', { name: 'test' });

    const result = await cache.get('key1');
    expect(result).toEqual({ name: 'test' });
  });

  it('delete removes entry', async () => {
    const cache = new EdgeCacheAdapter<string>();
    await cache.set('key', 'value');
    expect(await cache.has('key')).toBe(true);

    const deleted = await cache.delete('key');
    expect(deleted).toBe(true);
    expect(await cache.has('key')).toBe(false);
  });

  it('has returns correct boolean', async () => {
    const cache = new EdgeCacheAdapter<number>();
    expect(await cache.has('x')).toBe(false);
    await cache.set('x', 42);
    expect(await cache.has('x')).toBe(true);
  });

  it('TTL expiry works in memory fallback', async () => {
    vi.useFakeTimers();
    const cache = new EdgeCacheAdapter<string>();

    await cache.set('key', 'value', 1); // 1 second TTL
    expect(await cache.get('key')).toBe('value');

    vi.advanceTimersByTime(2000); // Advance past TTL
    expect(await cache.get('key')).toBeNull();

    vi.useRealTimers();
  });
});

describe('createEdgeStreamResponse', () => {
  it('creates a streaming response from async iterable', async () => {
    async function* generateBatches() {
      yield [{ id: 1, name: 'first' }];
      yield [{ id: 2, name: 'second' }, { id: 3, name: 'third' }];
    }

    const response = createEdgeStreamResponse(generateBatches());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');

    const text = await response.text();
    const lines = text.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual([{ id: 1, name: 'first' }]);
    expect(JSON.parse(lines[1])).toEqual([
      { id: 2, name: 'second' },
      { id: 3, name: 'third' },
    ]);
  });

  it('accepts custom headers', async () => {
    async function* gen() {
      yield [1];
    }

    const response = createEdgeStreamResponse(gen(), {
      headers: { 'X-Custom': 'test' },
    });

    expect(response.headers.get('X-Custom')).toBe('test');
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
  });
});
