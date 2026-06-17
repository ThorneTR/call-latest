# call-latest

> **Only the latest async call should win.**

[![npm version](https://img.shields.io/npm/v/call-latest.svg)](https://www.npmjs.com/package/call-latest)
[![bundle size](https://img.shields.io/bundlephobia/minzip/call-latest)](https://bundlephobia.com/package/call-latest)
[![license](https://img.shields.io/npm/l/call-latest.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-passing-brightgreen)](#development)

**Zero dependencies · ~2.5 KB · TypeScript-first · Works everywhere**

`call-latest` now centers around `createSmartSearch` for production search flows. It still exposes low-level helpers (`latest`, `dedupe`, `latestDedupe`) when you want manual control.

```ts
import {
  createFetchSearchAdapter,
  createSmartSearch,
  dispatchCancelSignal,
} from "call-latest";

const runSearch = createFetchSearchAdapter({ endpoint: "/api/search" });

const smart = createSmartSearch(runSearch, {
  enableDelta: true,
  itemId: (x: { id: string }) => x.id,
  onDistributedCancel: (oldCallId) =>
    dispatchCancelSignal("/api/search/cancel", oldCallId),
});

const result = await smart.search("react");
```

---

## The problem

You have seen this bug a hundred times:

1. User types `rea` → fetch starts
2. User types `react` → second fetch starts
3. First response arrives **later** and overwrites fresh results

Debounce delays the request. `useEffect` cleanup is boilerplate. `AbortController` is manual wiring every time.

**`call-latest` drops stale responses automatically.**

---

## Install

```bash
npm install call-latest
```

```bash
yarn add call-latest
```

```bash
pnpm add call-latest
```

```bash
bun add call-latest
```

---

## Usage

### Recommended: `createSmartSearch` controller

Use this as your default integration path. It bundles latest-call safety, aborts,
adaptive debounce, cache, retry, graceful degradation, telemetry, a11y state,
and distributed cancellation hooks.

```ts
import { createSmartSearch, createFetchSearchAdapter } from "call-latest";

const runSearch = createFetchSearchAdapter({ endpoint: "/api/search" });

const smart = createSmartSearch(runSearch, {
  cacheMaxEntries: 50,
  backtrackTtlMs: 300_000,
  swr: true,
  retry: { attempts: 4, baseDelayMs: 250, jitterRatio: 0.3 },
});

const result = await smart.search("iphone");
```

### Low-level APIs

### `latest` — drop stale responses

```ts
import { latest, isStale } from "call-latest";

const search = latest(async (query: string) => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  return res.json();
});

async function onInput(query: string) {
  try {
    const results = await search(query);
    render(results); // always matches the latest query
  } catch (error) {
    if (isStale(error)) return; // older keystroke — ignore silently
    throw error;
  }
}
```

### With `fetch` abort (recommended)

Cancels in-flight network requests when a newer call starts — saves bandwidth and kills races at the source.

```ts
import { latest, isStale, type LatestContext } from "call-latest";

const search = latest(
  async (query: string, { signal }: LatestContext) => {
    const res = await fetch(`/api/search?q=${query}`, { signal });
    return res.json();
  },
  { abort: true },
);
```

### `dedupe` — one request for identical concurrent calls

```ts
import { dedupe } from "call-latest";

const getUser = dedupe(async (id: string) => {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
});

// Three simultaneous clicks → one network request, three awaiters
await Promise.all([getUser("42"), getUser("42"), getUser("42")]);
```

### `latestDedupe` — the search-box combo

Combines both patterns: identical concurrent queries share one request, and slower older responses are dropped when the query changes.

```ts
import { latestDedupe } from "call-latest";

const search = latestDedupe(async (query: string) => {
  const res = await fetch(`/api/search?q=${query}`);
  return res.json();
});
```

### `createSmartSearch` — all advanced behaviors in one controller

Includes:
- Adaptive debounce (typing speed + network quality)
- Graceful degradation (`normal` / `conserve`)
- Distributed cancellation hook (cancel frame to edge/CDN)
- Backtrack cache
- Delta merge support
- Speculative prefetch
- Local-first short-circuit (WASM / SQLite / DuckDB)
- Optional worker offload hook

```ts
import { createSmartSearch } from "call-latest";

const smart = createSmartSearch(
  async (query, prev, ctx) => {
    const res = await fetch(`/api/search?q=${query}`, { signal: ctx.signal });
    return res.json(); // full response OR delta: { add, removeIds, version }
  },
  {
    metrics: () => ({ rttMs: 220, errorRate: 0.01, status503Rate: 0 }),
    onDistributedCancel: (oldId) => sendCancelFrameToEdge(oldId),
    localSearch: (query) => localWasmIndex.search(query), // return null to fallback network
  },
);

const result = await smart.search("iphone");
```

### Fetch adapter (Cancel endpoint + ETag/Delta merge)

```ts
import {
  createFetchSearchAdapter,
  createSmartSearch,
  dispatchCancelSignal,
} from "call-latest";

const endpoint = "/api/search";
const cancelEndpoint = "/api/search/cancel";

const runSearch = createFetchSearchAdapter({
  endpoint,
});

const smart = createSmartSearch(runSearch, {
  enableDelta: true,
  itemId: (x: { id: string }) => x.id,
  cacheMaxEntries: 50,      // LRU
  backtrackTtlMs: 300_000,  // TTL: 5 min
  swr: true,
  retry: { attempts: 4, baseDelayMs: 250, jitterRatio: 0.3 }, // exp backoff + jitter
  onDistributedCancel: (oldCallId) => {
    dispatchCancelSignal(cancelEndpoint, oldCallId);
  },
  onMetrics: (m) => console.log(m),
  onA11yState: (s) => announceToAriaLive(s.message),
});
```

Server can return either full response:

```json
{ "items": [{ "id": "1", "title": "iphone" }], "version": "etag-v5" }
```

Or delta response:

```json
{ "add": [{ "id": "2", "title": "iphone 16" }], "removeIds": ["9"], "version": "etag-v6" }
```

### Cloudflare Worker Example

The `examples/cloudflare-worker.ts` file in this repository demonstrates two endpoints:

- `GET /api/search` → Search endpoint returning ETag + versioned results
- `POST /api/search/cancel` → Cancellation endpoint triggered by `dispatchCancelSignal`

By binding this to your Worker within `wrangler.toml`, you can run your client-side `call-latest` requests with a true edge-level cancellation + delta architecture.

---

## Advanced Modules

### Streaming Search — `createStreamingSearch`

Progressive rendering: instead of waiting for all results, stream them as they arrive.
Supports `AsyncIterable`, `ReadableStream`, and `Promise<TItem[]>` sources.
Latest-call safety is built in — starting a new stream automatically cancels the previous one.

```ts
import { createStreamingSearch } from "call-latest/streaming";

const streamer = createStreamingSearch(
  async function* (query, signal) {
    const res = await fetch(`/api/search/stream?q=${query}`, { signal });
    const reader = res.body!.getReader();
    // yield batches as they arrive from the server
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield JSON.parse(new TextDecoder().decode(value));
    }
  },
  { batchSize: 5, batchIntervalMs: 50 },
);

// Only the latest stream lives — previous is auto-cancelled
for await (const partial of streamer.searchStream("react")) {
  render(partial.items);          // renders incrementally
  if (partial.isComplete) break;
}

streamer.cancel();          // abort current stream manually
streamer.isStreaming();     // boolean
```

Convert any flat array into a streaming response for consistent progressive rendering:

```ts
import { toStreamingResponse } from "call-latest/streaming";

for await (const partial of toStreamingResponse(allItems, { batchSize: 10 })) {
  render(partial.items);
}
```

---

### Priority Search — `PrioritySearchManager`

Assign priority levels (0–10) to queries. Higher-priority queries survive aggressive
cancellation and skip the request budget. Lower-priority intermediate queries get
preempted when something more important arrives within 500 ms.

```ts
import { PrioritySearchManager } from "call-latest/priority";

const mgr = new PrioritySearchManager({
  defaultPriority: 5,
  budgetBypassThreshold: 8,   // priority ≥ 8 skips budget
  maxConcurrentHighPriority: 3,
});

// Low-priority intermediate query
const { proceed: p1 } = mgr.evaluate("re", 3);
// p1 === true (nothing else pending)

// Higher-priority query preempts it
const { proceed: p2, context } = mgr.evaluate("react", 9);
// p2 === true, context.shouldBypassBudget === true

mgr.isLatest(callId);         // check if a callId is still current
mgr.preempt(callId, 10);      // forcefully take over with a new priority
mgr.currentPending();         // { query, priority, callId } | null
mgr.stats();                  // { totalEvaluated, totalPreempted, totalBypassed }
mgr.reset();
```

---

### Request Budget — `RequestBudgetManager`

Google-style sliding-window token bucket. Adapts to network quality automatically:
poor network → fewer tokens, excellent network → full budget.
Drops intermediate queries (short/partial) aggressively when budget is low.

```ts
import { RequestBudgetManager } from "call-latest/request-budget";

const budget = new RequestBudgetManager({
  maxRequestsPerWindow: 10,
  windowMs: 2000,
  minIntervalMs: 100,
  networkQualityFn: () => navigator.connection?.effectiveType === "4g" ? "excellent" : "fair",
  aggressiveDropThreshold: 0.5,
  onDrop: (query, reason) => console.warn("dropped", query, reason),
  onBudgetExhausted: () => showThrottleWarning(),
});

function onKeyStroke(query: string) {
  if (!budget.canSend(query)) return; // drop intermediate query
  budget.recordSent();
  sendSearch(query);
}

budget.remainingBudget();   // tokens left in current window
budget.isExhausted();       // boolean
budget.stats();             // { sent, dropped, remaining, dropRate, currentNetworkQuality }
budget.adjustForNetwork();  // re-evaluate quality now
budget.reset();
```

Network quality scaling:

| Quality   | Budget scale |
|-----------|-------------|
| excellent | 100%        |
| good      | 80%         |
| fair      | 50%         |
| poor      | 25%         |
| offline   | 0% (blocked)|

---

### Distributed Deduplication — `DistributedDeduplicator` / `EdgeCoalescer`

Edge-level request coalescing: when 10,000 users simultaneously search the same
query, only one backend request is made. All 10,000 get the result.

**Client-side** (per-process, with configurable coalescing window):

```ts
import { DistributedDeduplicator } from "call-latest/distributed-dedupe";

const deduper = new DistributedDeduplicator({
  coalescingWindowMs: 100,     // requests within 100ms share one promise
  maxWaiters: 10_000,          // safety cap
  hashFn: (key) => key.trim().toLowerCase(),
  onCoalesced: (key, count) => console.log(`${count} waiters for "${key}"`),
});

const result = await deduper.dedupe("iphone", () => fetch("/api/search?q=iphone").then(r => r.json()));

deduper.pending();  // in-flight key count
deduper.stats();    // { totalRequests, coalescedRequests, uniqueRequests, avgWaitersPerKey }
deduper.reset();
```

**Edge/Worker-side** (no timestamp tracking, lighter-weight):

```ts
import { EdgeCoalescer } from "call-latest/distributed-dedupe";

const coalescer = new EdgeCoalescer({ maxWaiters: 10_000 });

export async function handleRequest(req: Request) {
  const query = new URL(req.url).searchParams.get("q") ?? "";
  return coalescer.handle(query, () => runSearch(query));
}

coalescer.activeKeys();   // currently in-flight query keys
coalescer.stats();
```

---

### Multi-Level Cache — `MultiLevelCache`

L1 RAM → L2 IndexedDB → L3 Edge → L4 API. Tries layers in order.
Reads promote results back to faster layers. Writes fan out to all layers (write-through)
or only the fastest layer (write-back).

```ts
import {
  MultiLevelCache,
  MemoryCacheLayer,
  IndexedDBCacheLayer,
  EdgeCacheLayer,
} from "call-latest/multi-level-cache";

const cache = new MultiLevelCache(
  [
    new MemoryCacheLayer({ maxEntries: 500, ttlMs: 60_000 }),
    new IndexedDBCacheLayer({ dbName: "search-cache", maxEntries: 5_000, ttlMs: 300_000 }),
    new EdgeCacheLayer({ endpoint: "https://edge.example.com/cache", ttlMs: 600_000 }),
  ],
  {
    writePolicy: "write-through",       // or "write-back"
    promotionPolicy: "promote-on-read", // or "no-promote"
    onLayerHit: (layer, key) => console.log(`hit on ${layer}`),
    onLayerMiss: (layer, key) => console.log(`miss on ${layer}`),
  },
);

const hit = await cache.get("react");
// hit → { value, layer: "memory", level: 1, latencyMs: 0.1 } | null

await cache.set("react", results, 60_000);   // write-through to all layers
await cache.invalidate("react");             // delete from all layers
await cache.clear();

cache.stats();
// { layerStats: [{ name: "memory", hits: 42, misses: 3 }, ...] }
```

---

### Persistent Cache — `PersistentCache`

LRU + TTL cache backed by memory or IndexedDB. Tracks access frequency and
automatically evicts least-recently-used entries when the size limit is reached.
Falls back to memory when IndexedDB is unavailable (SSR, Node.js).

```ts
import { PersistentCache } from "call-latest/persistent-cache";

const cache = new PersistentCache({
  storage: "indexeddb",              // or "memory"
  dbName: "call-latest-cache",
  storeName: "search-cache",
  maxEntries: 1000,
  ttlMs: 5 * 60 * 1000,             // 5 min TTL
});

await cache.set("react", results);
const value = await cache.get("react");   // null if expired or missing
await cache.has("react");
await cache.delete("react");
await cache.prune();                      // remove all expired entries
await cache.size();

const stats = await cache.stats();
// { hits, misses, evictions, size }
```

---

### Cross-Tab Deduplication — `CrossTabDeduplicator`

When the same user opens the same search in three browser tabs, only one
network request goes out. Results are broadcast via `BroadcastChannel`.
Falls back gracefully when `BroadcastChannel` is unavailable (SSR, Node.js).

```ts
import { CrossTabDeduplicator } from "call-latest/cross-tab";

const crossTab = new CrossTabDeduplicator({
  channelName: "search-channel",
  responseTimeoutMs: 2000,   // fall back to local fetch after 2s
  role: "auto",              // "auto" | "leader" | "follower"
});

// All tabs calling this simultaneously share one network request
const result = await crossTab.dedupe("iphone", () =>
  fetch("/api/search?q=iphone").then(r => r.json()),
);

crossTab.activeCount();  // in-flight + pending requests
crossTab.stats();        // { served, received, timeouts }
crossTab.destroy();      // cleanup channel + pending requests
```

Roles:

| Role       | Behavior |
|------------|----------|
| `auto`     | Negotiates with other tabs; self-claims if no one responds within 50 ms |
| `leader`   | Always fetches and broadcasts — never waits for another tab |
| `follower` | Always waits for another tab; falls back to local on timeout |

---

### OpenTelemetry Telemetry — `CallLatestTelemetry`

Pluggable observability. Works with OpenTelemetry, Datadog, Grafana, or any
custom backend. Tracks latency (p50/p95/p99), cache hit rate, stale count,
abort count, retry count, and stream batch metrics.

```ts
import {
  CallLatestTelemetry,
  ConsoleTelemetryProvider,
  NoopTelemetryProvider,
} from "call-latest/telemetry";

const telemetry = new CallLatestTelemetry({
  provider: new ConsoleTelemetryProvider(),  // or NoopTelemetryProvider
  prefix: "my_app",
  enableLatencyTracking: true,
  enableCacheTracking: true,
  enableErrorTracking: true,
  sampleRate: 0.1,                          // sample 10% of operations
  customLabels: { service: "search" },
});

// Hook into your search pipeline:
const span = telemetry.onSearchStart("react");
telemetry.onCacheHit("react", "memory");
telemetry.onCacheMiss("react");
telemetry.onSearchEnd("react", 42, false);
telemetry.onAbort("react", callId);
telemetry.onStale("react", callId);
telemetry.onError("react", err);
telemetry.onRetry("react", attempt, delayMs);
telemetry.onStreamBatch("react", batchIndex, itemCount);
span.end({ result_count: 12 });

const stats = telemetry.getStats();
// { totalSearches, avgLatencyMs, p50LatencyMs, p95LatencyMs, p99LatencyMs,
//   cacheHitRate, staleCount, abortCount, errorCount, totalCacheHits, totalCacheMisses }

telemetry.getLatencyPercentile(99);  // compute any percentile
telemetry.reset();
```

**Bring your own OpenTelemetry provider:**

```ts
import { trace } from "@opentelemetry/api";
import type { TelemetryProvider, TelemetrySpan } from "call-latest/telemetry";

class OtelProvider implements TelemetryProvider {
  startSpan(name, attrs) {
    const span = trace.getTracer("search").startSpan(name, { attributes: attrs });
    return {
      end: (a) => span.end(),
      setStatus: (s, m) => span.setStatus({ code: s === "ok" ? 1 : 2, message: m }),
      addEvent: (n, a) => span.addEvent(n, a),
    };
  }
  recordMetric(name, value, type, labels) { /* send to Datadog/Prometheus */ }
  async flush() {}
}

const telemetry = new CallLatestTelemetry({ provider: new OtelProvider() });
```

---

### SSR / Universal Rendering — `SSRSafeGuard`

Detect the current runtime and safely wrap browser-only APIs so the same code
works in Node.js, Deno, Bun, Cloudflare Workers, and the browser.

```ts
import {
  detectEnvironment,
  isBrowser,
  isServer,
  isEdgeRuntime,
  SSRSafeGuard,
  ssrGuard,          // pre-built singleton
} from "call-latest/ssr";

detectEnvironment();
// "browser" | "node" | "edge" | "deno" | "bun" | "unknown"

isBrowser();        // true only in window + document environment
isServer();         // true for node / deno / bun / edge
isEdgeRuntime();    // true for Cloudflare Workers, Vercel Edge, etc.

// Feature detection:
ssrGuard.hasBroadcastChannel   // false on Node
ssrGuard.hasIndexedDB          // false on Node
ssrGuard.hasPerformanceAPI
ssrGuard.hasCrypto
ssrGuard.hasAbortController

// Safe wrappers:
ssrGuard.now();             // performance.now() or Date.now()
ssrGuard.generateId();      // crypto.randomUUID() or timestamp-based
ssrGuard.safeRequestIdleCallback(fn, timeout); // falls back to setTimeout
ssrGuard.wrapBrowserOnly(fn, fallback);        // no-op on server
```

Custom guard with option overrides:

```ts
const guard = new SSRSafeGuard({
  enableBroadcastChannel: false,  // force-disable even in browsers
  enableIndexedDB: true,
  enablePerformanceAPI: true,
  fallbackCache: "memory",
});
```

---

### Edge Runtime Support — `createEdgeSearchHandler`

Optimized handlers for **Cloudflare Workers**, **Vercel Edge Functions**,
**Deno Deploy**, and **Fastly Compute@Edge**. Includes request coalescing,
CORS, `Cache-Control`, and NDJSON streaming.

```ts
import {
  detectEdgeRuntime,
  createEdgeSearchHandler,
  EdgeCacheAdapter,
  createEdgeStreamResponse,
} from "call-latest/edge";

detectEdgeRuntime();
// "cloudflare" | "vercel-edge" | "deno-deploy" | "fastly" | "generic" | null

// ── Edge Search Handler ──────────────────────────────────────────────
const handler = createEdgeSearchHandler(
  async (query, signal) => {
    const results = await myIndex.search(query);
    return { items: results, version: "etag-abc" };
  },
  {
    maxCoalescingWaiters: 100,
    coalescingWindowMs: 50,
    cacheControl: "public, max-age=10",
    corsOrigins: ["https://myapp.com"],
    onRequest: (query, headers) => logRequest(query),
    onResponse: (query, count, ms) => logResponse(query, count, ms),
  },
);

// Cloudflare / Vercel Edge entrypoint
export default {
  fetch: async (req: Request) => handler.handle(req),
};

handler.stats();
// { totalRequests, coalescedRequests, avgLatencyMs }
```

**Edge Cache Adapter** (uses Cache API when available, memory fallback otherwise):

```ts
const edgeCache = new EdgeCacheAdapter("my-cache");
await edgeCache.set("react", results, 60); // 60-second TTL
const cached = await edgeCache.get("react");
await edgeCache.delete("react");
```

**NDJSON streaming response** (for streaming search results from edge to browser):

```ts
async function* generateResults(query: string) {
  yield [{ id: 1, title: "React" }];
  yield [{ id: 2, title: "React Native" }];
}

const response = createEdgeStreamResponse(generateResults("react"), {
  headers: { "Cache-Control": "no-store" },
});
// Content-Type: application/x-ndjson, Transfer-Encoding: chunked
```

---

## API reference

### `latest(fn, options?)`

Wraps an async function. Only the latest call can settle.

| Option | Default | Description |
|--------|---------|-------------|
| `abort` | `false` | Append `{ signal, callId }` as last arg; abort previous work |
| `onStale` | — | Callback when a call is superseded |

**Methods on the wrapped function:**

| Method | Description |
|--------|-------------|
| `reset()` | Invalidate all in-flight calls |
| `current()` | Number of calls made (0 before first call) |

---

### `dedupe(fn, options?)`

Coalesces concurrent calls with the same key into one shared promise.

| Option | Default | Description |
|--------|---------|-------------|
| `key` | `JSON.stringify(args)` | Cache key; return `null` to skip deduplication |

**Methods:** `pending()` · `clear()`

---

### `latestDedupe(fn, options?)`

`latest(dedupe(fn))` — best for autocomplete and search UIs.

---

### `isStale(error)`

Returns `true` if the error means the call was superseded. Safe across bundle boundaries.

```ts
import { isStale, StaleError } from "call-latest";

isStale(new StaleError()); // true
isStale({ code: "STALE" }); // true
```

---

### `createSmartSearch(runSearch, options?)` — Full Options Reference

```ts
const smart = createSmartSearch(runSearch, {
  // ── Debounce ────────────────────────────────────────────────
  minDebounceMs: 50,            // floor for adaptive debounce
  maxDebounceMs: 400,           // ceiling for adaptive debounce
  baseDebounceMs: 150,          // starting point / fixed mode value
  debounceMode: "adaptive",     // "fixed" | "adaptive"

  // ── Cache ───────────────────────────────────────────────────
  enableBacktrackCache: true,   // in-memory LRU cache for repeated queries
  cacheMaxEntries: 50,          // LRU eviction threshold
  backtrackTtlMs: 300_000,      // 5 min TTL per cached entry
  swr: true,                    // serve stale immediately, refresh in background
  onSWRUpdate: (query, result) => setResults(result.items),

  // ── Delta Protocol ─────────────────────────────────────────
  enableDelta: true,            // accept { add, removeIds, version } from server
  itemId: (item) => item.id,    // required when enableDelta is true

  // ── Local-First ─────────────────────────────────────────────
  localSearch: async (query) => {
    const hits = wasmIndex.search(query);
    return hits.length ? { items: hits } : null; // null = fall through to network
  },

  // ── Speculative Prefetch ────────────────────────────────────
  enableSpeculativePrefetch: true,
  predictNextQueries: (q) => [q + "s", q.slice(0, -1)],  // predict likely completions
  prefetch: async (query) => { /* fire-and-forget warmup */ },

  // ── Retry ───────────────────────────────────────────────────
  retry: {
    attempts: 4,                // total attempts (including first)
    baseDelayMs: 250,           // initial retry delay
    maxDelayMs: 5_000,          // backoff cap
    jitterRatio: 0.3,           // ±30% randomization
    shouldRetry: (err) => isNetworkError(err), // custom retry predicate
  },

  // ── Graceful Degradation ────────────────────────────────────
  metrics: () => ({
    rttMs: 220,          // measured round-trip time
    errorRate: 0.01,     // recent error fraction
    status503Rate: 0,    // recent server-overload fraction
  }),
  onModeChange: (mode) => console.log("mode →", mode), // "normal" | "conserve"

  // ── Distributed Cancellation ────────────────────────────────
  onDistributedCancel: (supersededCallId) =>
    dispatchCancelSignal("/api/search/cancel", supersededCallId),

  // ── Worker Offload ──────────────────────────────────────────
  offload: async ({ query, callId, items }) => rerank(items), // heavy scoring in Worker

  // ── Observability ───────────────────────────────────────────
  onMetrics: (metric) => sendToDatadog(metric),
  onA11yState: (state) => ariaLive.textContent = state.message,
  onLoadingChange: (isLoading) => setSpinner(isLoading),
  debug: true,   // or debug: (event, payload) => myLogger(event, payload)
});

// Controller methods
await smart.search("query");   // resolves with { items, version? }
smart.currentDebounce();       // current adaptive debounce window (ms)
smart.mode();                  // "normal" | "conserve"
smart.reset();                 // clear state, invalidate in-flight calls
```

**`SearchMetric` union** (emitted via `onMetrics`):

| type | Fields |
|------|--------|
| `CACHE_HIT` | `query`, `durationMs` |
| `CACHE_MISS` | `query`, `durationMs` |
| `NETWORK_OK` | `query`, `durationMs`, `callId` |
| `NETWORK_ERROR` | `query`, `durationMs`, `callId`, `message` |
| `RETRY` | `query`, `attempt`, `waitMs` |
| `SWR_REVALIDATED` | `query`, `durationMs` |
| `WORKER_TIME` | `query`, `durationMs` |
| `DELTA_MERGE` | `query`, `addCount`, `removeCount` |

**`A11yState` union** (emitted via `onA11yState`):

| type | Fields |
|------|--------|
| `loading` | `message` |
| `results` | `message`, `count` |
| `empty` | `message` |
| `error` | `message` |

---

## Framework examples

### React

```tsx
import { useState } from "react";
import { latest, isStale } from "call-latest";

const searchUsers = latest(async (q: string) => {
  const res = await fetch(`/api/users?q=${q}`);
  return res.json();
});

export function UserSearch() {
  const [results, setResults] = useState([]);

  return (
    <input
      placeholder="Search users…"
      onChange={async (e) => {
        try {
          setResults(await searchUsers(e.target.value));
        } catch (err) {
          if (!isStale(err)) throw err;
        }
      }}
    />
  );
}
```

**React adapter** (`createReactAdapter`) — `useSyncExternalStore`-compatible state machine:

```ts
import { createReactAdapter } from "call-latest/adapters/react";
import { useSyncExternalStore } from "react";

const adapter = createReactAdapter(async (query, signal) => {
  const res = await fetch(`/api/search?q=${query}`, { signal });
  return res.json();
});

function useSearch(options = {}) {
  const store = adapter.createSearchState({
    debounceMs: 150,
    minQueryLength: 2,
    onError: console.error,
  });

  const state = useSyncExternalStore(store.subscribe, store.getState);
  // state: { results, isLoading, error, query, isStale, latencyMs, search, reset }

  useEffect(() => () => store.destroy(), []);
  return state;
}
```

### Vue 3

```ts
import { ref } from "vue";
import { latest, isStale } from "call-latest";

const search = latest(async (q: string) => {
  const res = await fetch(`/api/search?q=${q}`);
  return res.json();
});

const results = ref([]);
const query = ref("");

async function onInput(value: string) {
  query.value = value;
  try {
    results.value = await search(value);
  } catch (err) {
    if (!isStale(err)) throw err;
  }
}
```

**Vue adapter** (`createVueAdapter`) — composable-ready state machine:

```ts
import { createVueAdapter } from "call-latest/adapters/vue";
import { reactive, watchEffect } from "vue";

const adapter = createVueAdapter(async (query, signal) => {
  const res = await fetch(`/api/search?q=${query}`, { signal });
  return res.json();
});

export function useSearch() {
  const store = adapter.createSearchState({ debounceMs: 150 });
  const state = reactive(store.getState());
  store.subscribe(() => Object.assign(state, store.getState()));
  onUnmounted(() => store.destroy());
  return { state, search: store.search, reset: store.reset };
}
```

### Svelte

**Svelte adapter** (`createSvelteAdapter`) — matches Svelte's store contract:

```ts
import { createSvelteAdapter } from "call-latest/adapters/svelte";

const adapter = createSvelteAdapter(async (query, signal) => {
  const res = await fetch(`/api/search?q=${query}`, { signal });
  return res.json();
});

const store = adapter.createSearchStore({ debounceMs: 150, minQueryLength: 2 });
// store.subscribe(state => ...)  — receives full state on every change
// store.search("query")
// store.reset()
// store.destroy()
```

```svelte
<script>
  import { createSvelteAdapter } from "call-latest/adapters/svelte";

  const adapter = createSvelteAdapter(async (q, signal) => {
    const res = await fetch(`/api/search?q=${q}`, { signal });
    return res.json();
  });

  const store = adapter.createSearchStore({ debounceMs: 150 });
  let state = { results: [], isLoading: false, error: null, query: "" };
  store.subscribe(s => (state = s));
</script>

<input on:input={e => store.search(e.target.value)} placeholder="Search…" />
{#if state.isLoading}<span>Loading…</span>{/if}
{#each state.results as item}<div>{item.title}</div>{/each}
```

### Solid.js

**Solid adapter** (`createSolidAdapter`) — signal-compatible state machine:

```ts
import { createSolidAdapter } from "call-latest/adapters/solid";
import { createSignal, onCleanup } from "solid-js";

const adapter = createSolidAdapter(async (query, signal) => {
  const res = await fetch(`/api/search?q=${query}`, { signal });
  return res.json();
});

export function SearchBox() {
  const store = adapter.createSearchSignal({ debounceMs: 150 });
  const [state, setState] = createSignal(store.getState());
  store.subscribe(() => setState(store.getState()));
  onCleanup(() => store.destroy());

  return (
    <div>
      <input onInput={e => store.search(e.currentTarget.value)} />
      <For each={state().results}>{item => <div>{item.title}</div>}</For>
    </div>
  );
}
```

### Node.js

```ts
import { latest } from "call-latest";

const loadConfig = latest(async (env: string) => {
  const res = await fetch(`https://config.example.com/${env}`);
  return res.json();
});

// Rapid env switches — only the last config is applied
loadConfig("staging");
loadConfig("production");
```

---

## Why not debounce?

| | debounce | call-latest |
|---|----------|-------------|
| Delays execution | ✅ waits N ms | ❌ runs immediately |
| Drops stale **responses** | ❌ | ✅ |
| Framework-agnostic | awkward | ✅ |
| Cancels `fetch` | manual | built-in (`abort: true`) |
| Size | varies | ~2.5 KB, zero deps |

Debounce **delays when work starts**. `call-latest` lets work run in parallel but **only the latest result counts**. Use both together if you need both behaviors.

---

## When to use

| Scenario | Function |
|----------|----------|
| Search / autocomplete | `latest` or `latestDedupe` |
| Tab or route switching | `latest` with `{ abort: true }` |
| Double-click / spam submit | `dedupe` |
| Typeahead with network dedup | `latestDedupe` |
| Pagination "next page" spam | `latest` |
| Unmount / reset component | `.reset()` |
| Full production search | `createSmartSearch` |
| Progressive rendering | `createStreamingSearch` |
| Priority-based query queue | `PrioritySearchManager` |
| Network-aware rate limiting | `RequestBudgetManager` |
| Edge-level coalescing | `DistributedDeduplicator` / `EdgeCoalescer` |
| Multi-tier caching | `MultiLevelCache` |
| Persistent cache (IndexedDB) | `PersistentCache` |
| Cross-tab deduplication | `CrossTabDeduplicator` |
| Metrics / tracing | `CallLatestTelemetry` |
| SSR / universal rendering | `SSRSafeGuard` / `detectEnvironment` |
| Cloudflare / Vercel Edge | `createEdgeSearchHandler` |

---

## Development

```bash
git clone https://github.com/YOUR_USERNAME/call-latest.git
cd call-latest
npm install
npm test        # run tests
npm run build   # build dist/
```

---

## Migration guide

If you previously used low-level `latest(...)` directly for search input flows,
prefer moving to `createSmartSearch(...).search(query)` as the primary entrypoint.

```ts
// before
const search = latest(fn);
await search(query);

// after
const smart = createSmartSearch(runSearch, options);
await smart.search(query);
```

Low-level APIs are still available for specialized/custom control paths.

---

## Debugging integration

For quick integration debugging, enable either:

- `debug: true` (logs internal events via `console.debug`)
- `onMetrics: (metric) => { ... }` (structured telemetry stream)

```ts
const smart = createSmartSearch(runSearch, {
  debug: true,
  onMetrics: (m) => console.log("metric", m),
});
```

This helps you see debounce decisions, retries, cache hits/misses, SWR refreshes,
and mode transitions while wiring the feature.

---

## License

[MIT](./LICENSE) © 2026

---

<p align="center">
  <sub>Built for every developer who has debugged a stale fetch at 2 AM.</sub>
</p>
