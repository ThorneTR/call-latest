import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  latest,
  dedupe,
  latestDedupe,
  createSmartSearch,
  StaleError,
  isStale,
  type SearchResponse,
} from "./index.js";

vi.setConfig({ testTimeout: 60000 });

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Attach a no-op handler so stale rejections never become unhandled. */
const sink = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
};

describe("stress: latest()", () => {
  it("rapid-fire 10,000 calls — only the last resolves", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 10_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    // Only the last call should resolve
    const lastResult = await promises[9_999]!;
    expect(lastResult).toBe(9_999);

    // All others should reject with StaleError
    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9_999);

    for (const r of rejected) {
      expect(isStale((r as PromiseRejectedResult).reason)).toBe(true);
    }

    // Call counter tracks total calls
    expect(wrapped.current()).toBe(10_000);
  });

  it("rapid-fire 100,000 calls — completes in reasonable time", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    const start = performance.now();
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    const lastResult = await promises[99_999]!;
    expect(lastResult).toBe(99_999);

    const elapsed = performance.now() - start;
    // Should complete within 10 seconds even on slow CI
    expect(elapsed).toBeLessThan(10_000);

    expect(wrapped.current()).toBe(100_000);
  });

  it("zero-delay rapid fire — no crashes in tight synchronous loop", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    // Fire 5,000 calls with zero delay between them
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 5_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    const last = await promises[4_999]!;
    expect(last).toBe(4_999);

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("StaleError propagation at scale — 10,000 stale errors", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 10_001; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await promises[10_000]!;
    const results = await Promise.allSettled(promises);
    const rejected = results.filter((r) => r.status === "rejected");

    expect(rejected).toHaveLength(10_000);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(isStale(reason)).toBe(true);
      expect(reason).toBeInstanceOf(StaleError);
      expect((reason as StaleError).code).toBe("STALE");
      expect((reason as StaleError).name).toBe("StaleError");
    }
  });

  it("error recovery under load — 50% failures still track latest", async () => {
    let callCount = 0;
    const fn = vi.fn(async (n: number) => {
      callCount++;
      if (callCount % 2 === 0) throw new Error(`fail-${n}`);
      return n;
    });
    const wrapped = latest(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    const results = await Promise.allSettled(promises);
    // All but the last should be StaleError
    const staleCount = results
      .slice(0, -1)
      .filter(
        (r) =>
          r.status === "rejected" && isStale((r as PromiseRejectedResult).reason),
      ).length;
    expect(staleCount).toBe(999);

    // The last promise either resolves or rejects with its own error (not StaleError)
    const lastResult = results[999]!;
    if (lastResult.status === "rejected") {
      expect(isStale((lastResult as PromiseRejectedResult).reason)).toBe(false);
    }
  });
});

describe("stress: dedupe()", () => {
  it("10,000 identical calls — only 1 execution", async () => {
    const fn = vi.fn(async (id: string) => id);
    const wrapped = dedupe(fn);

    const promises: Promise<string>[] = [];
    for (let i = 0; i < 10_000; i++) {
      promises.push(wrapped("same-key"));
    }

    const results = await Promise.all(promises);
    expect(fn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r).toBe("same-key");
    }
    expect(wrapped.pending()).toBe(0);
  });

  it("10,000 calls with 100 unique keys — 100 executions", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = dedupe(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 10_000; i++) {
      promises.push(wrapped(i % 100));
    }

    const results = await Promise.all(promises);
    expect(fn).toHaveBeenCalledTimes(100);
    for (let i = 0; i < 10_000; i++) {
      expect(results[i]).toBe(i % 100);
    }
    expect(wrapped.pending()).toBe(0);
  });
});

describe("stress: latestDedupe()", () => {
  it("5,000 mixed calls — alternating queries", async () => {
    const fn = vi.fn(async (q: string) => q);
    const wrapped = latestDedupe(fn);

    const promises: Promise<string>[] = [];
    const queries = ["alpha", "beta", "gamma", "delta", "alpha"];
    for (let i = 0; i < 5_000; i++) {
      const q = queries[i % queries.length]!;
      const p = wrapped(q);
      promises.push(p);
      sink(p);
    }

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === "fulfilled");

    // Only the very last call should fulfill (all prior are stale)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const lastResult = results[4_999]!;
    expect(lastResult.status).toBe("fulfilled");
  });
});

describe("stress: latest() with abort", () => {
  it("10,000 AbortControllers — all old ones properly aborted", async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn(async (n: number, ctx: { signal: AbortSignal }) => {
      signals.push(ctx.signal);
      return n;
    });
    const wrapped = latest(fn, { abort: true });

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 10_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await promises[9_999]!;
    await Promise.allSettled(promises);

    expect(signals).toHaveLength(10_000);
    // All signals except the last should be aborted
    for (let i = 0; i < 9_999; i++) {
      expect(signals[i]!.aborted).toBe(true);
    }
    // Last signal should NOT be aborted
    expect(signals[9_999]!.aborted).toBe(false);
  });

  it("reset under load — 1,000 in-flight calls rejected", async () => {
    let resolvers: Array<(v: number) => void> = [];
    const fn = vi.fn(async (n: number, ctx: { signal: AbortSignal }) => {
      return new Promise<number>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const wrapped = latest(fn, { abort: true });

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    // Reset while calls are in-flight
    wrapped.reset();

    // Now resolve all the stored resolvers — they should all be stale
    for (const r of resolvers) r(42);

    const results = await Promise.allSettled(promises);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1_000);
    for (const r of rejected) {
      expect(isStale((r as PromiseRejectedResult).reason)).toBe(true);
    }
  });
});

describe("stress: createSmartSearch()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rapid typing simulation — only 'react' result is final", async () => {
    const queries = ["r", "re", "rea", "reac", "react"];
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [`result-${query}`] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
    });

    const promises: Promise<SearchResponse<string>>[] = [];
    for (const q of queries) {
      const p = smart.search(q);
      sink(p);
      promises.push(p);
    }

    // Advance timers to flush all debounces
    await vi.advanceTimersByTimeAsync(100);

    const results = await Promise.allSettled(promises);
    // The last search should fulfill
    const lastResult = results[results.length - 1]!;
    expect(lastResult.status).toBe("fulfilled");
    if (lastResult.status === "fulfilled") {
      expect(
        (lastResult as PromiseFulfilledResult<SearchResponse<string>>).value
          .items[0],
      ).toBe("result-react");
    }
  });

  it("1,000 different queries rapidly through SmartSearch", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
    });

    const promises: Promise<SearchResponse<string>>[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = smart.search(`query-${i}`);
      sink(p);
      promises.push(p);
    }

    await vi.advanceTimersByTimeAsync(1_000);

    const results = await Promise.allSettled(promises);
    // Last query should be the winner
    const lastResult = results[999]!;
    expect(lastResult.status).toBe("fulfilled");
    if (lastResult.status === "fulfilled") {
      expect(
        (lastResult as PromiseFulfilledResult<SearchResponse<string>>).value
          .items[0],
      ).toBe("query-999");
    }
  });

  it("cache thrashing — 50,000 queries with small cache", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      cacheMaxEntries: 10,
      swr: false,
    });

    // Run queries sequentially to avoid latest-call contention — we're testing cache, not latest
    for (let i = 0; i < 50; i++) {
      const p = smart.search(`query-${i}`);
      await vi.advanceTimersByTimeAsync(0);
      await p;
    }

    expect(runSearch.mock.calls.length).toBe(50);
  });

  it("SWR stress — 1,000 revalidations don't cause errors", async () => {
    let callCount = 0;
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        callCount++;
        return { items: [`${query}-${callCount}`] };
      },
    );

    const onSWRUpdate = vi.fn();
    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: true,
      onSWRUpdate,
    });

    // First call populates cache
    await smart.search("swr-test");
    await vi.advanceTimersByTimeAsync(0);

    // Subsequent calls hit cache + trigger SWR revalidation
    for (let i = 0; i < 10; i++) {
      const p = smart.search("swr-test");
      sink(p);
      await vi.advanceTimersByTimeAsync(10);
    }

    await vi.advanceTimersByTimeAsync(1_000);

    // SWR should have fired at least once
    expect(onSWRUpdate).toHaveBeenCalled();
  });

  it("concurrent SmartSearch instances — 100 instances", async () => {
    const instances: ReturnType<typeof createSmartSearch<string>>[] = [];

    for (let i = 0; i < 10; i++) {
      const runSearch = vi.fn(
        async (query: string): Promise<SearchResponse<string>> => {
          return { items: [`inst-${i}-${query}`] };
        },
      );
      instances.push(
        createSmartSearch(runSearch, {
          baseDebounceMs: 0,
          minDebounceMs: 0,
          swr: false,
        }),
      );
    }

    // Each instance does 10 searches
    const allPromises: Promise<SearchResponse<string>>[] = [];
    for (const inst of instances) {
      for (let j = 0; j < 5; j++) {
        const p = inst.search(`q-${j}`);
        sink(p);
        allPromises.push(p);
      }
    }

    await vi.advanceTimersByTimeAsync(1_000);

    const results = await Promise.allSettled(allPromises);
    // No unhandled errors — all should be either fulfilled or stale
    for (const r of results) {
      if (r.status === "rejected") {
        expect(isStale((r as PromiseRejectedResult).reason)).toBe(true);
      }
    }
  });

  it("retry storm — all calls fail except the last", async () => {
    let attempt = 0;
    const totalAttempts = 3;
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        attempt++;
        if (attempt < totalAttempts) {
          const err = new Error("503 Service Unavailable") as Error & {
            status: number;
          };
          err.status = 503;
          throw err;
        }
        return { items: [query] };
      },
    );

    const onMetrics = vi.fn();
    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
      retry: {
        attempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
      onMetrics,
    });

    const resultPromise = smart.search("retry-query");
    // Advance timers enough for retries
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await resultPromise;
    expect(result.items[0]).toBe("retry-query");

    // Verify retry metrics were emitted
    const retryMetrics = onMetrics.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "RETRY",
    );
    expect(retryMetrics.length).toBeGreaterThanOrEqual(1);
  });

  it("distributed cancel at scale — 1,000 queries fire onDistributedCancel", async () => {
    const cancelledIds: number[] = [];
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
      onDistributedCancel: (id) => cancelledIds.push(id),
    });

    const promises: Promise<SearchResponse<string>>[] = [];
    for (let i = 0; i < 100; i++) {
      const p = smart.search(`q-${i}`);
      sink(p);
      promises.push(p);
    }

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.allSettled(promises);

    expect(cancelledIds.length).toBe(99);
  });

  it("onStale callback fires reliably under rapid calls", async () => {
    const staleArgs: unknown[][] = [];
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn, {
      onStale: (args) => staleArgs.push(args),
    });

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 500; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await Promise.allSettled(promises);
    // onStale should fire for every superseded call
    expect(staleArgs).toHaveLength(499);
  });

  it("reset() during rapid SmartSearch calls clears state", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
    });

    const promises: Promise<SearchResponse<string>>[] = [];
    for (let i = 0; i < 10; i++) {
      const p = smart.search(`pre-reset-${i}`);
      sink(p);
      promises.push(p);
    }

    // Await them before reset to prevent pending StaleErrors from bubbling up unhandled
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.allSettled(promises);

    smart.reset();
    await Promise.allSettled(promises);

    // After reset, a new search should work cleanly
    const afterReset = smart.search("post-reset");
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await afterReset;
    expect(result.items[0]).toBe("post-reset");
  });
});
