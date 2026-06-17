/**
 * Solid.js adapter for call-latest.
 *
 * Creates a signal-compatible reactive state machine that can be consumed
 * by Solid's reactivity system. No Solid import needed.
 */

import { latest, isStale } from '../index';

type SolidSearchState<TItem> = {
  results: TItem[];
  isLoading: boolean;
  error: Error | null;
  query: string;
};

export type SolidSearchOptions = {
  debounceMs?: number;
  minQueryLength?: number;
};

/**
 * Create a Solid-compatible search adapter.
 */
export function createSolidAdapter<TItem>(
  searchFn: (query: string, signal: AbortSignal) => Promise<{ items: TItem[] }>,
): {
  createSearchSignal(options?: SolidSearchOptions): {
    getState(): SolidSearchState<TItem>;
    search(query: string): void;
    reset(): void;
    subscribe(listener: () => void): () => void;
    destroy(): void;
  };
} {
  return {
    createSearchSignal(options?: SolidSearchOptions) {
      const debounceMs = options?.debounceMs ?? 0;
      const minQueryLength = options?.minQueryLength ?? 0;

      let state: SolidSearchState<TItem> = {
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

      function setState(partial: Partial<SolidSearchState<TItem>>): void {
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

      function getState(): SolidSearchState<TItem> {
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
