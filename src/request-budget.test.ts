import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  RequestBudgetManager,
  type NetworkQuality,
  type RequestBudgetOptions,
  type BudgetStats,
} from "./request-budget.js";

describe("RequestBudgetManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within budget", () => {
    const mgr = new RequestBudgetManager({ maxRequestsPerWindow: 5 });
    expect(mgr.canSend("react")).toBe(true);
    mgr.recordSent();
    expect(mgr.remainingBudget()).toBe(3); // effective budget is 5 * 0.8 = 4, but one sent
  });

  it("enforces max requests per window", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 3,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    for (let i = 0; i < 3; i++) {
      expect(mgr.canSend(`query${i}`)).toBe(true);
      mgr.recordSent();
    }

    expect(mgr.canSend("overflow")).toBe(false);
    expect(mgr.isExhausted()).toBe(true);
  });

  it("resets budget when window expires", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 3,
      windowMs: 1000,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    // Fill up the budget
    for (let i = 0; i < 3; i++) {
      expect(mgr.canSend(`query${i}`)).toBe(true);
      mgr.recordSent();
    }
    expect(mgr.isExhausted()).toBe(true);

    // Advance past the window
    vi.advanceTimersByTime(1100);

    // Budget should be replenished
    expect(mgr.isExhausted()).toBe(false);
    expect(mgr.canSend("fresh")).toBe(true);
  });

  it("adjusts budget based on network quality", () => {
    let quality: NetworkQuality = "excellent";
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 10,
      minIntervalMs: 0,
      networkQualityFn: () => quality,
    });

    // Excellent: scale 1.0, budget = 10
    mgr.adjustForNetwork();
    expect(mgr.remainingBudget()).toBe(10);

    // Poor: scale 0.25, budget = 2
    quality = "poor";
    mgr.adjustForNetwork();
    expect(mgr.remainingBudget()).toBe(2);

    // Fair: scale 0.5, budget = 5
    quality = "fair";
    mgr.adjustForNetwork();
    expect(mgr.remainingBudget()).toBe(5);
  });

  it("blocks all traffic when offline", () => {
    const mgr = new RequestBudgetManager({
      networkQualityFn: () => "offline",
    });

    expect(mgr.canSend("react")).toBe(false);
  });

  it("high priority queries bypass budget", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 1,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    // Fill budget
    mgr.canSend("query1");
    mgr.recordSent();
    expect(mgr.isExhausted()).toBe(true);

    // High priority query (>= 8) should bypass
    expect(mgr.canSend("urgent", 8)).toBe(true);
    expect(mgr.canSend("critical", 10)).toBe(true);
  });

  it("calls onDrop when a query is dropped", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 1,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
      onDrop,
    });

    mgr.canSend("query1");
    mgr.recordSent();

    mgr.canSend("query2"); // should be dropped
    expect(onDrop).toHaveBeenCalledWith("query2", "budget_exhausted");
  });

  it("calls onBudgetExhausted when budget runs out", () => {
    const onBudgetExhausted = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 1,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
      onBudgetExhausted,
    });

    mgr.canSend("query1");
    mgr.recordSent();

    mgr.canSend("query2"); // triggers exhaustion
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);

    // Should only fire once per exhaustion period
    mgr.canSend("query3");
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
  });

  it("enforces minimum interval between requests", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      minIntervalMs: 200,
      networkQualityFn: () => "excellent",
      onDrop,
    });

    expect(mgr.canSend("query1")).toBe(true);
    mgr.recordSent();

    // Too soon — should be dropped
    vi.advanceTimersByTime(50);
    expect(mgr.canSend("query2")).toBe(false);
    expect(onDrop).toHaveBeenCalledWith("query2", "min_interval");

    // After interval passes, should be allowed
    vi.advanceTimersByTime(200);
    expect(mgr.canSend("query3")).toBe(true);
  });

  it("drops intermediate queries in aggressive mode", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 10,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
      aggressiveDropThreshold: 0.5,
      onDrop,
    });

    // Fill up to 50% of budget (5 of 10)
    for (let i = 0; i < 5; i++) {
      mgr.canSend(`query_${i}_long_enough`);
      mgr.recordSent();
    }

    // Now budget usage >= 50%. Short queries should be dropped.
    expect(mgr.canSend("re")).toBe(false);
    expect(onDrop).toHaveBeenCalledWith("re", "aggressive_drop");
  });

  it("stats reflect accurate counts", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 3,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    mgr.canSend("query1");
    mgr.recordSent();
    mgr.canSend("query2");
    mgr.recordSent();
    mgr.canSend("query3");
    mgr.recordSent();
    mgr.canSend("query4"); // dropped

    const stats = mgr.stats();
    expect(stats.sent).toBe(3);
    expect(stats.dropped).toBe(1);
    expect(stats.dropRate).toBe(0.25); // 1 dropped out of 4 total
    expect(stats.currentNetworkQuality).toBe("excellent");
  });

  it("simulates rapid typing r→re→rea→reac→react with good network", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 10,
      minIntervalMs: 50,
      networkQualityFn: () => "good",
      aggressiveDropThreshold: 0.5,
      onDrop,
    });

    // Simulate rapid typing with 30ms intervals
    const queries = ["r", "re", "rea", "reac", "react"];
    const results: boolean[] = [];

    for (const q of queries) {
      const canSend = mgr.canSend(q);
      results.push(canSend);
      if (canSend) {
        mgr.recordSent();
      }
      vi.advanceTimersByTime(30); // faster than minIntervalMs
    }

    // First query should pass; subsequent ones within minInterval get dropped
    expect(results[0]).toBe(true);

    // Some intermediate ones should be dropped due to interval enforcement
    const sentCount = results.filter(Boolean).length;
    const droppedCount = results.filter((r) => !r).length;

    expect(sentCount).toBeGreaterThanOrEqual(1);
    expect(droppedCount).toBeGreaterThanOrEqual(1);
  });

  it("simulates rapid typing with poor network (more drops)", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 10,
      minIntervalMs: 0,
      networkQualityFn: () => "poor",
      aggressiveDropThreshold: 0.3,
      onDrop,
    });

    // Poor network: budget = floor(10 * 0.25) = 2
    const queries = ["r", "re", "rea", "reac", "react"];
    let sent = 0;

    for (const q of queries) {
      if (mgr.canSend(q)) {
        mgr.recordSent();
        sent++;
      }
    }

    // With budget of 2 and aggressive drop, very few should get through
    expect(sent).toBeLessThanOrEqual(2);
    expect(onDrop).toHaveBeenCalled();
  });

  it("reset clears all counters and timestamps", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 2,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    mgr.canSend("query1");
    mgr.recordSent();
    mgr.canSend("query2");
    mgr.recordSent();
    expect(mgr.isExhausted()).toBe(true);

    mgr.reset();

    expect(mgr.isExhausted()).toBe(false);
    expect(mgr.remainingBudget()).toBeGreaterThan(0);
    expect(mgr.stats().sent).toBe(0);
    expect(mgr.stats().dropped).toBe(0);
  });

  it("isExhausted returns correct state", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 1,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    expect(mgr.isExhausted()).toBe(false);
    mgr.canSend("query1");
    mgr.recordSent();
    expect(mgr.isExhausted()).toBe(true);
  });

  it("intermediate query detection works for short queries", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 10,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
      aggressiveDropThreshold: 0.3,
      onDrop,
    });

    // Push budget usage past threshold
    for (let i = 0; i < 3; i++) {
      mgr.canSend(`long_query_${i}`);
      mgr.recordSent();
    }

    // Short query should be detected as intermediate
    expect(mgr.canSend("r")).toBe(false);
    expect(mgr.canSend("re")).toBe(false);

    // Longer queries should pass
    expect(mgr.canSend("react hooks tutorial")).toBe(true);
  });

  it("recordDrop can be called externally", () => {
    const onDrop = vi.fn();
    const mgr = new RequestBudgetManager({ onDrop });

    mgr.recordDrop("test", "custom_reason");
    expect(onDrop).toHaveBeenCalledWith("test", "custom_reason");
    expect(mgr.stats().dropped).toBe(1);
  });

  it("budget replenishes correctly with sliding window", () => {
    const mgr = new RequestBudgetManager({
      maxRequestsPerWindow: 2,
      windowMs: 500,
      minIntervalMs: 0,
      networkQualityFn: () => "excellent",
    });

    // Send two requests
    mgr.canSend("query1");
    mgr.recordSent();

    vi.advanceTimersByTime(200);
    mgr.canSend("query2");
    mgr.recordSent();

    expect(mgr.isExhausted()).toBe(true);

    // After 301ms more, first request falls out of window
    vi.advanceTimersByTime(301);
    expect(mgr.isExhausted()).toBe(false);
    expect(mgr.remainingBudget()).toBe(1);
  });

  it("stats dropRate is 0 when no queries processed", () => {
    const mgr = new RequestBudgetManager();
    expect(mgr.stats().dropRate).toBe(0);
  });
});
