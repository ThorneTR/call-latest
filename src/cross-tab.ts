/**
 * Cross-Tab Deduplication using BroadcastChannel.
 *
 * When the same user searches 'iphone' in 3 tabs:
 * - 1 network request
 * - 3 tabs get the result
 */

export type CrossTabOptions = {
  channelName?: string;       // default 'call-latest-channel'
  responseTimeoutMs?: number; // how long to wait for another tab, default 2000
  role?: 'auto' | 'leader' | 'follower'; // default 'auto'
};

export type CrossTabMessage<T> =
  | { type: 'REQUEST'; key: string; requestId: string; timestamp: number }
  | { type: 'RESPONSE'; key: string; requestId: string; data: T; timestamp: number }
  | { type: 'CLAIM'; key: string; requestId: string; tabId: string }
  | { type: 'HEARTBEAT'; tabId: string; timestamp: number };

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  key: string;
};

type ActiveFetch<T> = {
  key: string;
  requestId: string;
  promise: Promise<T>;
};

function generateTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fallback
  }
  return 'tab-' + Math.random().toString(36).slice(2, 11) + '-' + Date.now().toString(36);
}

function hasBroadcastChannel(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>).BroadcastChannel === 'function';
}

export class CrossTabDeduplicator<T> {
  private readonly channelName: string;
  private readonly responseTimeoutMs: number;
  private readonly role: 'auto' | 'leader' | 'follower';
  private readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest<T>>();
  private readonly activeFetches = new Map<string, ActiveFetch<T>>();
  private destroyed = false;

  private _served = 0;
  private _received = 0;
  private _timeouts = 0;

  constructor(options?: CrossTabOptions) {
    this.channelName = options?.channelName ?? 'call-latest-channel';
    this.responseTimeoutMs = options?.responseTimeoutMs ?? 2000;
    this.role = options?.role ?? 'auto';
    this.tabId = generateTabId();

    if (hasBroadcastChannel()) {
      try {
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data as CrossTabMessage<T>);
        };
      } catch {
        this.channel = null;
      }
    }
  }

  async dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.destroyed) {
      return fn();
    }

    // No BroadcastChannel available — just run locally
    if (!this.channel) {
      return fn();
    }

    // If we're already fetching this key, share the promise
    const existing = this.activeFetches.get(key);
    if (existing) {
      return existing.promise;
    }

    // If forced leader, always fetch and broadcast
    if (this.role === 'leader') {
      return this.fetchAndBroadcast(key, fn);
    }

    // If forced follower, always wait for another tab
    if (this.role === 'follower') {
      return this.waitForResponse(key, fn);
    }

    // Auto mode: broadcast request, wait briefly for a claim, then self-claim
    return this.autoNegotiate(key, fn);
  }

  activeCount(): number {
    return this.activeFetches.size + this.pendingRequests.size;
  }

  destroy(): void {
    this.destroyed = true;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CrossTabDeduplicator destroyed'));
    }
    this.pendingRequests.clear();
    this.activeFetches.clear();

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
  }

  stats(): { served: number; received: number; timeouts: number } {
    return {
      served: this._served,
      received: this._received,
      timeouts: this._timeouts,
    };
  }

  private handleMessage(msg: CrossTabMessage<T>): void {
    if (this.destroyed) return;

    switch (msg.type) {
      case 'REQUEST': {
        // Another tab is asking — if we're fetching the same key, ignore
        // If we're the leader role, we should claim and fetch
        const activeFetch = this.activeFetches.get(msg.key);
        if (activeFetch) {
          // We're already fetching, claim it
          this.channel?.postMessage({
            type: 'CLAIM',
            key: msg.key,
            requestId: msg.requestId,
            tabId: this.tabId,
          } satisfies CrossTabMessage<T>);
        }
        break;
      }
      case 'CLAIM': {
        // Another tab claimed this key
        // If we have a pending claim timer for this key, the other tab will handle it
        // This is handled implicitly — we just wait for RESPONSE
        break;
      }
      case 'RESPONSE': {
        const pending = this.pendingRequests.get(msg.key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.key);
          this._received++;
          pending.resolve(msg.data);
        }
        break;
      }
      case 'HEARTBEAT': {
        // Could be used for leader health checks — no-op for now
        break;
      }
    }
  }

  private async autoNegotiate(key: string, fn: () => Promise<T>): Promise<T> {
    const requestId = generateTabId();

    // Broadcast that we need this key
    this.channel!.postMessage({
      type: 'REQUEST',
      key,
      requestId,
      timestamp: Date.now(),
    } satisfies CrossTabMessage<T>);

    // Small window for another tab to claim (50ms)
    const claimWaitMs = Math.min(50, this.responseTimeoutMs);
    const claimed = await new Promise<boolean>((resolve) => {
      const handler = (event: MessageEvent) => {
        const msg = event.data as CrossTabMessage<T>;
        if (msg.type === 'CLAIM' && msg.key === key) {
          resolve(true);
        }
      };
      this.channel!.addEventListener('message', handler);
      setTimeout(() => {
        this.channel?.removeEventListener('message', handler);
        resolve(false);
      }, claimWaitMs);
    });

    if (claimed) {
      // Another tab is handling it — wait for response
      return this.waitForResponse(key, fn);
    }

    // No one claimed — we're the leader, claim + fetch
    this.channel!.postMessage({
      type: 'CLAIM',
      key,
      requestId,
      tabId: this.tabId,
    } satisfies CrossTabMessage<T>);

    return this.fetchAndBroadcast(key, fn);
  }

  private waitForResponse(key: string, fallbackFn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        this._timeouts++;
        // Timeout — fall back to fetching ourselves
        fallbackFn().then(resolve, reject);
      }, this.responseTimeoutMs);

      this.pendingRequests.set(key, { resolve, reject, timer, key });
    });
  }

  private async fetchAndBroadcast(key: string, fn: () => Promise<T>): Promise<T> {
    const requestId = generateTabId();

    const promise = fn().then(
      (data) => {
        this.activeFetches.delete(key);
        this._served++;
        // Broadcast result to other tabs
        if (this.channel && !this.destroyed) {
          try {
            this.channel.postMessage({
              type: 'RESPONSE',
              key,
              requestId,
              data,
              timestamp: Date.now(),
            } satisfies CrossTabMessage<T>);
          } catch {
            // channel may be closed
          }
        }
        return data;
      },
      (error) => {
        this.activeFetches.delete(key);
        throw error;
      },
    );

    this.activeFetches.set(key, { key, requestId, promise });
    return promise;
  }
}
