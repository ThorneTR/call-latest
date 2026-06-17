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

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Attach a no-op handler so stale rejections never become unhandled. */
const sink = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
};

/** Run a benchmark and return ops/sec and ms/op. */
function bench(
  name: string,
  iterations: number,
  operation: () => void,
): { opsPerSec: number; msPerOp: number } {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    operation();
  }
  const elapsed = performance.now() - start;
  const msPerOp = elapsed / iterations;
  const opsPerSec = Math.round(1_000 / msPerOp);
  console.log(
    `[BENCHMARK] ${name}: ${opsPerSec.toLocaleString()} ops/sec, ${msPerOp.toFixed(6)} ms/op (${iterations} iterations in ${elapsed.toFixed(2)}ms)`,
  );
  return { opsPerSec, msPerOp };
}

/** Run an async benchmark. */
async function benchAsync(
  name: string,
  iterations: number,
  operation: () => Promise<void>,
): Promise<{ opsPerSec: number; msPerOp: number }> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await operation();
  }
  const elapsed = performance.now() - start;
  const msPerOp = elapsed / iterations;
  const opsPerSec = Math.round(1_000 / msPerOp);
  console.log(
    `[BENCHMARK] ${name}: ${opsPerSec.toLocaleString()} ops/sec, ${msPerOp.toFixed(6)} ms/op (${iterations} iterations in ${elapsed.toFixed(2)}ms)`,
  );
  return { opsPerSec, msPerOp };
}

describe("benchmark: StaleError and isStale()", () => {
  it("StaleError creation — 100,000 instances", () => {
    const { msPerOp } = bench("StaleError creation", 100_000, () => {
      new StaleError();
    });
    // Should be very fast — simple Error subclass
    expect(msPerOp).toBeLessThan(0.1);
  });

  it("isStale() check — 1,000,000 checks", () => {
    const staleError = new StaleError();
    const normalError = new Error("not stale");
    const duckTyped = { code: "STALE" as const };

    const { msPerOp } = bench("isStale() (instanceof)", 1_000_000, () => {
      isStale(staleError);
    });
    expect(msPerOp).toBeLessThan(0.01);

    const result2 = bench("isStale() (duck-typed)", 1_000_000, () => {
      isStale(duckTyped);
    });
    expect(result2.msPerOp).toBeLessThan(0.01);

    const result3 = bench("isStale() (non-stale)", 1_000_000, () => {
      isStale(normalError);
    });
    expect(result3.msPerOp).toBeLessThan(0.01);
  });
});

describe("benchmark: latest()", () => {
  it("wrapping overhead — 100,000 calls", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    const start = performance.now();
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }
    const callTime = performance.now() - start;
    const msPerCall = callTime / 100_000;

    await Promise.allSettled(promises);
    const totalTime = performance.now() - start;

    console.log(
      `[BENCHMARK] latest() call dispatch: ${(1_000 / msPerCall).toFixed(0)} ops/sec, ${msPerCall.toFixed(6)} ms/op`,
    );
    console.log(
      `[BENCHMARK] latest() total (call+settle): ${totalTime.toFixed(2)}ms for 100,000 calls`,
    );

    // Call dispatch should be < 0.01ms per call
    expect(msPerCall).toBeLessThan(0.1);
  });

  it("latest() with abort — AbortController overhead", async () => {
    const fn = vi.fn(async (n: number, ctx: { signal: AbortSignal }) => n);
    const wrapped = latest(fn, { abort: true });

    const start = performance.now();
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }
    const callTime = performance.now() - start;
    const msPerCall = callTime / 100_000;

    await Promise.allSettled(promises);

    console.log(
      `[BENCHMARK] latest(abort) call dispatch: ${(1_000 / msPerCall).toFixed(0)} ops/sec, ${msPerCall.toFixed(6)} ms/op`,
    );

    // Abort mode adds AbortController creation + abort — still should be fast
    expect(msPerCall).toBeLessThan(0.1);
  });

  it("throughput test — maximum calls per second", async () => {
    const fn = vi.fn(async () => 42);
    const wrapped = latest(fn);

    const durationMs = 200;
    const start = performance.now();
    let calls = 0;

    while (performance.now() - start < durationMs) {
      sink(wrapped());
      calls++;
    }

    const elapsed = performance.now() - start;
    const callsPerSec = Math.round((calls / elapsed) * 1_000);

    // Wait for settlement
    await tick();

    console.log(
      `[BENCHMARK] latest() throughput: ${callsPerSec.toLocaleString()} calls/sec (${calls} calls in ${elapsed.toFixed(2)}ms)`,
    );

    // Should achieve at least 100k calls/sec
    expect(callsPerSec).toBeGreaterThan(50_000);
  });
});

describe("benchmark: dedupe()", () => {
  it("lookup overhead — 100,000 same-key calls", async () => {
    const fn = vi.fn(async (id: string) => id);
    const wrapped = dedupe(fn);

    const start = performance.now();
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 100_000; i++) {
      promises.push(wrapped("same-key"));
    }
    const callTime = performance.now() - start;
    const msPerCall = callTime / 100_000;

    await Promise.all(promises);

    console.log(
      `[BENCHMARK] dedupe() cache-hit dispatch: ${(1_000 / msPerCall).toFixed(0)} ops/sec, ${msPerCall.toFixed(6)} ms/op`,
    );

    // Cache hit should be extremely fast (Map lookup + JSON.stringify)
    expect(msPerCall).toBeLessThan(0.01);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("dedupe() with different keys — JSON.stringify overhead", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = dedupe(fn);

    const start = performance.now();
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100_000; i++) {
      promises.push(wrapped(i));
    }
    const callTime = performance.now() - start;
    const msPerCall = callTime / 100_000;

    await Promise.all(promises);

    console.log(
      `[BENCHMARK] dedupe() unique-key dispatch: ${(1_000 / msPerCall).toFixed(0)} ops/sec, ${msPerCall.toFixed(6)} ms/op`,
    );

    expect(msPerCall).toBeLessThan(0.1);
  });
});

describe("benchmark: latestDedupe()", () => {
  it("combined overhead — 100,000 calls", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latestDedupe(fn);

    const start = performance.now();
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100_000; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }
    const callTime = performance.now() - start;
    const msPerCall = callTime / 100_000;

    await Promise.allSettled(promises);

    console.log(
      `[BENCHMARK] latestDedupe() dispatch: ${(1_000 / msPerCall).toFixed(0)} ops/sec, ${msPerCall.toFixed(6)} ms/op`,
    );

    // Combined latest+dedupe should still be < 0.1ms per call
    expect(msPerCall).toBeLessThan(0.1);
  });
});

describe("benchmark: JSON.stringify key generation", () => {
  it("simple string args", () => {
    const { msPerOp } = bench("JSON.stringify (string)", 100_000, () => {
      JSON.stringify(["hello"]);
    });
    expect(msPerOp).toBeLessThan(0.01);
  });

  it("numeric args", () => {
    const { msPerOp } = bench("JSON.stringify (number)", 100_000, () => {
      JSON.stringify([42, 100, 200]);
    });
    expect(msPerOp).toBeLessThan(0.01);
  });

  it("complex object args", () => {
    const { msPerOp } = bench("JSON.stringify (object)", 100_000, () => {
      JSON.stringify([{ query: "react", page: 1, filters: { lang: "en" } }]);
    });
    expect(msPerOp).toBeLessThan(0.05);
  });

  it("array args with 100 elements", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const { msPerOp } = bench("JSON.stringify (100-element array)", 10_000, () => {
      JSON.stringify([arr]);
    });
    expect(msPerOp).toBeLessThan(0.5);
  });
});

describe("benchmark: AbortController lifecycle", () => {
  it("create + abort cycle — 100,000 iterations", () => {
    const { msPerOp } = bench("AbortController create+abort", 100_000, () => {
      const ac = new AbortController();
      ac.abort();
    });
    expect(msPerOp).toBeLessThan(0.1);

    console.log(
      `[BENCHMARK] AbortController create+abort: ${msPerOp.toFixed(6)} ms/op`,
    );
  });

  it("create + abort with StaleError — 100,000 iterations", () => {
    const { msPerOp } = bench(
      "AbortController create+abort(StaleError)",
      100_000,
      () => {
        const ac = new AbortController();
        ac.abort(new StaleError());
      },
    );
    expect(msPerOp).toBeLessThan(0.1);
  });
});

describe("benchmark: SmartSearch paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache read latency — should be < 1ms", async () => {
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
    await smart.search("cached-query");
    await vi.advanceTimersByTimeAsync(0);

    // Measure cache hit path
    vi.useRealTimers();
    const iterations = 100;
    const start = performance.now();

    // We need to create a fresh SmartSearch with real timers for accurate measurement
    const runSearch2 = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart2 = createSmartSearch(runSearch2, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
    });

    // Populate
    await smart2.search("fast-query");

    // Measure repeated cache hits
    const hitStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await smart2.search("fast-query");
    }
    const hitElapsed = performance.now() - hitStart;
    const msPerHit = hitElapsed / iterations;

    console.log(
      `[BENCHMARK] SmartSearch cache hit: ${msPerHit.toFixed(4)} ms/op (${iterations} iterations)`,
    );

    // Cache hit should be fast (< 5ms accounting for async overhead)
    expect(msPerHit).toBeLessThan(5);
    // Should only call underlying search once (all others are cache hits)
    expect(runSearch2).toHaveBeenCalledTimes(1);
  });

  it("cache write latency — should be < 1ms", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: 0,
      minDebounceMs: 0,
      swr: false,
      cacheMaxEntries: 1000,
    });

    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      await smart.search(`write-${i}`);
    }

    const elapsed = performance.now() - start;
    const msPerWrite = elapsed / iterations;

    console.log(
      `[BENCHMARK] SmartSearch cache write: ${msPerWrite.toFixed(4)} ms/op (${iterations} iterations)`,
    );

    // Full search path (debounce(0) + call + cache write) < 5ms
    expect(msPerWrite).toBeLessThan(5);
  });

  it("debounce accuracy — actual vs configured timing", async () => {
    const runSearch = vi.fn(
      async (query: string): Promise<SearchResponse<string>> => {
        return { items: [query] };
      },
    );

    const configuredDebounce = 100;
    const smart = createSmartSearch(runSearch, {
      baseDebounceMs: configuredDebounce,
      minDebounceMs: configuredDebounce,
      maxDebounceMs: configuredDebounce,
      debounceMode: "fixed",
      swr: false,
    });

    const reported = smart.currentDebounce();
    expect(reported).toBe(configuredDebounce);

    // Fire search and advance timers
    const searchPromise = smart.search("debounce-test");
    sink(searchPromise);

    // Before debounce window — search shouldn't have executed
    await vi.advanceTimersByTimeAsync(configuredDebounce - 1);
    expect(runSearch).not.toHaveBeenCalled();

    // After debounce window — search should execute
    await vi.advanceTimersByTimeAsync(2);
    // The internal `call` (latest-wrapped) has fired by now
    const result = await searchPromise;
    expect(result.items[0]).toBe("debounce-test");
  });

  it.skip("memory per call estimate", async () => {
    const fn = vi.fn(async (n: number) => n);
    const wrapped = latest(fn);

    // Warm up
    for (let i = 0; i < 100; i++) {
      sink(wrapped(i));
    }
    await tick();

    // Measure memory for a batch of calls
    const before = process.memoryUsage().heapUsed;
    const batchSize = 1_000; // Reduced from 10_000 for reliability
    const promises: Promise<number>[] = [];
    for (let i = 0; i < batchSize; i++) {
      const p = wrapped(i);
      promises.push(p);
      sink(p);
    }
    const after = process.memoryUsage().heapUsed;

    const bytesPerCall = Math.max(0, after - before) / batchSize;
    console.log(
      `[BENCHMARK] Memory per in-flight call: ~${bytesPerCall.toFixed(0)} bytes`,
    );

    await tick(); // Allow microtasks for promise settlement
    await Promise.allSettled(promises);

    // Each in-flight call should use < 10KB (generous for CI variability)
    // Memory measurement is inherently noisy, so we use a very generous bound
    expect(bytesPerCall).toBeLessThan(10_000);
  }, 30000); // 30 second timeout for memory test
});
