/**
 * OpenTelemetry-compatible observability for call-latest.
 *
 * Provides a pluggable provider interface that works with OpenTelemetry,
 * Datadog, or any custom telemetry backend. Includes built-in NoopProvider
 * and ConsoleProvider, sampling support, percentile calculations, and
 * span-based tracing.
 */

export type TelemetryMetricType = 'counter' | 'histogram' | 'gauge';

export interface TelemetrySpan {
  end(attributes?: Record<string, string | number | boolean>): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
}

export interface TelemetryProvider {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): TelemetrySpan;
  recordMetric(name: string, value: number, type: TelemetryMetricType, labels?: Record<string, string>): void;
  flush(): Promise<void>;
}

export type TelemetryOptions = {
  provider?: TelemetryProvider;
  prefix?: string;
  enableLatencyTracking?: boolean;
  enableCacheTracking?: boolean;
  enableErrorTracking?: boolean;
  sampleRate?: number;
  customLabels?: Record<string, string>;
};

export type TelemetryStats = {
  totalSearches: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  cacheHitRate: number;
  staleCount: number;
  abortCount: number;
  errorCount: number;
  totalCacheHits: number;
  totalCacheMisses: number;
};

// ─── Built-in Providers ──────────────────────────────────────────────

class NoopSpan implements TelemetrySpan {
  end(_attributes?: Record<string, string | number | boolean>): void { /* noop */ }
  setStatus(_status: 'ok' | 'error', _message?: string): void { /* noop */ }
  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void { /* noop */ }
}

/**
 * No-operation provider for when telemetry is not configured.
 * All methods are no-ops that never throw.
 */
export class NoopTelemetryProvider implements TelemetryProvider {
  startSpan(_name: string, _attributes?: Record<string, string | number | boolean>): TelemetrySpan {
    return new NoopSpan();
  }
  recordMetric(_name: string, _value: number, _type: TelemetryMetricType, _labels?: Record<string, string>): void {
    /* noop */
  }
  async flush(): Promise<void> {
    /* noop */
  }
}

/**
 * Console-based provider for debugging. Logs all spans and metrics
 * via `console.debug`.
 */
export class ConsoleTelemetryProvider implements TelemetryProvider {
  private readonly _log: (message: string, data?: unknown) => void;

  constructor(logger?: (message: string, data?: unknown) => void) {
    // eslint-disable-next-line no-console
    this._log = logger ?? ((msg, data) => console.debug(msg, data));
  }

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): TelemetrySpan {
    const startTime = Date.now();
    this._log(`[telemetry] span:start ${name}`, attributes);

    const log = this._log;
    return {
      end(endAttributes?: Record<string, string | number | boolean>): void {
        const durationMs = Date.now() - startTime;
        log(`[telemetry] span:end ${name} (${durationMs}ms)`, endAttributes);
      },
      setStatus(status: 'ok' | 'error', message?: string): void {
        log(`[telemetry] span:status ${name} ${status}`, { message });
      },
      addEvent(eventName: string, eventAttributes?: Record<string, string | number | boolean>): void {
        log(`[telemetry] span:event ${name}/${eventName}`, eventAttributes);
      },
    };
  }

  recordMetric(name: string, value: number, type: TelemetryMetricType, labels?: Record<string, string>): void {
    this._log(`[telemetry] metric:${type} ${name}=${value}`, labels);
  }

  async flush(): Promise<void> {
    this._log('[telemetry] flush');
  }
}

// ─── Main Telemetry Manager ──────────────────────────────────────────

export class CallLatestTelemetry {
  private readonly _provider: TelemetryProvider;
  private readonly _prefix: string;
  private readonly _enableLatency: boolean;
  private readonly _enableCache: boolean;
  private readonly _enableError: boolean;
  private readonly _sampleRate: number;
  private readonly _customLabels: Record<string, string>;

  // Counters
  private _totalSearches = 0;
  private _staleCount = 0;
  private _abortCount = 0;
  private _errorCount = 0;
  private _totalCacheHits = 0;
  private _totalCacheMisses = 0;

  // Latency tracking (sorted insertion not needed — we sort on read)
  private _latencies: number[] = [];

  constructor(options?: TelemetryOptions) {
    this._provider = options?.provider ?? new NoopTelemetryProvider();
    this._prefix = options?.prefix ?? 'call_latest';
    this._enableLatency = options?.enableLatencyTracking ?? true;
    this._enableCache = options?.enableCacheTracking ?? true;
    this._enableError = options?.enableErrorTracking ?? true;
    this._sampleRate = Math.max(0, Math.min(1, options?.sampleRate ?? 1.0));
    this._customLabels = options?.customLabels ?? {};
  }

  /** Returns true when this operation should be sampled (recorded). */
  private _shouldSample(): boolean {
    if (this._sampleRate >= 1) return true;
    if (this._sampleRate <= 0) return false;
    return Math.random() < this._sampleRate;
  }

  private _metricName(name: string): string {
    return `${this._prefix}.${name}`;
  }

  // ─── Lifecycle Hooks ─────────────────────────────────────────────

  onSearchStart(query: string): TelemetrySpan {
    this._totalSearches++;

    if (!this._shouldSample()) {
      return new NoopSpan();
    }

    this._provider.recordMetric(
      this._metricName('searches_total'),
      1,
      'counter',
      { ...this._customLabels, query },
    );

    return this._provider.startSpan(this._metricName('search'), {
      query,
      ...this._customLabels,
    });
  }

  onSearchEnd(query: string, durationMs: number, fromCache: boolean): void {
    if (this._enableLatency) {
      this._latencies.push(durationMs);
    }

    if (!this._shouldSample()) return;

    if (this._enableLatency) {
      this._provider.recordMetric(
        this._metricName('search_duration_ms'),
        durationMs,
        'histogram',
        { ...this._customLabels, query, cached: String(fromCache) },
      );
    }
  }

  onCacheHit(query: string, layer?: string): void {
    if (this._enableCache) {
      this._totalCacheHits++;
    }

    if (!this._shouldSample()) return;

    if (this._enableCache) {
      this._provider.recordMetric(
        this._metricName('cache_hits_total'),
        1,
        'counter',
        { ...this._customLabels, query, ...(layer ? { layer } : {}) },
      );
    }
  }

  onCacheMiss(query: string): void {
    if (this._enableCache) {
      this._totalCacheMisses++;
    }

    if (!this._shouldSample()) return;

    if (this._enableCache) {
      this._provider.recordMetric(
        this._metricName('cache_misses_total'),
        1,
        'counter',
        { ...this._customLabels, query },
      );
    }
  }

  onAbort(query: string, callId: number): void {
    this._abortCount++;

    if (!this._shouldSample()) return;

    this._provider.recordMetric(
      this._metricName('aborts_total'),
      1,
      'counter',
      { ...this._customLabels, query, callId: String(callId) },
    );
  }

  onStale(query: string, callId: number): void {
    this._staleCount++;

    if (!this._shouldSample()) return;

    this._provider.recordMetric(
      this._metricName('stale_total'),
      1,
      'counter',
      { ...this._customLabels, query, callId: String(callId) },
    );
  }

  onError(query: string, error: unknown): void {
    if (this._enableError) {
      this._errorCount++;
    }

    if (!this._shouldSample()) return;

    if (this._enableError) {
      const message = error instanceof Error ? error.message : String(error);
      this._provider.recordMetric(
        this._metricName('errors_total'),
        1,
        'counter',
        { ...this._customLabels, query, error: message },
      );
    }
  }

  onRetry(query: string, attempt: number, delayMs: number): void {
    if (!this._shouldSample()) return;

    this._provider.recordMetric(
      this._metricName('retries_total'),
      1,
      'counter',
      { ...this._customLabels, query, attempt: String(attempt) },
    );

    this._provider.recordMetric(
      this._metricName('retry_delay_ms'),
      delayMs,
      'histogram',
      { ...this._customLabels, query, attempt: String(attempt) },
    );
  }

  onStreamBatch(query: string, batchIndex: number, itemCount: number): void {
    if (!this._shouldSample()) return;

    this._provider.recordMetric(
      this._metricName('stream_batch_items'),
      itemCount,
      'histogram',
      { ...this._customLabels, query, batchIndex: String(batchIndex) },
    );
  }

  // ─── Stats ───────────────────────────────────────────────────────

  getStats(): TelemetryStats {
    const sorted = this._latencies.slice().sort((a, b) => a - b);
    const totalCacheOps = this._totalCacheHits + this._totalCacheMisses;

    return {
      totalSearches: this._totalSearches,
      avgLatencyMs: sorted.length > 0
        ? sorted.reduce((a, b) => a + b, 0) / sorted.length
        : 0,
      p50LatencyMs: this.getLatencyPercentile(50),
      p95LatencyMs: this.getLatencyPercentile(95),
      p99LatencyMs: this.getLatencyPercentile(99),
      cacheHitRate: totalCacheOps > 0 ? this._totalCacheHits / totalCacheOps : 0,
      staleCount: this._staleCount,
      abortCount: this._abortCount,
      errorCount: this._errorCount,
      totalCacheHits: this._totalCacheHits,
      totalCacheMisses: this._totalCacheMisses,
    };
  }

  /**
   * Compute the p-th percentile from recorded latencies.
   * @param p Percentile value (0-100)
   */
  getLatencyPercentile(p: number): number {
    if (this._latencies.length === 0) return 0;

    const sorted = this._latencies.slice().sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) return sorted[lower]!;

    const weight = index - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  }

  reset(): void {
    this._totalSearches = 0;
    this._staleCount = 0;
    this._abortCount = 0;
    this._errorCount = 0;
    this._totalCacheHits = 0;
    this._totalCacheMisses = 0;
    this._latencies = [];
  }
}
