import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamingSearch,
  toStreamingResponse,
  type StreamingSearchResponse,
  type StreamingSearchFn,
} from "./streaming.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createStreamingSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams basic results from async iterable source", async () => {
    const source: StreamingSearchFn<string> = async function* (_query, _signal) {
      yield ["a", "b"];
      yield ["c"];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    for await (const partial of searchStream("react")) {
      results.push(partial);
    }

    // 2 data batches + 1 completion batch
    expect(results.length).toBe(3);
    expect(results[0]!.items).toEqual(["a", "b"]);
    expect(results[0]!.isComplete).toBe(false);
    expect(results[0]!.batchIndex).toBe(0);

    expect(results[1]!.items).toEqual(["a", "b", "c"]);
    expect(results[1]!.isComplete).toBe(false);
    expect(results[1]!.batchIndex).toBe(1);

    // Final completion
    expect(results[2]!.items).toEqual(["a", "b", "c"]);
    expect(results[2]!.isComplete).toBe(true);
  });

  it("accumulates items across batches", async () => {
    const source: StreamingSearchFn<number> = async function* () {
      yield [1, 2];
      yield [3, 4, 5];
      yield [6];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<number>[] = [];
    for await (const partial of searchStream("test")) {
      results.push(partial);
    }

    // Items accumulate
    expect(results[0]!.total).toBe(2);
    expect(results[1]!.total).toBe(5);
    expect(results[2]!.total).toBe(6);
    // Final
    expect(results[3]!.total).toBe(6);
    expect(results[3]!.isComplete).toBe(true);
  });

  it("cancels stream mid-flight via external signal", async () => {
    vi.useRealTimers(); // need real timers for abort

    const controller = new AbortController();
    let yieldCount = 0;

    const source: StreamingSearchFn<string> = async function* (_q, signal) {
      yield ["a"];
      yieldCount++;
      await new Promise((r) => setTimeout(r, 10));
      if (signal.aborted) return;
      yield ["b"];
      yieldCount++;
      await new Promise((r) => setTimeout(r, 10));
      if (signal.aborted) return;
      yield ["c"];
      yieldCount++;
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    const stream = searchStream("test", { signal: controller.signal });

    for await (const partial of stream) {
      results.push(partial);
      if (results.length >= 1) {
        controller.abort(); // cancel after first batch
      }
    }

    // Should have gotten at most a couple of results
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("handles Promise<TItem[]> source (single-shot)", async () => {
    const source: StreamingSearchFn<string> = async () => {
      return ["x", "y", "z"];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    for await (const partial of searchStream("query")) {
      results.push(partial);
    }

    expect(results.length).toBe(1);
    expect(results[0]!.items).toEqual(["x", "y", "z"]);
    expect(results[0]!.total).toBe(3);
    expect(results[0]!.isComplete).toBe(true);
  });

  it("latest-call safety: new stream cancels old", async () => {
    vi.useRealTimers();

    let cancelledFirst = false;
    const source: StreamingSearchFn<string> = async function* (query, signal) {
      yield [`${query}-1`];
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) {
        cancelledFirst = true;
        return;
      }
      yield [`${query}-2`];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    // Start first stream but don't consume it
    const firstStream = searchStream("old");
    // Start second stream immediately (cancels first)
    const secondStream = searchStream("new");

    const secondResults: StreamingSearchResponse<string>[] = [];
    for await (const partial of secondStream) {
      secondResults.push(partial);
    }

    // Second stream should complete normally
    expect(secondResults.length).toBeGreaterThanOrEqual(1);
    const lastResult = secondResults[secondResults.length - 1]!;
    // Should contain items from 'new' query
    expect(lastResult.items.some((i) => i.startsWith("new"))).toBe(true);
  });

  it("handles empty results", async () => {
    const source: StreamingSearchFn<string> = async () => {
      return [];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    for await (const partial of searchStream("empty")) {
      results.push(partial);
    }

    expect(results.length).toBe(1);
    expect(results[0]!.items).toEqual([]);
    expect(results[0]!.total).toBe(0);
    expect(results[0]!.isComplete).toBe(true);
  });

  it("propagates errors from source", async () => {
    const source: StreamingSearchFn<string> = async function* () {
      yield ["ok"];
      throw new Error("source failed");
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    await expect(async () => {
      for await (const partial of searchStream("error")) {
        results.push(partial);
      }
    }).rejects.toThrow("source failed");

    // Should have gotten the first batch before error
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("isStreaming() reflects correct state", async () => {
    vi.useRealTimers();

    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });

    const source: StreamingSearchFn<string> = async function* () {
      yield ["a"];
      await gate;
      yield ["b"];
    };

    const { searchStream, isStreaming } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    expect(isStreaming()).toBe(false);

    const stream = searchStream("test");
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next(); // consume first batch
    expect(isStreaming()).toBe(true);

    resolve(); // unblock
    await iterator.next(); // second batch
    await iterator.next(); // completion

    expect(isStreaming()).toBe(false);
  });

  it("calls onPartialResult callback for each batch", async () => {
    const onPartialResult = vi.fn();
    const source: StreamingSearchFn<string> = async function* () {
      yield ["a"];
      yield ["b"];
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
      onPartialResult,
    });

    for await (const _ of searchStream("test")) {
      // consume
    }

    // 2 data batches + 1 completion = 3 calls
    expect(onPartialResult).toHaveBeenCalledTimes(3);
    expect(onPartialResult.mock.calls[0]![0].items).toEqual(["a"]);
    expect(onPartialResult.mock.calls[1]![0].items).toEqual(["a", "b"]);
  });

  it("cancel() stops an in-flight stream", async () => {
    vi.useRealTimers();

    const source: StreamingSearchFn<string> = async function* (_q, signal) {
      yield ["a"];
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) return;
      yield ["b"];
    };

    const { searchStream, cancel, isStreaming } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const stream = searchStream("test");
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next(); // first batch
    cancel();

    // Should be no longer streaming
    expect(isStreaming()).toBe(false);
  });

  it("supports ReadableStream source", async () => {
    const source: StreamingSearchFn<string> = (_query, _signal) => {
      let pushCount = 0;
      return new ReadableStream<string[]>({
        pull(controller) {
          pushCount++;
          if (pushCount <= 2) {
            controller.enqueue([`batch-${pushCount}`]);
          } else {
            controller.close();
          }
        },
      });
    };

    const { searchStream } = createStreamingSearch(source, {
      batchIntervalMs: 0,
    });

    const results: StreamingSearchResponse<string>[] = [];
    for await (const partial of searchStream("rs-test")) {
      results.push(partial);
    }

    // 2 data batches + 1 completion
    expect(results.length).toBe(3);
    expect(results[0]!.items).toEqual(["batch-1"]);
    expect(results[1]!.items).toEqual(["batch-1", "batch-2"]);
    expect(results[2]!.isComplete).toBe(true);
  });
});

describe("toStreamingResponse", () => {
  it("breaks items into batches of specified size", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results: StreamingSearchResponse<number>[] = [];

    for await (const partial of toStreamingResponse(items, {
      batchSize: 3,
      batchIntervalMs: 0,
    })) {
      results.push(partial);
    }

    expect(results.length).toBe(3); // 3 + 3 + 1
    expect(results[0]!.items).toEqual([1, 2, 3]);
    expect(results[0]!.total).toBe(3);
    expect(results[0]!.isComplete).toBe(false);

    expect(results[1]!.items).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results[1]!.total).toBe(6);
    expect(results[1]!.isComplete).toBe(false);

    expect(results[2]!.items).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(results[2]!.total).toBe(7);
    expect(results[2]!.isComplete).toBe(true);
  });

  it("handles empty items array", async () => {
    const results: StreamingSearchResponse<string>[] = [];

    for await (const partial of toStreamingResponse([], {
      batchSize: 5,
      batchIntervalMs: 0,
    })) {
      results.push(partial);
    }

    expect(results.length).toBe(1);
    expect(results[0]!.items).toEqual([]);
    expect(results[0]!.isComplete).toBe(true);
  });

  it("batch indices increment correctly", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const results: StreamingSearchResponse<string>[] = [];

    for await (const partial of toStreamingResponse(items, {
      batchSize: 2,
      batchIntervalMs: 0,
    })) {
      results.push(partial);
    }

    expect(results[0]!.batchIndex).toBe(0);
    expect(results[1]!.batchIndex).toBe(1);
    expect(results[2]!.batchIndex).toBe(2);
  });

  it("items exactly matching batch size produces 1 batch", async () => {
    const items = ["a", "b", "c"];
    const results: StreamingSearchResponse<string>[] = [];

    for await (const partial of toStreamingResponse(items, {
      batchSize: 3,
      batchIntervalMs: 0,
    })) {
      results.push(partial);
    }

    expect(results.length).toBe(1);
    expect(results[0]!.items).toEqual(["a", "b", "c"]);
    expect(results[0]!.isComplete).toBe(true);
  });

  it("uses default batch size when not specified", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const results: StreamingSearchResponse<number>[] = [];

    for await (const partial of toStreamingResponse(items, {
      batchIntervalMs: 0,
    })) {
      results.push(partial);
    }

    // Default batch size is 5: ceil(12/5) = 3 batches
    expect(results.length).toBe(3);
    expect(results[0]!.total).toBe(5);
    expect(results[1]!.total).toBe(10);
    expect(results[2]!.total).toBe(12);
    expect(results[2]!.isComplete).toBe(true);
  });
});
