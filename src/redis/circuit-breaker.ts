/**
 * @fileoverview Circuit breaker FSM for Redis operations.
 * Implements a closed/open/half-open state machine to prevent cascading failures
 * when ElastiCache becomes unavailable.
 */

/** Possible states for the circuit breaker */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open'

/** Configuration options for the CircuitBreaker */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before the circuit opens. Default: 5 */
  threshold: number
  /** Milliseconds to wait in open state before transitioning to half-open. Default: 10000 */
  recoveryTimeout: number
}

/**
 * Finite state machine circuit breaker for Redis operations.
 *
 * State transitions:
 * - `closed → open`:      when consecutive failure count reaches the threshold
 * - `open → half-open`:   when recoveryTimeout ms have elapsed since the last failure
 * - `half-open → closed`: on a successful Redis operation
 * - `half-open → open`:   on a failed Redis operation
 *
 * @example
 * ```typescript
 * const cb = new CircuitBreaker({ threshold: 3, recoveryTimeout: 5000 })
 * if (cb.allowRequest()) {
 *   try {
 *     await redisClient.ping()
 *     cb.recordSuccess()
 *   } catch (err) {
 *     cb.recordFailure()
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private readonly config: Required<CircuitBreakerConfig>

  /**
   * @param config Optional partial configuration; missing fields use defaults.
   */
  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      threshold: config?.threshold ?? 5,
      recoveryTimeout: config?.recoveryTimeout ?? 10_000,
    }
  }

  /**
   * Returns the current state of the circuit breaker.
   * @returns The current {@link CircuitBreakerState}.
   */
  getState(): CircuitBreakerState {
    return this.state
  }

  /**
   * Determines whether a request should be allowed through to Redis.
   *
   * - In `closed` state: always returns `true`.
   * - In `open` state: returns `false`, unless the recovery timeout has elapsed,
   *   in which case transitions to `half-open` and returns `true`.
   * - In `half-open` state: returns `true` to allow a single probe request.
   *
   * @returns `true` if the request should proceed, `false` if it should be short-circuited.
   */
  allowRequest(): boolean {
    switch (this.state) {
      case 'closed':
        return true

      case 'open': {
        const elapsed = Date.now() - this.lastFailureTime
        if (elapsed >= this.config.recoveryTimeout) {
          this.state = 'half-open'
          return true
        }
        return false
      }

      case 'half-open':
        return true
    }
  }

  /**
   * Records a successful Redis operation.
   *
   * - In `closed` state: resets the failure count to 0.
   * - In `half-open` state: transitions back to `closed` and resets all counters.
   * - In `open` state: no effect (success not expected without passing through half-open).
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
      this.failureCount = 0
      this.lastFailureTime = 0
    } else if (this.state === 'closed') {
      // Reset accumulating failures on any success
      this.failureCount = 0
    }
  }

  /**
   * Records a failed Redis operation.
   *
   * - In `closed` state: increments failure count; opens the circuit if threshold is reached.
   * - In `half-open` state: transitions back to `open` and records the failure time.
   * - In `open` state: updates the last failure time (keeps the circuit open).
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now()

    switch (this.state) {
      case 'closed':
        this.failureCount++
        if (this.failureCount >= this.config.threshold) {
          this.state = 'open'
        }
        break

      case 'half-open':
        this.state = 'open'
        break

      case 'open':
        // Already open; update lastFailureTime (already set above) to extend the timeout
        break
    }
  }

  /**
   * Resets the circuit breaker to the initial `closed` state.
   * Clears all failure counters. Useful for testing or manual admin overrides.
   */
  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.lastFailureTime = 0
  }
}
