/**
 * Svelte adapter for call-latest.
 *
 * Creates a store-compatible reactive state machine that matches Svelte's
 * store contract: subscribe receives the full state on every change.
 */

import { latest, isStale } from '../index';

type SvelteSearchState<TItem> = {
  results: TItem[];
  isLoading: boolean;
  error: Error | null;
  query: string;
};

export type SvelteSearchOptions = {
  debounceMs?: number;
  minQueryLength?: number;
};

/**
 * Create a Svelte-compatible search adapter.
 */
export function createSvelteAdapter<TItem>(
  searchFn: (query: string, signal: AbortSignal) => Promise<{ items: TItem[] }>,
): {
  createSearchStore(options?: SvelteSearchOptions): {
    subscribe(listener: (state: SvelteSearchState<TItem>) => void): () => void;
    search(query: string): void;
    reset(): void;
    destroy(): void;
  };
} {
  return {
    createSearchStore(options?: SvelteSearchOptions) {
      const debounceMs = options?.debounceMs ?? 0;
      const minQueryLength = options?.minQueryLength ?? 0;

      let state: SvelteSearchState<TItem> = {
        results: [],
        isLoading: false,
        error: null,
        query: '',
      };

      const listeners = new Set<(state: SvelteSearchState<TItem>) => void>();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let destroyed = false;

      const wrappedSearch = latest(
        async (query: string, ctx: { signal: AbortSignal }) => {
          return searchFn(query, ctx.signal);
        },
        { abort: true },
      );

      function notify(): void {
        const snapshot = { ...state };
        for (const listener of listeners) {
          listener(snapshot);
        }
      }

      function setState(partial: Partial<SvelteSearchState<TItem>>): void {
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
          if (isStale(err)) return;
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

      // Svelte store contract: call listener immediately with current state
      function subscribe(listener: (state: SvelteSearchState<TItem>) => void): () => void {
        listeners.add(listener);
        // Svelte stores call listener immediately with current value
        listener({ ...state });
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

      return { subscribe, search, reset, destroy };
    },
  };
}
