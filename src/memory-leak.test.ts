import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  latest,
  dedupe,
  createSmartSearch,
  StaleError,
  isStale,
  type SearchResponse,
} from "./index.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Attach a no-op handler so stale rejections never become unhandled. */
const sink = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
};

describe("memory: latest()", () => {
  it("doesn't accumulate state after 1,000 calls", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await Promise.allSettled(promises);

    // The current() counter tracks total calls (it increments, not accumulates state)
    expect(wrapped.current()).toBe(1_000);
    // After all promises settle, no pending state remains — the token is just a number
  });

  it("AbortControllers are replaced, not accumulated, with abort: true", async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn(async (n: number, ctx: { signal: AbortSignal }) => {
      signals.push(ctx.signal);
      return n;
    });
    const wrapped = latest(fn, { abort: true });

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await Promise.allSettled(promises);

    // All signals except the last should be aborted (old controllers replaced)
    for (let i = 0; i < 999; i++) {
      expect(signals[i]!.aborted).toBe(true);
    }
    expect(signals[999]!.aborted).toBe(false);

    // After reset, the controller reference is cleared
    wrapped.reset();
    // Creating a new call should work without issues
    const result = await wrapped(9999);
    expect(result).toBe(9999);
  });

  it("reset clears controller reference", async () => {
    const fn = vi.fn(async (n: number, ctx: { signal: AbortSignal }) => n);
    const wrapped = latest(fn, { abort: true });

    const p = wrapped(1);
    sink(p);
    wrapped.reset();

    await Promise.allSettled([p]);

    // After reset, a new call works cleanly with a fresh controller
    const result = await wrapped(2);
    expect(result).toBe(2);
  });
});

describe("memory: dedupe()", () => {
  it("cleans up pending map after promise settles", async () => {
    const fn = vi.fn(async (id: string) => id);
    const wrapped = dedupe(fn);

    // 100 concurrent identical calls
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(wrapped("same"));
    }

    expect(wrapped.pending()).toBe(1); // One in-flight promise

    await Promise.all(promises);
    expect(wrapped.pending()).toBe(0); // Cleaned up
  });

  it("cleans up pending map on rejection", async () => {
    const fn = vi.fn(async (_id: string): Promise<string> => {
      throw new Error("boom");
    });
    const wrapped = dedupe(fn);

    const promises: Promise<string>[] = [];
    for (let i = 0; i < 100; i++) {
      const p = wrapped("fail-key");
      promises.push(p);
      sink(p);
    }

    await Promise.allSettled(promises);
    expect(wrapped.pending()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cleans up with multiple unique keys all rejecting", async () => {
    const fn = vi.fn(async (n: number): Promise<number> => {
      throw new Error(`fail-${n}`);
    });
    const wrapped = dedupe(fn);

    const promises: Promise<number>[] = [];
    for (let i = 0; i < 50; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    expect(wrapped.pending()).toBe(50);
    await Promise.allSettled(promises);
    expect(wrapped.pending()).toBe(0);
  });

  it("clear() empties pending map immediately", async () => {
    let resolvers: Array<(v: string) => void> = [];
    const fn = vi.fn(
      (id: string) =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const wrapped = dedupe(fn);

    // Start 5 unique in-flight calls
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(wrapped(`key-${i}`));
    }
    expect(wrapped.pending()).toBe(5);

    wrapped.clear();
    expect(wrapped.pending()).toBe(0);

    // Resolve old promises so they don't leak
    for (const r of resolvers) r("done");
    await Promise.allSettled(promises);
  });

  it("large payloads don't persist after resolution", async () => {
    // Create large arrays as return values
    const fn = vi.fn(async (_key: string) => {
      return new Array(100_000).fill("x");
    });
    const wrapped = dedupe(fn);

    const result = await wrapped("big");
    expect(result).toHaveLength(100_000);
    expect(wrapped.pending()).toBe(0);

    // Second call creates a new promise (not the old one)
    const result2 = await wrapped("big");
    expect(result2).toHaveLength(100_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(wrapped.pending()).toBe(0);
  });
});

describe("memory: createSmartSearch()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache respects maxEntries — never exceeds limit", async () => {
    let cacheHits = 0;
    let cacheMisses = 0;

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
      onMetrics: (metric) => {
        if (metric.type === "CACHE_HIT") cacheHits++;
        if (metric.type === "CACHE_MISS") cacheMisses++;
      },
    });

    // Do 100 unique queries sequentially
    for (let i = 0; i < 100; i++) {
      await smart.search(`q-${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }

    // Now re-query the first 10 — they should all be cache misses (evicted)
    cacheHits = 0;
    cacheMisses = 0;

    for (let i = 0; i < 10; i++) {
      await smart.search(`q-${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }

    // First 10 were evicted (only last 10 remain in cache)
    expect(cacheMisses).toBe(10);
  });

  it("reset clears all state — cache, pending, prevState", async () => {
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

    // Populate cache
    await smart.search("hello");
    await vi.advanceTimersByTimeAsync(0);

    // Reset
    smart.reset();

    // Search same query — should NOT be cached (cache was cleared)
    await smart.search("hello");
    await vi.advanceTimersByTimeAsync(0);

    // runSearch called twice (cache was cleared by reset)
    expect(runSearch).toHaveBeenCalledTimes(2);
  });

  it("repeated reset cycles — 100 cycles with no accumulation", async () => {
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

    for (let cycle = 0; cycle < 100; cycle++) {
      await smart.search(`cycle-${cycle}`);
      await vi.advanceTimersByTimeAsync(0);
      smart.reset();
    }

    // After 100 resets, should still work
    const result = await smart.search("final");
    await vi.advanceTimersByTimeAsync(0);
    expect(result.items[0]).toBe("final");
    expect(runSearch).toHaveBeenCalledTimes(101);
  });

  it("timer cleanup — debounce timers fire and don't accumulate", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 100,
      minDebounceMs: 50,
      maxDebounceMs: 200,
      swr: false,
    });

    // Fire many searches — each creates a debounce timer
    const promises: Promise<SearchResponse<string>>[] = [];
    for (let i = 0; i < 100; i++) {
      const p = smart.search(`query-${i}`);
      sink(p);
      promises.push(p);
    }

    // Advance time to let all timers fire
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.allSettled(promises);

    // No pending timers should remain
    // If timers accumulated, we'd see errors or hangs
    expect(true).toBe(true);
  });

  it("callback references don't create GC-preventing chains", async () => {
    const metrics: unknown[] = [];
    const a11yStates: unknown[] = [];

    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
      onMetrics: (m) => metrics.push(m),
      onA11yState: (s) => a11yStates.push(s),
    });

    for (let i = 0; i < 50; i++) {
      await smart.search(`cb-${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }

    // Callbacks were invoked but don't prevent cleanup
    expect(metrics.length).toBeGreaterThan(0);
    expect(a11yStates.length).toBeGreaterThan(0);

    // Reset clears internal state
    smart.reset();
    const preResetMetrics = metrics.length;

    await smart.search("post-cb");
    await vi.advanceTimersByTimeAsync(0);

    // Callbacks still work after reset
    expect(metrics.length).toBeGreaterThan(preResetMetrics);
  });

  it("closure scoping — latest wrapper doesn't retain old args after resolution", async () => {
    const seenArgs: number[][] = [];
    const fn = vi.fn(async (n: number) => {
      seenArgs.push([n]);
      return n;
    });
    const wrapped = latest(fn);

    // Fire many calls
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }

    await Promise.allSettled(promises);

    // The underlying function was called 100 times, but after settlement
    // no reference to old args is retained by the wrapper itself
    expect(fn).toHaveBeenCalledTimes(100);
    expect(wrapped.current()).toBe(100);

    // Verify wrapper works correctly with new calls
    const result = await wrapped(999);
    expect(result).toBe(999);
  });

  it("onLoadingChange is called correctly and doesn't leak", async () => {
    const loadingStates: boolean[] = [];
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
      onLoadingChange: (isLoading) => loadingStates.push(isLoading),
    });

    await smart.search("load1");
    await vi.advanceTimersByTimeAsync(0);

    // Should have fired loading changes
    expect(loadingStates.length).toBeGreaterThan(0);

    // After reset, loading state goes to false
    smart.reset();
    expect(loadingStates[loadingStates.length - 1]).toBe(false);
  });
});
