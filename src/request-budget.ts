/**
 * Request Budgeting — Google's technique for aggressive optimization
 * during rapid typing.
 *
 * When user types r→re→rea→reac→react:
 * - With bad network: only `r` and `react` get sent
 * - With good network: more intermediate queries allowed
 * - Budget adapts to network quality and server load
 *
 * @module
 */

export type NetworkQuality = "excellent" | "good" | "fair" | "poor" | "offline";

export type RequestBudgetOptions = {
  /** Maximum requests allowed within the sliding window. @default 10 */
  maxRequestsPerWindow?: number;
  /** Sliding window duration in milliseconds. @default 2000 */
  windowMs?: number;
  /** Minimum interval between requests in milliseconds. @default 100 */
  minIntervalMs?: number;
  /** Function returning the current network quality. @default () => 'good' */
  networkQualityFn?: () => NetworkQuality;
  /** Fraction (0–1) of budget consumed before aggressive dropping kicks in. @default 0.5 */
  aggressiveDropThreshold?: number;
  /** Called when a query is dropped by the budget system. */
  onDrop?: (query: string, reason: string) => void;
  /** Called when the budget is fully exhausted for the current window. */
  onBudgetExhausted?: () => void;
};

export type BudgetStats = {
  sent: number;
  dropped: number;
  remaining: number;
  windowStart: number;
  currentNetworkQuality: NetworkQuality;
  dropRate: number;
};

/**
 * Network quality scaling factors.
 * Better network → more budget, worse network → fewer tokens.
 */
const NETWORK_SCALE: Record<NetworkQuality, number> = {
  excellent: 1.0,
  good: 0.8,
  fair: 0.5,
  poor: 0.25,
  offline: 0,
};

/**
 * Minimum priority to bypass budget entirely.
 * Queries with priority >= this value always proceed.
 */
const PRIORITY_BYPASS_THRESHOLD = 8;

/**
 * Request budget manager implementing a sliding-window token bucket
 * with network-aware scaling and intermediate-query detection.
 */
export class RequestBudgetManager {
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;
  private readonly minIntervalMs: number;
  private readonly networkQualityFn: () => NetworkQuality;
  private readonly aggressiveDropThreshold: number;
  private readonly onDrop?: (query: string, reason: string) => void;
  private readonly onBudgetExhausted?: () => void;

  private windowStart: number;
  private sentTimestamps: number[] = [];
  private totalSent = 0;
  private totalDropped = 0;
  private lastSentAt = 0;
  private currentNetworkQuality: NetworkQuality = "good";
  private effectiveBudget: number;
  private exhaustedFired = false;

  constructor(options: RequestBudgetOptions = {}) {
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 10;
    this.windowMs = options.windowMs ?? 2000;
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.networkQualityFn = options.networkQualityFn ?? (() => "good" as NetworkQuality);
    this.aggressiveDropThreshold = options.aggressiveDropThreshold ?? 0.5;
    this.onDrop = options.onDrop;
    this.onBudgetExhausted = options.onBudgetExhausted;

    this.windowStart = Date.now();
    this.effectiveBudget = this.maxRequestsPerWindow;
    this.adjustForNetwork();
  }

  /**
   * Determine if a query can be sent given current budget constraints.
   *
   * Logic:
   * 1. High-priority queries (>= PRIORITY_BYPASS_THRESHOLD) always pass.
   * 2. Offline network blocks everything.
   * 3. Too-fast queries (within minIntervalMs) get dropped.
   * 4. Expired window tokens are pruned, then we check remaining budget.
   * 5. In aggressive-drop mode, intermediate queries get dropped.
   */
  canSend(query: string, priority?: number): boolean {
    // High-priority queries bypass everything
    if (priority !== undefined && priority >= PRIORITY_BYPASS_THRESHOLD) {
      return true;
    }

    // Update network quality
    this.adjustForNetwork();

    // Offline blocks all non-bypass traffic
    if (this.currentNetworkQuality === "offline") {
      this.recordDrop(query, "offline");
      return false;
    }

    const now = Date.now();

    // Minimum interval enforcement
    if (this.lastSentAt > 0 && now - this.lastSentAt < this.minIntervalMs) {
      this.recordDrop(query, "min_interval");
      return false;
    }

    // Prune expired timestamps (sliding window)
    this.pruneWindow(now);

    // Check budget
    const remaining = this.remainingBudget();
    if (remaining <= 0) {
      this.recordDrop(query, "budget_exhausted");
      if (!this.exhaustedFired) {
        this.exhaustedFired = true;
        this.onBudgetExhausted?.();
      }
      return false;
    }

    // Aggressive drop mode: when budget is low and query looks intermediate
    const usedFraction = this.sentTimestamps.length / this.effectiveBudget;
    if (
      usedFraction >= this.aggressiveDropThreshold &&
      this.isIntermediateQuery(query)
    ) {
      this.recordDrop(query, "aggressive_drop");
      return false;
    }

    return true;
  }

  /**
   * Record that a request was actually sent.
   * Must be called after `canSend` returns true and the request is dispatched.
   */
  recordSent(): void {
    const now = Date.now();
    this.sentTimestamps.push(now);
    this.lastSentAt = now;
    this.totalSent++;
    this.exhaustedFired = false;
  }

  /**
   * Record a dropped query. Typically called internally, but exposed for
   * external callers that want to record drops from their own logic.
   */
  recordDrop(query: string, reason: string): void {
    this.totalDropped++;
    this.onDrop?.(query, reason);
  }

  /**
   * Re-evaluate network quality and recompute effective budget.
   * Called automatically by `canSend`, but can be invoked manually.
   */
  adjustForNetwork(): void {
    this.currentNetworkQuality = this.networkQualityFn();
    const scale = NETWORK_SCALE[this.currentNetworkQuality];
    this.effectiveBudget = Math.max(1, Math.floor(this.maxRequestsPerWindow * scale));
  }

  /**
   * Reset all budget state. Useful when search context changes entirely.
   */
  reset(): void {
    this.sentTimestamps = [];
    this.totalSent = 0;
    this.totalDropped = 0;
    this.lastSentAt = 0;
    this.windowStart = Date.now();
    this.exhaustedFired = false;
    this.adjustForNetwork();
  }

  /**
   * Get current budget statistics.
   */
  stats(): BudgetStats {
    this.pruneWindow(Date.now());
    const sent = this.sentTimestamps.length;
    const remaining = this.remainingBudget();
    const total = this.totalSent + this.totalDropped;
    return {
      sent: this.totalSent,
      dropped: this.totalDropped,
      remaining,
      windowStart: this.windowStart,
      currentNetworkQuality: this.currentNetworkQuality,
      dropRate: total === 0 ? 0 : this.totalDropped / total,
    };
  }

  /**
   * Return the number of requests that can still be sent in the current window.
   */
  remainingBudget(): number {
    this.pruneWindow(Date.now());
    return Math.max(0, this.effectiveBudget - this.sentTimestamps.length);
  }

  /**
   * Check if the budget is fully exhausted for the current window.
   */
  isExhausted(): boolean {
    return this.remainingBudget() <= 0;
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Remove timestamps that have fallen outside the sliding window.
   */
  private pruneWindow(now: number): void {
    const windowStart = now - this.windowMs;
    this.windowStart = windowStart;
    // Remove timestamps older than the window
    while (this.sentTimestamps.length > 0 && this.sentTimestamps[0]! < windowStart) {
      this.sentTimestamps.shift();
    }
  }

  /**
   * Heuristic: a query is "intermediate" (typing-in-progress) if it is
   * very short (1-2 chars) or ends with a character that suggests the user
   * is still typing (no whitespace after last word, very recent addition).
   *
   * This is intentionally simple — production systems would use keystroke
   * timing analysis and n-gram models.
   */
  private isIntermediateQuery(query: string): boolean {
    const trimmed = query.trim();
    // Very short queries are likely intermediate
    if (trimmed.length <= 2) {
      return true;
    }
    // Single partial word (no spaces) with length 3-4 is likely intermediate
    if (!trimmed.includes(" ") && trimmed.length <= 4) {
      return true;
    }
    return false;
  }
}
