/**
 * Streaming Results — progressive rendering for search.
 *
 * Instead of waiting for all results, stream them progressively:
 * ```ts
 * const stream = smart.searchStream('react');
 * for await (const partial of stream) {
 *   render(partial); // 1 result, then 5, then 20...
 * }
 * ```
 *
 * @module
 */

export type StreamingSearchOptions<TItem> = {
  /** Number of items per batch. @default 5 */
  batchSize?: number;
  /** Milliseconds between emitted batches. @default 50 */
  batchIntervalMs?: number;
  /** Called on each partial result batch. */
  onPartialResult?: (partial: StreamingSearchResponse<TItem>) => void;
  /** External abort signal to cancel the stream. */
  signal?: AbortSignal;
};

export type StreamingSearchResponse<TItem> = {
  /** Accumulated items received so far. */
  items: TItem[];
  /** Total number of items accumulated. */
  total: number;
  /** Whether the stream is complete. */
  isComplete: boolean;
  /** 0-based index of this batch. */
  batchIndex: number;
  /** Optional version/hash for delta protocols. */
  version?: string;
};

/**
 * Source function signature. Must return one of:
 * - AsyncIterable of item batches
 * - ReadableStream of item batches
 * - Promise of all items at once
 */
export type StreamingSearchFn<TItem> = (
  query: string,
  signal: AbortSignal,
) => AsyncIterable<TItem[]> | ReadableStream<TItem[]> | Promise<TItem[]>;

/**
 * Create a streaming search controller from a source function.
 *
 * The returned controller manages latest-call safety: starting a new
 * `searchStream` automatically cancels any in-flight stream so only
 * the newest survives.
 *
 * @param source  Async function that yields batches of items.
 * @param options Global streaming options (can be overridden per-search).
 */
export function createStreamingSearch<TItem>(
  source: StreamingSearchFn<TItem>,
  options?: StreamingSearchOptions<TItem>,
): {
  searchStream(
    query: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<StreamingSearchResponse<TItem>>;
  cancel(): void;
  isStreaming(): boolean;
} {
  const defaultBatchSize = options?.batchSize ?? 5;
  const defaultBatchIntervalMs = options?.batchIntervalMs ?? 50;
  const onPartialResult = options?.onPartialResult;

  let activeController: AbortController | null = null;
  let streamGeneration = 0;
  let streaming = false;

  function cancel(): void {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    streaming = false;
  }

  function isStreaming(): boolean {
    return streaming;
  }

  function searchStream(
    query: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<StreamingSearchResponse<TItem>> {
    // Cancel any previous stream (latest-call safety)
    cancel();

    const generation = ++streamGeneration;
    const controller = new AbortController();
    activeController = controller;

    // Respect external signal
    if (opts?.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    const signal = controller.signal;

    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamingSearchResponse<TItem>> {
        let started = false;
        let iterator: AsyncIterator<TItem[]> | null = null;
        let accumulated: TItem[] = [];
        let batchIndex = 0;
        let done = false;
        let pendingItems: TItem[] = [];

        async function init(): Promise<void> {
          if (started) return;
          started = true;
          streaming = true;

          const result = source(query, signal);

          if (isPromise<TItem[]>(result)) {
            // Promise<TItem[]> — single shot
            const items = await result;
            pendingItems = items;
            iterator = null; // will be handled in next()
          } else if (isReadableStream<TItem[]>(result)) {
            // ReadableStream → AsyncIterator via getReader
            iterator = readableStreamToAsyncIterator(result);
          } else {
            // AsyncIterable
            iterator = (result as AsyncIterable<TItem[]>)[Symbol.asyncIterator]();
          }
        }

        return {
          async next(): Promise<IteratorResult<StreamingSearchResponse<TItem>>> {
            if (done) {
              return { value: undefined, done: true };
            }

            // Check if this stream is still the latest
            if (generation !== streamGeneration) {
              done = true;
              return { value: undefined, done: true };
            }

            if (signal.aborted) {
              done = true;
              streaming = false;
              return { value: undefined, done: true };
            }

            try {
              await init();
            } catch (err) {
              done = true;
              streaming = false;
              throw err;
            }

            // Handle Promise<TItem[]> source
            if (iterator === null) {
              done = true;
              streaming = false;

              // Emit in batches
              const allItems = pendingItems;
              if (allItems.length === 0) {
                const resp: StreamingSearchResponse<TItem> = {
                  items: [],
                  total: 0,
                  isComplete: true,
                  batchIndex: 0,
                };
                onPartialResult?.(resp);
                if (generation === streamGeneration) {
                  activeController = null;
                }
                return { value: resp, done: false };
              }

              accumulated = allItems;
              const resp: StreamingSearchResponse<TItem> = {
                items: [...accumulated],
                total: accumulated.length,
                isComplete: true,
                batchIndex: batchIndex++,
              };
              onPartialResult?.(resp);
              if (generation === streamGeneration) {
                activeController = null;
              }
              return { value: resp, done: false };
            }

            // AsyncIterator path
            if (signal.aborted) {
              done = true;
              streaming = false;
              return { value: undefined, done: true };
            }

            const iterResult = await iterator.next();

            if (iterResult.done) {
              done = true;
              streaming = false;

              // Final batch with isComplete = true
              const resp: StreamingSearchResponse<TItem> = {
                items: [...accumulated],
                total: accumulated.length,
                isComplete: true,
                batchIndex: batchIndex++,
              };
              onPartialResult?.(resp);
              if (generation === streamGeneration) {
                activeController = null;
              }
              return { value: resp, done: false };
            }

            // Accumulate new batch
            const newItems = iterResult.value;
            accumulated = accumulated.concat(newItems);

            const resp: StreamingSearchResponse<TItem> = {
              items: [...accumulated],
              total: accumulated.length,
              isComplete: false,
              batchIndex: batchIndex++,
            };
            onPartialResult?.(resp);

            // Wait between batches
            if (defaultBatchIntervalMs > 0) {
              await delay(defaultBatchIntervalMs, signal);
            }

            return { value: resp, done: false };
          },

          async return(): Promise<IteratorResult<StreamingSearchResponse<TItem>>> {
            done = true;
            streaming = false;
            controller.abort();
            if (iterator?.return) {
              await iterator.return();
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  return { searchStream, cancel, isStreaming };
}

/**
 * Convert a flat array of items into a streaming response.
 *
 * Useful for wrapping a regular synchronous/fetch-based search result
 * into the streaming pattern for consistent progressive rendering.
 */
export async function* toStreamingResponse<TItem>(
  items: TItem[],
  options?: { batchSize?: number; batchIntervalMs?: number },
): AsyncIterable<StreamingSearchResponse<TItem>> {
  const batchSize = options?.batchSize ?? 5;
  const batchIntervalMs = options?.batchIntervalMs ?? 50;

  const accumulated: TItem[] = [];
  let batchIndex = 0;
  const total = items.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    accumulated.push(...batch);
    const isComplete = i + batchSize >= total;

    const response: StreamingSearchResponse<TItem> = {
      items: [...accumulated],
      total: accumulated.length,
      isComplete,
      batchIndex: batchIndex++,
    };

    yield response;

    if (!isComplete && batchIntervalMs > 0) {
      await delay(batchIntervalMs);
    }
  }

  // Handle empty items array
  if (total === 0) {
    yield {
      items: [],
      total: 0,
      isComplete: true,
      batchIndex: 0,
    };
  }
}

// ─── Internal helpers ────────────────────────────────────────────────

function isPromise<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<T>).then === "function" &&
    !(Symbol.asyncIterator in value) &&
    !isReadableStream(value)
  );
}

function isReadableStream<T>(value: unknown): value is ReadableStream<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<T>).getReader === "function" &&
    typeof (value as ReadableStream<T>).cancel === "function"
  );
}

function readableStreamToAsyncIterator<T>(
  stream: ReadableStream<T>,
): AsyncIterator<T> {
  const reader = stream.getReader();

  return {
    async next(): Promise<IteratorResult<T>> {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        return { value: undefined, done: true };
      }
      return { value, done: false };
    },
    async return(): Promise<IteratorResult<T>> {
      reader.releaseLock();
      await stream.cancel();
      return { value: undefined, done: true };
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
