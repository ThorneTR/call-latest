import { describe, expect, it, vi } from 'vitest';
import {
  NoopTelemetryProvider,
  ConsoleTelemetryProvider,
  CallLatestTelemetry,
} from './telemetry.js';
import type { TelemetryProvider, TelemetrySpan, TelemetryMetricType } from './telemetry.js';

describe('NoopTelemetryProvider', () => {
  it('does not throw on any operation', () => {
    const provider = new NoopTelemetryProvider();

    expect(() => {
      const span = provider.startSpan('test', { key: 'value' });
      span.addEvent('event', { x: 1 });
      span.setStatus('ok');
      span.setStatus('error', 'some error');
      span.end({ done: true });
    }).not.toThrow();
  });

  it('flush resolves without error', async () => {
    const provider = new NoopTelemetryProvider();
    await expect(provider.flush()).resolves.toBeUndefined();
  });

  it('recordMetric does not throw for any metric type', () => {
    const provider = new NoopTelemetryProvider();
    expect(() => provider.recordMetric('m', 1, 'counter')).not.toThrow();
    expect(() => provider.recordMetric('m', 2, 'histogram')).not.toThrow();
    expect(() => provider.recordMetric('m', 3, 'gauge')).not.toThrow();
  });
});

describe('ConsoleTelemetryProvider', () => {
  it('logs span lifecycle events', () => {
    const logs: string[] = [];
    const logger = (msg: string) => logs.push(msg);
    const provider = new ConsoleTelemetryProvider(logger);

    const span = provider.startSpan('search', { query: 'react' });
    span.addEvent('cache-check', { hit: false });
    span.setStatus('ok');
    span.end({ count: 5 });

    expect(logs.length).toBe(4);
    expect(logs[0]).toContain('span:start');
    expect(logs[0]).toContain('search');
    expect(logs[1]).toContain('span:event');
    expect(logs[1]).toContain('cache-check');
    expect(logs[2]).toContain('span:status');
    expect(logs[3]).toContain('span:end');
  });

  it('logs metric recording', () => {
    const logs: string[] = [];
    const logger = (msg: string) => logs.push(msg);
    const provider = new ConsoleTelemetryProvider(logger);

    provider.recordMetric('search_count', 42, 'counter', { env: 'test' });

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('metric:counter');
    expect(logs[0]).toContain('search_count=42');
  });

  it('flush logs a message', async () => {
    const logs: string[] = [];
    const logger = (msg: string) => logs.push(msg);
    const provider = new ConsoleTelemetryProvider(logger);

    await provider.flush();

    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('flush');
  });
});

describe('CallLatestTelemetry', () => {
  it('span lifecycle: start → addEvent → end', () => {
    const spans: string[] = [];
    const mockProvider: TelemetryProvider = {
      startSpan(name, attrs) {
        spans.push(`start:${name}`);
        return {
          end() { spans.push(`end:${name}`); },
          setStatus(status) { spans.push(`status:${status}`); },
          addEvent(event) { spans.push(`event:${event}`); },
        };
      },
      recordMetric() {},
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({ provider: mockProvider });
    const span = telemetry.onSearchStart('react');
    span.addEvent('fetch');
    span.setStatus('ok');
    span.end();

    expect(spans).toEqual([
      'start:call_latest.search',
      'event:fetch',
      'status:ok',
      'end:call_latest.search',
    ]);
  });

  it('records metrics for counter, histogram, and gauge', () => {
    const metrics: Array<{ name: string; value: number; type: TelemetryMetricType }> = [];
    const mockProvider: TelemetryProvider = {
      startSpan() {
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric(name, value, type) {
        metrics.push({ name, value, type });
      },
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({ provider: mockProvider });
    telemetry.onSearchStart('test'); // records counter
    telemetry.onSearchEnd('test', 100, false); // records histogram
    telemetry.onStreamBatch('test', 0, 10); // records histogram

    expect(metrics.some(m => m.type === 'counter')).toBe(true);
    expect(metrics.some(m => m.type === 'histogram')).toBe(true);
  });

  it('getStats() returns correct calculations', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onSearchStart('a');
    telemetry.onSearchEnd('a', 100, false);
    telemetry.onSearchStart('b');
    telemetry.onSearchEnd('b', 200, true);
    telemetry.onSearchStart('c');
    telemetry.onSearchEnd('c', 300, false);

    const stats = telemetry.getStats();
    expect(stats.totalSearches).toBe(3);
    expect(stats.avgLatencyMs).toBe(200);
  });

  it('calculates percentiles correctly', () => {
    const telemetry = new CallLatestTelemetry();

    // Add 100 latency values from 1 to 100
    for (let i = 1; i <= 100; i++) {
      telemetry.onSearchStart(`q${i}`);
      telemetry.onSearchEnd(`q${i}`, i, false);
    }

    const p50 = telemetry.getLatencyPercentile(50);
    const p95 = telemetry.getLatencyPercentile(95);
    const p99 = telemetry.getLatencyPercentile(99);

    // p50 should be around 50
    expect(p50).toBeGreaterThanOrEqual(49);
    expect(p50).toBeLessThanOrEqual(51);

    // p95 should be around 95
    expect(p95).toBeGreaterThanOrEqual(94);
    expect(p95).toBeLessThanOrEqual(96);

    // p99 should be around 99
    expect(p99).toBeGreaterThanOrEqual(98);
    expect(p99).toBeLessThanOrEqual(100);
  });

  it('returns 0 for percentile with no latencies', () => {
    const telemetry = new CallLatestTelemetry();
    expect(telemetry.getLatencyPercentile(50)).toBe(0);
    expect(telemetry.getLatencyPercentile(95)).toBe(0);
  });

  it('sampling skips some operations (50% rate)', () => {
    let metricCount = 0;
    const mockProvider: TelemetryProvider = {
      startSpan() {
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric() {
        metricCount++;
      },
      async flush() {},
    };

    // Use a fixed seed by mocking Math.random
    let callIndex = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      // Alternate between sampled (0.1) and not sampled (0.9)
      return (callIndex++ % 2 === 0) ? 0.1 : 0.9;
    };

    try {
      const telemetry = new CallLatestTelemetry({
        provider: mockProvider,
        sampleRate: 0.5,
      });

      // 10 searches - should only record ~half
      for (let i = 0; i < 10; i++) {
        telemetry.onSearchStart(`query${i}`);
      }

      // Should have recorded about half the searches
      // Each sampled onSearchStart records 1 metric (counter) + 1 startSpan
      // Unsampled ones record nothing via provider
      expect(metricCount).toBeLessThan(10);
      expect(metricCount).toBeGreaterThan(0);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('prefix customization works', () => {
    const metricNames: string[] = [];
    const mockProvider: TelemetryProvider = {
      startSpan(name) {
        metricNames.push(name);
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric(name) {
        metricNames.push(name);
      },
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({
      provider: mockProvider,
      prefix: 'my_app',
    });

    telemetry.onSearchStart('test');
    expect(metricNames.every(n => n.startsWith('my_app.'))).toBe(true);
  });

  it('reset clears all counters and latencies', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onSearchStart('a');
    telemetry.onSearchEnd('a', 100, false);
    telemetry.onCacheHit('a');
    telemetry.onCacheMiss('b');
    telemetry.onAbort('c', 1);
    telemetry.onStale('d', 2);
    telemetry.onError('e', new Error('test'));

    telemetry.reset();

    const stats = telemetry.getStats();
    expect(stats.totalSearches).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.p50LatencyMs).toBe(0);
    expect(stats.cacheHitRate).toBe(0);
    expect(stats.staleCount).toBe(0);
    expect(stats.abortCount).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.totalCacheHits).toBe(0);
    expect(stats.totalCacheMisses).toBe(0);
  });

  it('onSearchStart/onSearchEnd flow updates totalSearches', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onSearchStart('react');
    telemetry.onSearchEnd('react', 50, false);
    telemetry.onSearchStart('vue');
    telemetry.onSearchEnd('vue', 30, true);

    const stats = telemetry.getStats();
    expect(stats.totalSearches).toBe(2);
  });

  it('cache hit/miss tracking', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onCacheHit('react');
    telemetry.onCacheHit('react', 'l1');
    telemetry.onCacheMiss('vue');

    const stats = telemetry.getStats();
    expect(stats.totalCacheHits).toBe(2);
    expect(stats.totalCacheMisses).toBe(1);
    expect(stats.cacheHitRate).toBeCloseTo(2 / 3);
  });

  it('abort counting', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onAbort('react', 1);
    telemetry.onAbort('vue', 2);

    const stats = telemetry.getStats();
    expect(stats.abortCount).toBe(2);
  });

  it('stale counting', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onStale('react', 1);
    telemetry.onStale('react', 2);
    telemetry.onStale('react', 3);

    const stats = telemetry.getStats();
    expect(stats.staleCount).toBe(3);
  });

  it('error counting', () => {
    const telemetry = new CallLatestTelemetry();

    telemetry.onError('react', new Error('network'));
    telemetry.onError('vue', 'string error');

    const stats = telemetry.getStats();
    expect(stats.errorCount).toBe(2);
  });

  it('retry tracking records metrics', () => {
    const metricNames: string[] = [];
    const mockProvider: TelemetryProvider = {
      startSpan() {
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric(name) {
        metricNames.push(name);
      },
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({ provider: mockProvider });

    telemetry.onRetry('react', 1, 100);
    telemetry.onRetry('react', 2, 200);

    expect(metricNames.filter(n => n.includes('retries_total')).length).toBe(2);
    expect(metricNames.filter(n => n.includes('retry_delay_ms')).length).toBe(2);
  });

  it('stream batch tracking records metrics', () => {
    const values: number[] = [];
    const mockProvider: TelemetryProvider = {
      startSpan() {
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric(_name, value) {
        values.push(value);
      },
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({ provider: mockProvider });
    telemetry.onStreamBatch('q', 0, 5);
    telemetry.onStreamBatch('q', 1, 10);

    expect(values).toEqual([5, 10]);
  });

  it('custom labels are passed to provider', () => {
    const labelSets: Array<Record<string, string> | undefined> = [];
    const mockProvider: TelemetryProvider = {
      startSpan() {
        return { end() {}, setStatus() {}, addEvent() {} };
      },
      recordMetric(_name, _value, _type, labels) {
        labelSets.push(labels);
      },
      async flush() {},
    };

    const telemetry = new CallLatestTelemetry({
      provider: mockProvider,
      customLabels: { env: 'production', service: 'search' },
    });

    telemetry.onSearchStart('test');

    expect(labelSets.length).toBeGreaterThan(0);
    expect(labelSets[0]).toMatchObject({ env: 'production', service: 'search' });
  });

  it('getStats p50/p95/p99 are in stats output', () => {
    const telemetry = new CallLatestTelemetry();

    for (let i = 1; i <= 20; i++) {
      telemetry.onSearchStart(`q${i}`);
      telemetry.onSearchEnd(`q${i}`, i * 10, false);
    }

    const stats = telemetry.getStats();
    expect(stats.p50LatencyMs).toBeGreaterThan(0);
    expect(stats.p95LatencyMs).toBeGreaterThan(stats.p50LatencyMs);
    expect(stats.p99LatencyMs).toBeGreaterThanOrEqual(stats.p95LatencyMs);
  });

  it('disabled tracking features do not count', () => {
    const telemetry = new CallLatestTelemetry({
      enableLatencyTracking: false,
      enableCacheTracking: false,
      enableErrorTracking: false,
    });

    telemetry.onSearchStart('a');
    telemetry.onSearchEnd('a', 100, false);
    telemetry.onCacheHit('a');
    telemetry.onCacheMiss('b');
    telemetry.onError('c', new Error('test'));

    const stats = telemetry.getStats();
    // Latencies not tracked
    expect(stats.avgLatencyMs).toBe(0);
    // Cache not tracked
    expect(stats.totalCacheHits).toBe(0);
    expect(stats.totalCacheMisses).toBe(0);
    // Errors not tracked
    expect(stats.errorCount).toBe(0);
    // But searches are always tracked
    expect(stats.totalSearches).toBe(1);
  });
});
