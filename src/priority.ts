/**
 * Priority Search — allows callers to assign priority levels to queries.
 * Higher-priority queries survive aggressive cancellation and consume
 * more of the request budget.
 *
 * Usage:
 * ```ts
 * const mgr = new PrioritySearchManager({ budgetBypassThreshold: 8 });
 * const { proceed, context, callId } = mgr.evaluate('react', 10);
 * // context.shouldBypassBudget === true
 * ```
 *
 * @module
 */

/** Priority level from 0 (lowest) to 10 (highest). */
export type PriorityLevel = number;

export type PrioritySearchOptions = {
  /** Default priority for queries without explicit priority. @default 5 */
  defaultPriority?: PriorityLevel;
  /** Minimum priority required to bypass budget throttling. @default 8 */
  budgetBypassThreshold?: PriorityLevel;
  /** Maximum number of concurrent high-priority queries tracked. @default 3 */
  maxConcurrentHighPriority?: number;
};

export type PrioritySearchContext = {
  priority: PriorityLevel;
  shouldBypassBudget: boolean;
  isHighPriority: boolean;
};

type PendingQuery = {
  query: string;
  priority: PriorityLevel;
  callId: number;
  timestamp: number;
};

/**
 * Priority queue manager for search queries.
 *
 * Higher priority queries can preempt lower ones,
 * and queries above the bypass threshold skip budget restrictions.
 */
export class PrioritySearchManager {
  private readonly defaultPriority: PriorityLevel;
  private readonly budgetBypassThreshold: PriorityLevel;
  private readonly maxConcurrentHighPriority: number;
  private pending: PendingQuery | null = null;
  private callCounter = 0;
  private totalEvaluated = 0;
  private totalPreempted = 0;
  private totalBypassed = 0;

  constructor(options: PrioritySearchOptions = {}) {
    this.defaultPriority = clampPriority(options.defaultPriority ?? 5);
    this.budgetBypassThreshold = clampPriority(options.budgetBypassThreshold ?? 8);
    this.maxConcurrentHighPriority = options.maxConcurrentHighPriority ?? 3;
  }

  /**
   * Evaluate whether a new query should proceed or be dropped.
   * Returns context with resolved priority, budget bypass flag, and whether
   * the query is considered high priority.
   *
   * A query will NOT proceed if there is already a pending query with a
   * strictly higher priority that was registered recently (within 500ms).
   */
  evaluate(
    query: string,
    priority?: PriorityLevel,
  ): { proceed: boolean; context: PrioritySearchContext; callId: number } {
    const resolvedPriority = clampPriority(priority ?? this.defaultPriority);
    const callId = ++this.callCounter;
    this.totalEvaluated++;

    const shouldBypassBudget = resolvedPriority >= this.budgetBypassThreshold;
    const isHighPriority = resolvedPriority >= this.budgetBypassThreshold;

    if (shouldBypassBudget) {
      this.totalBypassed++;
    }

    const context: PrioritySearchContext = {
      priority: resolvedPriority,
      shouldBypassBudget,
      isHighPriority,
    };

    // If there's a pending query with strictly higher priority, drop the new one
    if (
      this.pending &&
      this.pending.priority > resolvedPriority &&
      Date.now() - this.pending.timestamp < 500
    ) {
      return { proceed: false, context, callId };
    }

    // New query wins — update pending
    this.pending = {
      query,
      priority: resolvedPriority,
      callId,
      timestamp: Date.now(),
    };

    return { proceed: true, context, callId };
  }

  /**
   * Check if a given callId is still the latest (not preempted).
   */
  isLatest(callId: number): boolean {
    return this.pending?.callId === callId;
  }

  /**
   * Attempt to preempt the current pending query with a new priority.
   * Returns `true` if the current pending query was successfully preempted
   * (i.e., the provided priority is strictly higher than the current pending).
   * Returns `false` if there is no pending query or if the provided priority
   * is not higher.
   */
  preempt(callId: number, priority: PriorityLevel): boolean {
    const resolvedPriority = clampPriority(priority);

    if (!this.pending) {
      return false;
    }

    // Cannot preempt yourself
    if (this.pending.callId === callId) {
      return false;
    }

    // Only preempt if the new priority is strictly higher
    if (resolvedPriority > this.pending.priority) {
      this.totalPreempted++;
      // Mark the old pending as preempted; the new callId takes over
      this.pending = {
        ...this.pending,
        callId,
        priority: resolvedPriority,
        timestamp: Date.now(),
      };
      return true;
    }

    return false;
  }

  /**
   * Clear all priority state and counters.
   */
  reset(): void {
    this.pending = null;
    this.callCounter = 0;
    this.totalEvaluated = 0;
    this.totalPreempted = 0;
    this.totalBypassed = 0;
  }

  /**
   * Get current pending query info, or null if nothing is pending.
   */
  currentPending(): { query: string; priority: PriorityLevel; callId: number } | null {
    if (!this.pending) return null;
    return {
      query: this.pending.query,
      priority: this.pending.priority,
      callId: this.pending.callId,
    };
  }

  /**
   * Return aggregate stats about evaluations, preemptions, and bypasses.
   */
  stats(): { totalEvaluated: number; totalPreempted: number; totalBypassed: number } {
    return {
      totalEvaluated: this.totalEvaluated,
      totalPreempted: this.totalPreempted,
      totalBypassed: this.totalBypassed,
    };
  }
}

/** Clamp a priority value to the valid 0–10 range. */
function clampPriority(value: number): PriorityLevel {
  return Math.max(0, Math.min(10, Math.round(value)));
}
