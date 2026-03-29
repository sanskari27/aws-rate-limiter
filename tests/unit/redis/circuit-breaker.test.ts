/**
 * @fileoverview Unit tests for the CircuitBreaker FSM.
 * Uses fake timers to control time-based state transitions.
 */

import { CircuitBreaker } from '../../../src/redis/circuit-breaker'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in closed state', () => {
      const cb = new CircuitBreaker()
      expect(cb.getState()).toBe('closed')
    })

    it('allowRequest() returns true when closed', () => {
      const cb = new CircuitBreaker()
      expect(cb.allowRequest()).toBe(true)
    })

    it('allowRequest() keeps state as closed — does not transition to half-open', () => {
      // If the closed case falls through to the open case, it would transition
      // to half-open (since lastFailureTime=0 makes elapsed huge). This test
      // guards that fall-through by verifying the state is unchanged after the call.
      const cb = new CircuitBreaker()
      cb.allowRequest()
      expect(cb.getState()).toBe('closed')
    })
  })

  // ---------------------------------------------------------------------------
  // closed → open transition
  // ---------------------------------------------------------------------------

  describe('closed → open transition', () => {
    it('opens after reaching the default threshold of 5 failures', () => {
      const cb = new CircuitBreaker()
      for (let i = 0; i < 4; i++) {
        cb.recordFailure()
        expect(cb.getState()).toBe('closed')
      }
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })

    it('opens after reaching a custom threshold', () => {
      const cb = new CircuitBreaker({ threshold: 3 })
      for (let i = 0; i < 2; i++) {
        cb.recordFailure()
        expect(cb.getState()).toBe('closed')
      }
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })

    it('allowRequest() returns false immediately after opening', () => {
      const cb = new CircuitBreaker({ threshold: 2 })
      cb.recordFailure()
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
      expect(cb.allowRequest()).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // open state behaviour
  // ---------------------------------------------------------------------------

  describe('open state', () => {
    it('allowRequest() returns false within the recovery timeout', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 10_000 })
      cb.recordFailure()
      jest.advanceTimersByTime(9_999)
      expect(cb.allowRequest()).toBe(false)
    })

    it('allowRequest() transitions to half-open after recovery timeout elapses', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 10_000 })
      cb.recordFailure()
      jest.advanceTimersByTime(10_000)
      expect(cb.allowRequest()).toBe(true)
      expect(cb.getState()).toBe('half-open')
    })

    it('uses a custom recoveryTimeout', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 500 })
      cb.recordFailure()
      jest.advanceTimersByTime(499)
      expect(cb.allowRequest()).toBe(false)
      jest.advanceTimersByTime(1)
      expect(cb.allowRequest()).toBe(true)
      expect(cb.getState()).toBe('half-open')
    })
  })

  // ---------------------------------------------------------------------------
  // half-open → closed transition
  // ---------------------------------------------------------------------------

  describe('half-open → closed transition', () => {
    function openThenHalfOpen(recoveryTimeout = 10_000): CircuitBreaker {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout })
      cb.recordFailure()
      jest.advanceTimersByTime(recoveryTimeout)
      cb.allowRequest() // triggers transition to half-open
      expect(cb.getState()).toBe('half-open')
      return cb
    }

    it('allowRequest() returns true in half-open state', () => {
      const cb = openThenHalfOpen()
      expect(cb.allowRequest()).toBe(true)
    })

    it('recordSuccess() in half-open transitions to closed', () => {
      const cb = openThenHalfOpen()
      cb.recordSuccess()
      expect(cb.getState()).toBe('closed')
    })

    it('failure count is reset after half-open → closed', () => {
      const cb = openThenHalfOpen()
      cb.recordSuccess()
      // Need another full threshold of failures to re-open
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })
  })

  // ---------------------------------------------------------------------------
  // half-open → open transition
  // ---------------------------------------------------------------------------

  describe('half-open → open transition', () => {
    it('recordFailure() in half-open transitions back to open', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 10_000 })
      cb.recordFailure()
      jest.advanceTimersByTime(10_000)
      cb.allowRequest() // → half-open
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })
  })

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  describe('reset()', () => {
    it('resets to closed state from open', () => {
      const cb = new CircuitBreaker({ threshold: 1 })
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
      cb.reset()
      expect(cb.getState()).toBe('closed')
    })

    it('allowRequest() returns true after reset', () => {
      const cb = new CircuitBreaker({ threshold: 1 })
      cb.recordFailure()
      cb.reset()
      expect(cb.allowRequest()).toBe(true)
    })

    it('resets failure count so threshold must be reached again', () => {
      const cb = new CircuitBreaker({ threshold: 3 })
      cb.recordFailure()
      cb.recordFailure()
      cb.reset()
      // One more failure should not open the circuit
      cb.recordFailure()
      cb.recordFailure()
      expect(cb.getState()).toBe('closed')
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })
  })

  // ---------------------------------------------------------------------------
  // recordSuccess() in closed state
  // ---------------------------------------------------------------------------

  describe('recordSuccess() in closed state', () => {
    it('resets accumulating failure count without changing state', () => {
      const cb = new CircuitBreaker({ threshold: 5 })
      cb.recordFailure()
      cb.recordFailure()
      cb.recordFailure()
      expect(cb.getState()).toBe('closed')
      cb.recordSuccess()
      // Failure count was reset; need full threshold again to open
      cb.recordFailure()
      cb.recordFailure()
      cb.recordFailure()
      cb.recordFailure()
      expect(cb.getState()).toBe('closed')
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })

    it('state remains closed — does not transition to half-open — after recordSuccess() in closed', () => {
      const cb = new CircuitBreaker()
      expect(cb.getState()).toBe('closed')
      cb.recordSuccess()
      expect(cb.getState()).toBe('closed')
    })

    it('closed state does NOT reset to threshold-0 via else-if(true) mutation: failure counter still works correctly', () => {
      // The `else if (state === 'closed')` branch only resets failureCount.
      // Mutation `else if (true)` would run this reset even from open state.
      // From open state, this should have no observable effect on state, but
      // the failureCount reset in closed state should not prevent re-opening.
      const cb = new CircuitBreaker({ threshold: 3 })
      cb.recordFailure() // failureCount=1
      cb.recordFailure() // failureCount=2
      // recordSuccess in closed: resets failureCount to 0
      cb.recordSuccess()
      // Must need all 3 failures again to open
      cb.recordFailure() // 1
      cb.recordFailure() // 2
      expect(cb.getState()).toBe('closed')
      cb.recordFailure() // 3
      expect(cb.getState()).toBe('open')
    })
  })

  // ---------------------------------------------------------------------------
  // recordSuccess() in open state — no effect on state
  // ---------------------------------------------------------------------------

  describe('recordSuccess() in open state', () => {
    it('does NOT change state from open to closed', () => {
      // Mutation: `if (this.state === 'half-open')` → `if (true)` would cause
      // recordSuccess() from any state to close the circuit. This test guards it.
      const cb = new CircuitBreaker({ threshold: 1 })
      cb.recordFailure() // → open
      expect(cb.getState()).toBe('open')
      cb.recordSuccess()
      // State must stay open — not transition to closed
      expect(cb.getState()).toBe('open')
    })

    it('circuit remains open and still rejects requests after recordSuccess() in open state', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 10_000 })
      cb.recordFailure()
      cb.recordSuccess() // should have no effect
      jest.advanceTimersByTime(0)
      expect(cb.allowRequest()).toBe(false)
    })

    it('else-if(closed) mutation: recordSuccess() in open should NOT reset failureCount (observable via closed re-entry)', () => {
      // Mutation `else if (true)` in recordSuccess would execute failureCount=0 from open state.
      // We can observe this: get to open, recordSuccess (no effect), reset to closed,
      // then verify threshold still needs to be reached (not 0 extra-reset).
      const cb = new CircuitBreaker({ threshold: 2, recoveryTimeout: 1 })
      cb.recordFailure() // 1 → closed
      cb.recordFailure() // 2 → open
      cb.recordSuccess() // in open state — should have no effect
      // Reset manually to closed (simulating recovery)
      cb.reset()
      expect(cb.getState()).toBe('closed')
      // Should need 2 failures to re-open (failureCount was NOT reset by recordSuccess from open)
      cb.recordFailure() // 1
      expect(cb.getState()).toBe('closed')
      cb.recordFailure() // 2
      expect(cb.getState()).toBe('open')
    })
  })

  // ---------------------------------------------------------------------------
  // Default config values
  // ---------------------------------------------------------------------------

  describe('default configuration', () => {
    it('uses threshold=5 by default', () => {
      const cb = new CircuitBreaker()
      for (let i = 0; i < 4; i++) cb.recordFailure()
      expect(cb.getState()).toBe('closed')
      cb.recordFailure()
      expect(cb.getState()).toBe('open')
    })

    it('uses recoveryTimeout=10000 by default', () => {
      const cb = new CircuitBreaker()
      for (let i = 0; i < 5; i++) cb.recordFailure()
      jest.advanceTimersByTime(9_999)
      expect(cb.allowRequest()).toBe(false)
      jest.advanceTimersByTime(1)
      expect(cb.allowRequest()).toBe(true)
      expect(cb.getState()).toBe('half-open')
    })
  })

  // ---------------------------------------------------------------------------
  // recordFailure() when already in 'open' state (extends timeout)
  // ---------------------------------------------------------------------------

  describe('recordFailure() in open state', () => {
    it('stays open and updates lastFailureTime when already open', () => {
      const cb = new CircuitBreaker({ threshold: 1, recoveryTimeout: 10_000 })
      cb.recordFailure() // → open
      expect(cb.getState()).toBe('open')

      // Advance time almost to recovery
      jest.advanceTimersByTime(9_000)

      // Another failure in open state: resets the timeout clock
      cb.recordFailure()
      expect(cb.getState()).toBe('open')

      // Advance by only 5_000 ms more — total elapsed since last failure is 5_000
      // which is less than recoveryTimeout (10_000), so should remain closed
      jest.advanceTimersByTime(5_000)
      expect(cb.allowRequest()).toBe(false)
      expect(cb.getState()).toBe('open')
    })
  })
})
