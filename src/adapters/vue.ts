/**
 * Vue 3 adapter for call-latest.
 *
 * Creates a composable-ready reactive state machine that can be consumed
 * by Vue's reactivity system. No Vue import needed.
 */

import { latest, isStale } from '../index';

type VueSearchState<TItem> = {
  results: TItem[];
  isLoading: boolean;
  error: Error | null;
  query: string;
};

export type VueSearchOptions = {
  debounceMs?: number;
  minQueryLength?: number;
};

/**
 * Create a Vue-compatible search adapter.
 */
export function createVueAdapter<TItem>(
  searchFn: (query: string, signal: AbortSignal) => Promise<{ items: TItem[] }>,
): {
  createSearchState(options?: VueSearchOptions): {
    getState(): VueSearchState<TItem>;
    search(query: string): void;
    reset(): void;
    subscribe(listener: () => void): () => void;
    destroy(): void;
  };
} {
  return {
    createSearchState(options?: VueSearchOptions) {
      const debounceMs = options?.debounceMs ?? 0;
      const minQueryLength = options?.minQueryLength ?? 0;

      let state: VueSearchState<TItem> = {
        results: [],
        isLoading: false,
        error: null,
        query: '',
      };

      const listeners = new Set<() => void>();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let destroyed = false;

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

      function setState(partial: Partial<VueSearchState<TItem>>): void {
        state = { ...state, ...partial };
        notify();
      }

      async function executeSearch(query: string): Promise<void> {
        if (destroyed) return;

        if (query.length < minQueryLength) {
          setState({ results: [], isLoading: false, error: null, query });
          return;
        }

        setState({ isLoading: true, error: null, query });

        try {
          const result = await (wrappedSearch as unknown as (query: string) => Promise<{ items: TItem[] }>)(query);
          if (destroyed) return;
          setState({ results: result.items, isLoading: false });
        } catch (err) {
          if (destroyed) return;
          if (isStale(err)) {
            // Silently ignore stale results
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          setState({ error, isLoading: false });
        }
      }

      function search(query: string): void {
        if (destroyed) return;

        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }

        if (debounceMs > 0) {
          setState({ query });
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
        };
        notify();
      }

      function getState(): VueSearchState<TItem> {
        return { ...state };
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
