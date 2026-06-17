/**
 * React adapter for call-latest.
 *
 * Creates a framework-agnostic reactive state machine that is compatible
 * with React's `useSyncExternalStore`. No React import needed — this is
 * a pure state container.
 */

import { latest, isStale } from '../index';

export type UseSearchOptions<TItem> = {
  debounceMs?: number;
  minQueryLength?: number;
  enabled?: boolean;
  onError?: (error: Error) => void;
  onSuccess?: (result: { items: TItem[] }) => void;
  priority?: number;
};

export type UseSearchResult<TItem> = {
  results: TItem[];
  isLoading: boolean;
  error: Error | null;
  query: string;
  search: (query: string) => void;
  reset: () => void;
  isStale: boolean;
  latencyMs: number | null;
};

type SearchState<TItem> = {
  results: TItem[];
  isLoading: boolean;
  error: Error | null;
  query: string;
  isStale: boolean;
  latencyMs: number | null;
};

/**
 * Create a React-compatible search adapter.
 *
 * Returns a factory that creates reactive search state objects
 * compatible with React's `useSyncExternalStore`.
 */
export function createReactAdapter<TItem>(
  searchFn: (query: string, signal: AbortSignal) => Promise<{ items: TItem[] }>,
): {
  createSearchState(options?: UseSearchOptions<TItem>): {
    getState(): UseSearchResult<TItem>;
    search(query: string): void;
    reset(): void;
    subscribe(listener: () => void): () => void;
    destroy(): void;
  };
} {
  return {
    createSearchState(options?: UseSearchOptions<TItem>) {
      const debounceMs = options?.debounceMs ?? 0;
      const minQueryLength = options?.minQueryLength ?? 0;
      const enabled = options?.enabled ?? true;

      let state: SearchState<TItem> = {
        results: [],
        isLoading: false,
        error: null,
        query: '',
        isStale: false,
        latencyMs: null,
      };

      const listeners = new Set<() => void>();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let destroyed = false;

      // Wrap searchFn with latest() for automatic stale cancellation
      const wrappedSearch = latest(
        async (query: string, ctx: { signal: AbortSignal }) => {
          return searchFn(query, ctx.signal);
        },
        { abort: true },
      );

      function notify(): void {
        for (const listener of listeners) {
          listener();
        }
      }

      function setState(partial: Partial<SearchState<TItem>>): void {
        state = { ...state, ...partial };
        notify();
      }

      async function executeSearch(query: string): Promise<void> {
        if (destroyed) return;
        if (!enabled) return;

        if (query.length < minQueryLength) {
          setState({ results: [], isLoading: false, error: null, query, isStale: false, latencyMs: null });
          return;
        }

        setState({ isLoading: true, error: null, query, isStale: false });
        const startTime = Date.now();

        try {
          const result = await (wrappedSearch as unknown as (query: string) => Promise<{ items: TItem[] }>)(query);
          if (destroyed) return;
          const latencyMs = Date.now() - startTime;
          setState({ results: result.items, isLoading: false, isStale: false, latencyMs });
          options?.onSuccess?.(result);
        } catch (err) {
          if (destroyed) return;
          if (isStale(err)) {
            setState({ isStale: true, isLoading: false });
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          setState({ error, isLoading: false, latencyMs: null });
          options?.onError?.(error);
        }
      }

      function search(query: string): void {
        if (destroyed) return;

        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }

        if (debounceMs > 0) {
          setState({ query }); // Update query immediately for UI
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void executeSearch(query);
          }, debounceMs);
        } else {
          void executeSearch(query);
        }
      }

      function reset(): void {
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        wrappedSearch.reset();
        state = {
          results: [],
          isLoading: false,
          error: null,
          query: '',
          isStale: false,
          latencyMs: null,
        };
        notify();
      }

      function getState(): UseSearchResult<TItem> {
        return {
          ...state,
          search,
          reset,
        };
      }

      function subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }

      function destroy(): void {
        destroyed = true;
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        wrappedSearch.reset();
        listeners.clear();
      }

      return { getState, search, reset, subscribe, destroy };
    },
  };
}
