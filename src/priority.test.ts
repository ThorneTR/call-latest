import { describe, expect, it, vi } from "vitest";
import {
  PrioritySearchManager,
  type PriorityLevel,
  type PrioritySearchContext,
  type PrioritySearchOptions,
} from "./priority.js";

describe("PrioritySearchManager", () => {
  it("assigns default priority when none provided", () => {
    const mgr = new PrioritySearchManager();
    const { context } = mgr.evaluate("react");
    expect(context.priority).toBe(5);
  });

  it("uses custom default priority from options", () => {
    const mgr = new PrioritySearchManager({ defaultPriority: 3 });
    const { context } = mgr.evaluate("react");
    expect(context.priority).toBe(3);
  });

  it("uses explicit priority over default", () => {
    const mgr = new PrioritySearchManager({ defaultPriority: 3 });
    const { context } = mgr.evaluate("react", 9);
    expect(context.priority).toBe(9);
  });

  it("marks high priority and budget bypass when above threshold", () => {
    const mgr = new PrioritySearchManager({ budgetBypassThreshold: 8 });
    const low = mgr.evaluate("react", 5);
    const high = mgr.evaluate("urgent", 8);
    const veryHigh = mgr.evaluate("critical", 10);

    expect(low.context.shouldBypassBudget).toBe(false);
    expect(low.context.isHighPriority).toBe(false);
    expect(high.context.shouldBypassBudget).toBe(true);
    expect(high.context.isHighPriority).toBe(true);
    expect(veryHigh.context.shouldBypassBudget).toBe(true);
    expect(veryHigh.context.isHighPriority).toBe(true);
  });

  it("higher priority preempts lower priority via evaluate", () => {
    const mgr = new PrioritySearchManager();

    // First, set a high-priority pending query
    const high = mgr.evaluate("important", 9);
    expect(high.proceed).toBe(true);

    // A lower-priority query should NOT proceed
    const low = mgr.evaluate("trivial", 2);
    expect(low.proceed).toBe(false);
  });

  it("equal priority query replaces pending (newer wins)", () => {
    const mgr = new PrioritySearchManager();
    const first = mgr.evaluate("a", 5);
    const second = mgr.evaluate("b", 5);

    expect(first.proceed).toBe(true);
    expect(second.proceed).toBe(true);
    expect(mgr.isLatest(second.callId)).toBe(true);
    expect(mgr.isLatest(first.callId)).toBe(false);
  });

  it("higher priority query replaces lower pending", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("low", 2);
    const high = mgr.evaluate("high", 9);

    expect(high.proceed).toBe(true);
    expect(mgr.currentPending()?.query).toBe("high");
    expect(mgr.currentPending()?.priority).toBe(9);
  });

  it("preempt() returns true when new priority is higher", () => {
    const mgr = new PrioritySearchManager();
    const first = mgr.evaluate("low", 3);

    // preempt with higher priority, different callId
    const preempted = mgr.preempt(first.callId + 100, 9);
    expect(preempted).toBe(true);
    expect(mgr.currentPending()?.priority).toBe(9);
  });

  it("preempt() returns false when new priority is not higher", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("high", 9);

    const preempted = mgr.preempt(999, 5);
    expect(preempted).toBe(false);
  });

  it("preempt() returns false when no pending query", () => {
    const mgr = new PrioritySearchManager();
    const preempted = mgr.preempt(1, 10);
    expect(preempted).toBe(false);
  });

  it("preempt() cannot preempt itself", () => {
    const mgr = new PrioritySearchManager();
    const { callId } = mgr.evaluate("test", 5);

    const preempted = mgr.preempt(callId, 10);
    expect(preempted).toBe(false);
  });

  it("isLatest() tracks the most recent evaluation", () => {
    const mgr = new PrioritySearchManager();
    const a = mgr.evaluate("a", 5);
    expect(mgr.isLatest(a.callId)).toBe(true);

    const b = mgr.evaluate("b", 6);
    expect(mgr.isLatest(a.callId)).toBe(false);
    expect(mgr.isLatest(b.callId)).toBe(true);
  });

  it("reset clears all state", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("a", 5);
    mgr.evaluate("b", 9);
    mgr.preempt(999, 10);

    mgr.reset();

    expect(mgr.currentPending()).toBeNull();
    expect(mgr.stats().totalEvaluated).toBe(0);
    expect(mgr.stats().totalPreempted).toBe(0);
    expect(mgr.stats().totalBypassed).toBe(0);
  });

  it("stats tracks evaluation, preemption, and bypass counts", () => {
    const mgr = new PrioritySearchManager({ budgetBypassThreshold: 8 });

    mgr.evaluate("a", 5);  // not bypassed
    mgr.evaluate("b", 9);  // bypassed
    mgr.evaluate("c", 10); // bypassed
    mgr.preempt(999, 10);  // can't preempt: pending is already 10, same level

    const stats = mgr.stats();
    expect(stats.totalEvaluated).toBe(3);
    expect(stats.totalBypassed).toBe(2);
  });

  it("stats increments totalPreempted on successful preempt", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("low", 3);
    mgr.preempt(999, 9); // should succeed

    expect(mgr.stats().totalPreempted).toBe(1);
  });

  it("callId increments monotonically", () => {
    const mgr = new PrioritySearchManager();
    const a = mgr.evaluate("a");
    const b = mgr.evaluate("b");
    const c = mgr.evaluate("c");

    expect(a.callId).toBe(1);
    expect(b.callId).toBe(2);
    expect(c.callId).toBe(3);
  });

  it("callId resets to 0 after reset()", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("a");
    mgr.evaluate("b");
    mgr.reset();

    const result = mgr.evaluate("c");
    expect(result.callId).toBe(1);
  });

  it("currentPending returns a copy (not internal reference)", () => {
    const mgr = new PrioritySearchManager();
    mgr.evaluate("test", 7);

    const pending1 = mgr.currentPending();
    const pending2 = mgr.currentPending();

    expect(pending1).toEqual(pending2);
    expect(pending1).not.toBe(pending2);
  });

  it("clamps priority to 0–10 range", () => {
    const mgr = new PrioritySearchManager();
    const low = mgr.evaluate("low", -5);
    expect(low.context.priority).toBe(0);

    const high = mgr.evaluate("high", 99);
    expect(high.context.priority).toBe(10);
  });

  it("handles zero priority", () => {
    const mgr = new PrioritySearchManager();
    const result = mgr.evaluate("zero", 0);
    expect(result.context.priority).toBe(0);
    expect(result.context.shouldBypassBudget).toBe(false);
    expect(result.proceed).toBe(true);
  });

  it("handles max priority (10)", () => {
    const mgr = new PrioritySearchManager();
    const result = mgr.evaluate("max", 10);
    expect(result.context.priority).toBe(10);
    expect(result.context.shouldBypassBudget).toBe(true);
    expect(result.context.isHighPriority).toBe(true);
  });

  it("currentPending returns null before any evaluation", () => {
    const mgr = new PrioritySearchManager();
    expect(mgr.currentPending()).toBeNull();
  });

  it("supports maxConcurrentHighPriority option", () => {
    // Just verifying the option is accepted without errors
    const mgr = new PrioritySearchManager({ maxConcurrentHighPriority: 5 });
    const result = mgr.evaluate("test", 9);
    expect(result.proceed).toBe(true);
  });
});
