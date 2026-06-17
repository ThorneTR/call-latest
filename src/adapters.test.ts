import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createReactAdapter } from './adapters/react.js';
import { createVueAdapter } from './adapters/vue.js';
import { createSvelteAdapter } from './adapters/svelte.js';
import { createSolidAdapter } from './adapters/solid.js';

// ─── Helper ──────────────────────────────────────────────────────────

function createMockSearchFn(delay = 10) {
  return vi.fn(async (query: string, signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      });
    });
    return { items: [{ id: 1, name: query }] };
  });
}

function flushMicrotasks() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function waitForCondition(
  check: () => boolean,
  timeout = 2000,
  interval = 10,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitForCondition timed out');
    }
    await new Promise<void>(r => setTimeout(r, interval));
  }
}

// ─── React Adapter ───────────────────────────────────────────────────

describe('React adapter', () => {
  it('createSearchState returns correct initial state', () => {
    const searchFn = createMockSearchFn();
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    const state = store.getState();
    expect(state.results).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
    expect(state.isStale).toBe(false);
    expect(state.latencyMs).toBeNull();
  });

  it('search triggers state change', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    store.search('react');

    // Wait for search to complete
    await waitForCondition(() => !store.getState().isLoading && store.getState().results.length > 0);

    const state = store.getState();
    expect(state.results).toEqual([{ id: 1, name: 'react' }]);
    expect(state.isLoading).toBe(false);
    expect(state.query).toBe('react');
    expect(state.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('subscribe and unsubscribe work correctly', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.search('test');
    await waitForCondition(() => store.getState().results.length > 0);

    expect(listener).toHaveBeenCalled();

    // Reset mock and unsubscribe
    listener.mockClear();
    unsub();

    store.search('another');
    await flushMicrotasks();

    // Listener should not be called after unsubscribe
    expect(listener).not.toHaveBeenCalled();
  });

  it('error handling works', async () => {
    const searchFn = vi.fn(async () => {
      throw new Error('Network error');
    });
    const onError = vi.fn();
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState({ onError });

    store.search('fail');
    await waitForCondition(() => store.getState().error !== null);

    const state = store.getState();
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error!.message).toBe('Network error');
    expect(state.isLoading).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('reset returns to initial state', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    store.search('react');
    await waitForCondition(() => store.getState().results.length > 0);

    store.reset();

    const state = store.getState();
    expect(state.results).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
  });

  it('destroy cleans up resources', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    store.destroy();

    store.search('test');
    await flushMicrotasks();

    expect(listener).not.toHaveBeenCalled();
  });

  it('minQueryLength prevents short queries', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState({ minQueryLength: 3 });

    store.search('ab');
    await flushMicrotasks();

    expect(searchFn).not.toHaveBeenCalled();
    expect(store.getState().results).toEqual([]);
  });

  it('debounce delays search execution', async () => {
    vi.useFakeTimers();
    const searchFn = createMockSearchFn(0);
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState({ debounceMs: 100 });

    store.search('r');
    store.search('re');
    store.search('rea');
    store.search('reac');
    store.search('react');

    // searchFn should not have been called yet
    expect(searchFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    // Now the debounce should fire
    await vi.advanceTimersByTimeAsync(50);

    expect(searchFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('onSuccess callback is called', async () => {
    const searchFn = createMockSearchFn(5);
    const onSuccess = vi.fn();
    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState({ onSuccess });

    store.search('react');
    await waitForCondition(() => store.getState().results.length > 0);

    expect(onSuccess).toHaveBeenCalledWith({ items: [{ id: 1, name: 'react' }] });
  });
});

// ─── Vue Adapter ─────────────────────────────────────────────────────

describe('Vue adapter', () => {
  it('createSearchState returns correct initial state', () => {
    const searchFn = createMockSearchFn();
    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    const state = store.getState();
    expect(state.results).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
  });

  it('state transitions through loading → results', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    const states: Array<{ isLoading: boolean; results: unknown[] }> = [];
    store.subscribe(() => {
      const s = store.getState();
      states.push({ isLoading: s.isLoading, results: s.results });
    });

    store.search('vue');
    await waitForCondition(() => store.getState().results.length > 0);

    // Should have loading=true and then loading=false with results
    expect(states.some(s => s.isLoading)).toBe(true);
    expect(states[states.length - 1]!.isLoading).toBe(false);
    expect(states[states.length - 1]!.results.length).toBe(1);
  });

  it('search triggers state change', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    store.search('vue');
    await waitForCondition(() => store.getState().results.length > 0);

    expect(store.getState().results).toEqual([{ id: 1, name: 'vue' }]);
  });

  it('subscribe/unsubscribe works', () => {
    const searchFn = createMockSearchFn();
    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.reset(); // triggers notify
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsub();

    store.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('destroy cleans up', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    store.destroy();
    store.search('test');
    await flushMicrotasks();

    // Should not execute search
    expect(searchFn).not.toHaveBeenCalled();
  });
});

// ─── Svelte Adapter ──────────────────────────────────────────────────

describe('Svelte adapter', () => {
  it('subscribe pattern: calls listener immediately with initial state', () => {
    const searchFn = createMockSearchFn();
    const adapter = createSvelteAdapter(searchFn);
    const store = adapter.createSearchStore();

    const listener = vi.fn();
    store.subscribe(listener);

    // Svelte stores call listener immediately
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      results: [],
      isLoading: false,
      error: null,
      query: '',
    });
  });

  it('search triggers state change via subscriber', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSvelteAdapter(searchFn);
    const store = adapter.createSearchStore();

    const states: Array<{ query: string; isLoading: boolean }> = [];
    store.subscribe((state) => {
      states.push({ query: state.query, isLoading: state.isLoading });
    });

    store.search('svelte');
    await waitForCondition(() => {
      const last = states[states.length - 1];
      return last !== undefined && !last.isLoading && last.query === 'svelte';
    });

    expect(states.length).toBeGreaterThan(1);
    const lastState = states[states.length - 1]!;
    expect(lastState.query).toBe('svelte');
    expect(lastState.isLoading).toBe(false);
  });

  it('reset emits to subscribers', () => {
    const searchFn = createMockSearchFn();
    const adapter = createSvelteAdapter(searchFn);
    const store = adapter.createSearchStore();

    const states: unknown[] = [];
    store.subscribe((state) => {
      states.push(state);
    });

    store.reset();
    expect(states.length).toBe(2); // initial + reset
  });

  it('destroy stops notifications', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSvelteAdapter(searchFn);
    const store = adapter.createSearchStore();

    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    store.destroy();
    store.search('test');
    await flushMicrotasks();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── Solid Adapter ───────────────────────────────────────────────────

describe('Solid adapter', () => {
  it('createSearchSignal returns correct initial state', () => {
    const searchFn = createMockSearchFn();
    const adapter = createSolidAdapter(searchFn);
    const signal = adapter.createSearchSignal();

    const state = signal.getState();
    expect(state.results).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.query).toBe('');
  });

  it('state management: search updates state', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSolidAdapter(searchFn);
    const signal = adapter.createSearchSignal();

    signal.search('solid');
    await waitForCondition(() => signal.getState().results.length > 0);

    expect(signal.getState().results).toEqual([{ id: 1, name: 'solid' }]);
    expect(signal.getState().isLoading).toBe(false);
  });

  it('subscribe notifies on changes', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSolidAdapter(searchFn);
    const signal = adapter.createSearchSignal();

    const notifyCount = vi.fn();
    signal.subscribe(notifyCount);

    signal.search('test');
    await waitForCondition(() => signal.getState().results.length > 0);

    expect(notifyCount).toHaveBeenCalled();
  });

  it('reset returns to initial state', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSolidAdapter(searchFn);
    const signal = adapter.createSearchSignal();

    signal.search('solid');
    await waitForCondition(() => signal.getState().results.length > 0);

    signal.reset();

    const state = signal.getState();
    expect(state.results).toEqual([]);
    expect(state.query).toBe('');
    expect(state.isLoading).toBe(false);
  });

  it('destroy cleans up', async () => {
    const searchFn = createMockSearchFn(5);
    const adapter = createSolidAdapter(searchFn);
    const signal = adapter.createSearchSignal();

    const listener = vi.fn();
    signal.subscribe(listener);
    listener.mockClear();

    signal.destroy();
    signal.search('test');
    await flushMicrotasks();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── Cross-Adapter Tests ─────────────────────────────────────────────

describe('All adapters', () => {
  it('handle concurrent calls (only latest wins)', async () => {
    // Search function with variable delay
    let callIndex = 0;
    const searchFn = vi.fn(async (query: string, signal: AbortSignal) => {
      const idx = callIndex++;
      const delay = idx === 0 ? 100 : 10; // First call is slow
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
      return { items: [{ id: idx, name: query }] };
    });

    const adapter = createReactAdapter(searchFn);
    const store = adapter.createSearchState();

    store.search('first');
    store.search('second');

    await waitForCondition(() => store.getState().results.length > 0 && !store.getState().isLoading);

    const state = store.getState();
    // Only the latest search should have its results
    expect(state.results[0]!.name).toBe('second');
  });

  it('handle cancellation via latest()', async () => {
    const abortedQueries: string[] = [];
    const searchFn = vi.fn(async (query: string, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          abortedQueries.push(query);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
      return { items: [{ id: 1, name: query }] };
    });

    const adapter = createVueAdapter(searchFn);
    const store = adapter.createSearchState();

    store.search('first');
    // Immediately search again to trigger cancellation of first
    await flushMicrotasks();
    store.search('second');

    await waitForCondition(() => {
      const s = store.getState();
      return s.results.length > 0 && !s.isLoading;
    });

    // First search should have been cancelled via abort
    expect(abortedQueries).toContain('first');
    expect(store.getState().results[0]!.name).toBe('second');
  });

  it('cleanup on destroy works for all adapters', async () => {
    const searchFn = createMockSearchFn(5);

    // React
    const reactStore = createReactAdapter(searchFn).createSearchState();
    const reactListener = vi.fn();
    reactStore.subscribe(reactListener);
    reactStore.destroy();
    reactListener.mockClear();
    reactStore.search('test');
    await flushMicrotasks();
    expect(reactListener).not.toHaveBeenCalled();

    // Vue
    const vueStore = createVueAdapter(searchFn).createSearchState();
    const vueListener = vi.fn();
    vueStore.subscribe(vueListener);
    vueStore.destroy();
    vueListener.mockClear();
    vueStore.search('test');
    await flushMicrotasks();
    expect(vueListener).not.toHaveBeenCalled();

    // Svelte
    const svelteStore = createSvelteAdapter(searchFn).createSearchStore();
    const svelteListener = vi.fn();
    svelteStore.subscribe(svelteListener);
    svelteStore.destroy();
    svelteListener.mockClear();
    svelteStore.search('test');
    await flushMicrotasks();
    expect(svelteListener).not.toHaveBeenCalled();

    // Solid
    const solidStore = createSolidAdapter(searchFn).createSearchSignal();
    const solidListener = vi.fn();
    solidStore.subscribe(solidListener);
    solidStore.destroy();
    solidListener.mockClear();
    solidStore.search('test');
    await flushMicrotasks();
    expect(solidListener).not.toHaveBeenCalled();
  });

  it('debounce works for all adapters', async () => {
    vi.useFakeTimers();
    const searchFn = createMockSearchFn(0);

    // React with debounce
    const reactStore = createReactAdapter(searchFn).createSearchState({ debounceMs: 100 });
    reactStore.search('react');
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(searchFn).toHaveBeenCalled();
    searchFn.mockClear();

    // Vue with debounce
    const vueStore = createVueAdapter(searchFn).createSearchState({ debounceMs: 100 });
    vueStore.search('vue');
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(searchFn).toHaveBeenCalled();
    searchFn.mockClear();

    // Svelte with debounce
    const svelteStore = createSvelteAdapter(searchFn).createSearchStore({ debounceMs: 100 });
    svelteStore.search('svelte');
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(searchFn).toHaveBeenCalled();
    searchFn.mockClear();

    // Solid with debounce
    const solidStore = createSolidAdapter(searchFn).createSearchSignal({ debounceMs: 100 });
    solidStore.search('solid');
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(searchFn).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('error handling works across adapters', async () => {
    const searchFn = vi.fn(async () => {
      throw new Error('API Error');
    });

    // React
    const reactStore = createReactAdapter(searchFn).createSearchState();
    reactStore.search('fail');
    await waitForCondition(() => reactStore.getState().error !== null);
    expect(reactStore.getState().error!.message).toBe('API Error');

    // Vue
    const vueStore = createVueAdapter(searchFn).createSearchState();
    vueStore.search('fail');
    await waitForCondition(() => vueStore.getState().error !== null);
    expect(vueStore.getState().error!.message).toBe('API Error');

    // Solid
    const solidStore = createSolidAdapter(searchFn).createSearchSignal();
    solidStore.search('fail');
    await waitForCondition(() => solidStore.getState().error !== null);
    expect(solidStore.getState().error!.message).toBe('API Error');
  });
});
