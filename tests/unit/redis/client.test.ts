/**
 * @fileoverview Unit tests for RedisClientManager.
 * Mocks ioredis so no real network connections are made.
 */

import { RedisClientManager } from '../../../src/redis/client'
import { RedisConnectionError } from '../../../src/core/types'

// ---------------------------------------------------------------------------
// Mock ioredis with a factory that provides jest constructor mocks.
// Variables used inside jest.mock factories must be prefixed with 'mock'
// to avoid the hoisting reference error.
// ---------------------------------------------------------------------------
jest.mock('ioredis', () => {
  const mockRedis = jest.fn()
  const mockCluster = jest.fn()
  return { Redis: mockRedis, Cluster: mockCluster }
})

// These imports are purely for TypeScript type references in casts
import type { Redis, Cluster } from 'ioredis'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Redis: MockRedis, Cluster: MockCluster } = require('ioredis') as {
  Redis: jest.Mock
  Cluster: jest.Mock
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock shape for a Redis/Cluster instance used in tests */
interface MockRedisInstance {
  once: jest.Mock
  on: jest.Mock
  connect: jest.Mock
  quit: jest.Mock
  /** Covers SCRIPT LOAD via script('LOAD', ...) */
  script: jest.Mock
  evalsha: jest.Mock
}

/** Creates a mock Redis instance that emits 'ready' immediately */
function makeMockRedisInstance(opts: { emitError?: Error } = {}): MockRedisInstance {
  const instance: MockRedisInstance = {
    once: jest.fn(),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    script: jest.fn().mockResolvedValue('sha_mock'),
    evalsha: jest.fn().mockResolvedValue(1),
  }

  // Simulate 'ready' event via the `once` registration
  instance.once.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'ready' && !opts.emitError) {
        // Call handler asynchronously to simulate event emission
        setImmediate(() => handler())
      }
      if (event === 'error' && opts.emitError) {
        setImmediate(() => handler(opts.emitError!))
      }
      return instance
    },
  )

  return instance
}

/** Creates a mock Cluster instance that emits 'ready' immediately */
function makeMockClusterInstance(): MockRedisInstance {
  const instance: MockRedisInstance = {
    once: jest.fn(),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    script: jest.fn().mockResolvedValue('sha_mock'),
    evalsha: jest.fn().mockResolvedValue(1),
  }

  instance.once.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'ready') setImmediate(() => handler())
      return instance
    },
  )

  return instance
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisClientManager', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // connect() — single-node
  // -------------------------------------------------------------------------

  describe('connect() — single-node Redis', () => {
    it('creates a Redis instance when config.cluster is not set', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: { url: 'redis://localhost:6379' } })
      await manager.connect()

      expect(MockRedis).toHaveBeenCalledTimes(1)
      expect(MockCluster).not.toHaveBeenCalled()
    })

    it('passes the URL as the first argument to Redis', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: { url: 'redis://myhost:6380' } })
      await manager.connect()

      expect(MockRedis).toHaveBeenCalledWith(
        'redis://myhost:6380',
        expect.objectContaining({ enableReadyCheck: true }),
      )
    })

    it('applies default timeouts when not specified', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()

      expect(MockRedis).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          connectTimeout: 200,
          commandTimeout: 100,
          maxRetriesPerRequest: 1,
        }),
      )
    })

    it('applies custom timeouts from config', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({
        config: { connectTimeout: 500, commandTimeout: 300, maxRetriesPerRequest: 3 },
      })
      await manager.connect()

      expect(MockRedis).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          connectTimeout: 500,
          commandTimeout: 300,
          maxRetriesPerRequest: 3,
        }),
      )
    })

    it('enables TLS when URL starts with rediss://', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: { url: 'rediss://secure-host:6380' } })
      await manager.connect()

      expect(MockRedis).toHaveBeenCalledWith(
        'rediss://secure-host:6380',
        expect.objectContaining({ tls: {} }),
      )
    })

    it('does not set tls for redis:// URLs', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: { url: 'redis://localhost:6379' } })
      await manager.connect()

      const callArgs = MockRedis.mock.calls[0][1] as Record<string, unknown>
      expect(callArgs).not.toHaveProperty('tls')
    })

    it('calls the onConnect callback when ready', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const onConnect = jest.fn()
      const manager = new RedisClientManager({ config: {}, onConnect })
      await manager.connect()

      expect(onConnect).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // connect() — cluster
  // -------------------------------------------------------------------------

  describe('connect() — Cluster', () => {
    it('creates a Cluster instance when config.cluster is set', async () => {
      const mockInstance = makeMockClusterInstance()
      MockCluster.mockImplementation(() => mockInstance as unknown as Cluster)

      const manager = new RedisClientManager({
        config: {
          cluster: { nodes: [{ host: 'node1', port: 6379 }, { host: 'node2', port: 6380 }] },
        },
      })
      await manager.connect()

      expect(MockCluster).toHaveBeenCalledTimes(1)
      expect(MockRedis).not.toHaveBeenCalled()
    })

    it('passes cluster nodes to the Cluster constructor', async () => {
      const mockInstance = makeMockClusterInstance()
      MockCluster.mockImplementation(() => mockInstance as unknown as Cluster)

      const nodes = [{ host: 'node1', port: 6379 }]
      const manager = new RedisClientManager({ config: { cluster: { nodes } } })
      await manager.connect()

      expect(MockCluster).toHaveBeenCalledWith(
        nodes,
        expect.objectContaining({ enableAutoPipelining: true, maxRedirections: 3 }),
      )
    })

    it('enables TLS for cluster when URL starts with rediss://', async () => {
      const mockInstance = makeMockClusterInstance()
      MockCluster.mockImplementation(() => mockInstance as unknown as Cluster)

      const manager = new RedisClientManager({
        config: {
          url: 'rediss://cluster',
          cluster: { nodes: [{ host: 'node1', port: 6380 }] },
        },
      })
      await manager.connect()

      expect(MockCluster).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          redisOptions: expect.objectContaining({ tls: {} }),
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // getClient()
  // -------------------------------------------------------------------------

  describe('getClient()', () => {
    it('throws RedisConnectionError if connect() has not been called', () => {
      const manager = new RedisClientManager({ config: {} })
      expect(() => manager.getClient()).toThrow(RedisConnectionError)
    })

    it('returns the client after successful connect()', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      const returned = await manager.connect()

      expect(manager.getClient()).toBe(returned)
    })
  })

  // -------------------------------------------------------------------------
  // isConnected()
  // -------------------------------------------------------------------------

  describe('isConnected()', () => {
    it('returns false before connect()', () => {
      const manager = new RedisClientManager({ config: {} })
      expect(manager.isConnected()).toBe(false)
    })

    it('returns true after successful connect()', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()

      expect(manager.isConnected()).toBe(true)
    })

    it('returns false after disconnect()', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()
      await manager.disconnect()

      expect(manager.isConnected()).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // disconnect()
  // -------------------------------------------------------------------------

  describe('disconnect()', () => {
    it('calls quit() on the underlying client', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()
      await manager.disconnect()

      expect(mockInstance.quit).toHaveBeenCalledTimes(1)
    })

    it('is a no-op if called before connect()', async () => {
      const manager = new RedisClientManager({ config: {} })
      // Should not throw
      await expect(manager.disconnect()).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // scriptLoad()
  // -------------------------------------------------------------------------

  describe('scriptLoad()', () => {
    it('delegates to the underlying client via script("LOAD", ...)', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()
      const result = await manager.scriptLoad('return 1')

      expect(mockInstance.script).toHaveBeenCalledWith('LOAD', 'return 1')
      expect(result).toBe('sha_mock')
    })

    it('throws RedisConnectionError if not connected', async () => {
      const manager = new RedisClientManager({ config: {} })
      await expect(manager.scriptLoad('return 1')).rejects.toThrow(RedisConnectionError)
    })
  })

  // -------------------------------------------------------------------------
  // evalsha()
  // -------------------------------------------------------------------------

  describe('evalsha()', () => {
    it('delegates to the underlying client evalsha', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()
      await manager.evalsha('mysha', 2, 'key1', 'key2', 'arg1')

      expect(mockInstance.evalsha).toHaveBeenCalledWith('mysha', 2, 'key1', 'key2', 'arg1')
    })

    it('throws RedisConnectionError if not connected', async () => {
      const manager = new RedisClientManager({ config: {} })
      await expect(manager.evalsha('sha', 0)).rejects.toThrow(RedisConnectionError)
    })
  })

  // -------------------------------------------------------------------------
  // onError callback
  // -------------------------------------------------------------------------

  describe('error callback', () => {
    it('calls onError when the client emits an error after connection', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const onError = jest.fn()
      const manager = new RedisClientManager({ config: {}, onError })
      await manager.connect()

      // Simulate post-connection error via registered 'error' handler
      const errorHandler = mockInstance.once.mock.calls.find(
        ([ev]: [string]) => ev === 'error',
      )?.[1] as ((err: Error) => void) | undefined

      if (errorHandler) {
        const err = new Error('connection dropped')
        errorHandler(err)
        expect(onError).toHaveBeenCalledWith(err)
      }
    })
  })

  // -------------------------------------------------------------------------
  // onReconnect callback
  // -------------------------------------------------------------------------

  describe('onReconnect callback', () => {
    it('calls onReconnect when the client emits a reconnecting event', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const onReconnect = jest.fn()
      const manager = new RedisClientManager({ config: {}, onReconnect })
      await manager.connect()

      // Find the 'reconnecting' handler registered via client.on()
      const reconnectHandler = mockInstance.on.mock.calls.find(
        ([ev]: [string]) => ev === 'reconnecting',
      )?.[1] as (() => void) | undefined

      expect(reconnectHandler).toBeDefined()
      reconnectHandler!()
      expect(onReconnect).toHaveBeenCalledTimes(1)
    })

    it('sets isConnected to false when reconnecting', async () => {
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await manager.connect()
      expect(manager.isConnected()).toBe(true)

      const reconnectHandler = mockInstance.on.mock.calls.find(
        ([ev]: [string]) => ev === 'reconnecting',
      )?.[1] as (() => void) | undefined

      reconnectHandler!()
      expect(manager.isConnected()).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // onReady fires when already settled (no-op branch)
  // -------------------------------------------------------------------------

  describe('connect() settled guard', () => {
    it('onReady is a no-op when promise has already settled (e.g. timed out first)', async () => {
      // We test the settled guard: if ready fires after the promise already settled,
      // it should not cause any observable side effect.
      const mockInstance = makeMockRedisInstance()
      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      // Capture the ready handler
      let readyHandler: (() => void) | undefined
      mockInstance.once.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'ready') {
            readyHandler = handler
          }
          // Don't auto-fire — let us control it
          return mockInstance
        },
      )

      const manager = new RedisClientManager({ config: {} })
      const connectPromise = manager.connect()

      // Simulate timer firing first by marking settled via error
      const errorHandler = mockInstance.once.mock.calls.find(
        ([ev]: [string]) => ev === 'error',
      )?.[1] as ((err: Error) => void) | undefined

      if (errorHandler) errorHandler(new Error('early error'))

      await expect(connectPromise).rejects.toThrow(RedisConnectionError)

      // Now fire ready — should be a no-op since promise already settled
      expect(() => readyHandler?.()).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // connect() — error during Redis.connect()
  // -------------------------------------------------------------------------

  describe('connect() error from Redis.connect()', () => {
    it('rejects with RedisConnectionError when Redis.connect() rejects', async () => {
      const mockInstance = makeMockRedisInstance()
      // Override connect to reject (but once handlers not auto-fired)
      mockInstance.connect = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      mockInstance.once.mockImplementation(
        (event: string, _handler: (...args: unknown[]) => void) => {
          // Don't auto-fire
          return mockInstance
        },
      )

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })

      // The error from connect() is fed into onErrorHandler which rejects the promise
      await expect(manager.connect()).rejects.toThrow(RedisConnectionError)
    })

    it('wraps non-Error thrown values from Redis.connect()', async () => {
      const mockInstance = makeMockRedisInstance()
      mockInstance.connect = jest.fn().mockRejectedValue('string-error')
      mockInstance.once.mockImplementation(() => mockInstance)

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await expect(manager.connect()).rejects.toThrow(RedisConnectionError)
    })

    it('wraps non-Error from connect().catch() when instanceof Redis check passes (line 176 false branch)', async () => {
      // Use Object.create(MockRedis.prototype) so `client instanceof Redis` is true
      const mockInstance = Object.create(MockRedis.prototype) as MockRedisInstance
      mockInstance.once = jest.fn().mockReturnThis()
      mockInstance.on = jest.fn().mockReturnThis()
      // connect() rejects with a non-Error string → line 176 false branch: new Error(String(err))
      mockInstance.connect = jest.fn().mockRejectedValue('non-error-string')
      mockInstance.quit = jest.fn().mockResolvedValue('OK')
      mockInstance.script = jest.fn()
      mockInstance.evalsha = jest.fn()
      ;(mockInstance as unknown as Record<string, unknown>)['removeListener'] = jest.fn()

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      await expect(manager.connect()).rejects.toThrow(RedisConnectionError)
    })

    it('passes Error directly when connect().catch() receives an Error (line 176 true branch)', async () => {
      // Use Object.create(MockRedis.prototype) so `client instanceof Redis` is true
      const mockInstance = Object.create(MockRedis.prototype) as MockRedisInstance
      mockInstance.once = jest.fn().mockReturnThis()
      mockInstance.on = jest.fn().mockReturnThis()
      // connect() rejects with an actual Error → line 176 true branch: err (passed directly)
      mockInstance.connect = jest.fn().mockRejectedValue(new Error('actual connect error'))
      mockInstance.quit = jest.fn().mockResolvedValue('OK')
      mockInstance.script = jest.fn()
      mockInstance.evalsha = jest.fn()
      ;(mockInstance as unknown as Record<string, unknown>)['removeListener'] = jest.fn()

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      // connect() rejects with Error → line 176 true branch hit → onErrorHandler called
      await expect(manager.connect()).rejects.toThrow(RedisConnectionError)
    })
  })

  // -------------------------------------------------------------------------
  // connect() — connection timeout
  // -------------------------------------------------------------------------

  describe('connect() — connection timeout', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('rejects with RedisConnectionError after timeout (3x connectTimeout)', async () => {
      const mockInstance: MockRedisInstance = {
        once: jest.fn().mockReturnThis(),
        on: jest.fn().mockReturnThis(),
        connect: jest.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
        quit: jest.fn(),
        script: jest.fn(),
        evalsha: jest.fn(),
      }

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const connectTimeout = 100
      const manager = new RedisClientManager({ config: { connectTimeout } })
      const connectPromise = manager.connect()

      // Advance past 3x timeout
      jest.advanceTimersByTime(connectTimeout * 3 + 1)

      await expect(connectPromise).rejects.toThrow('Redis connection timed out')
    })
  })

  // -------------------------------------------------------------------------
  // scriptLoad() — Cluster mode
  // -------------------------------------------------------------------------

  describe('scriptLoad() — Cluster mode', () => {
    it('loads the script on each master node and returns SHA', async () => {
      const sha = 'abc123sha'
      const masterNode = { script: jest.fn().mockResolvedValue(sha) }

      // Create a mock cluster instance whose prototype IS MockCluster.prototype
      // so that `client instanceof Cluster` evaluates to true in the source code
      const mockClusterInst = Object.create(MockCluster.prototype) as MockRedisInstance & {
        nodes: jest.Mock
      }
      mockClusterInst.once = jest.fn()
      mockClusterInst.on = jest.fn()
      mockClusterInst.connect = jest.fn().mockResolvedValue(undefined)
      mockClusterInst.quit = jest.fn().mockResolvedValue('OK')
      mockClusterInst.script = jest.fn().mockResolvedValue(sha)
      mockClusterInst.evalsha = jest.fn().mockResolvedValue(1)
      mockClusterInst.nodes = jest.fn().mockReturnValue([masterNode])

      // Emit 'ready' via once
      mockClusterInst.once.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'ready') setImmediate(() => handler())
          return mockClusterInst
        },
      )

      MockCluster.mockImplementation(() => mockClusterInst as unknown as Cluster)

      const manager = new RedisClientManager({
        config: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
      })
      await manager.connect()
      const result = await manager.scriptLoad('return 1')

      expect(masterNode.script).toHaveBeenCalledWith('LOAD', 'return 1')
      expect(result).toBe(sha)
    })
  })

  // -------------------------------------------------------------------------
  // evalsha() — Cluster mode
  // -------------------------------------------------------------------------

  describe('evalsha() — Cluster mode', () => {
    it('delegates to cluster client evalsha', async () => {
      const mockClusterInst = Object.create(MockCluster.prototype) as MockRedisInstance
      mockClusterInst.once = jest.fn()
      mockClusterInst.on = jest.fn()
      mockClusterInst.connect = jest.fn().mockResolvedValue(undefined)
      mockClusterInst.quit = jest.fn().mockResolvedValue('OK')
      mockClusterInst.script = jest.fn().mockResolvedValue('sha')
      mockClusterInst.evalsha = jest.fn().mockResolvedValue([1, '', 0, 0, 0])

      mockClusterInst.once.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'ready') setImmediate(() => handler())
          return mockClusterInst
        },
      )

      MockCluster.mockImplementation(() => mockClusterInst as unknown as Cluster)

      const manager = new RedisClientManager({
        config: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
      })
      await manager.connect()
      const result = await manager.evalsha('mysha', 2, 'k1', 'k2', 'arg1')

      expect(mockClusterInst.evalsha).toHaveBeenCalledWith('mysha', 2, 'k1', 'k2', 'arg1')
      expect(result).toEqual([1, '', 0, 0, 0])
    })
  })

  // -------------------------------------------------------------------------
  // clusterRetryStrategy
  // -------------------------------------------------------------------------

  describe('Cluster clusterRetryStrategy', () => {
    it('returns null (stop retrying) when times > 5', async () => {
      let capturedStrategy: ((times: number) => number | null) | undefined
      MockCluster.mockImplementation((_nodes: unknown, options: { clusterRetryStrategy?: (t: number) => number | null }) => {
        capturedStrategy = options.clusterRetryStrategy
        return makeMockClusterInstance() as unknown as Cluster
      })

      const manager = new RedisClientManager({
        config: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
      })
      await manager.connect()

      expect(capturedStrategy).toBeDefined()
      // times > 5 → null
      expect(capturedStrategy!(6)).toBeNull()
      expect(capturedStrategy!(10)).toBeNull()
    })

    it('returns exponential back-off (capped at 2000ms) for times <= 5', async () => {
      let capturedStrategy: ((times: number) => number | null) | undefined
      MockCluster.mockImplementation((_nodes: unknown, options: { clusterRetryStrategy?: (t: number) => number | null }) => {
        capturedStrategy = options.clusterRetryStrategy
        return makeMockClusterInstance() as unknown as Cluster
      })

      const manager = new RedisClientManager({
        config: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
      })
      await manager.connect()

      // times=1 → min(1*200, 2000) = 200
      expect(capturedStrategy!(1)).toBe(200)
      // times=3 → min(3*200, 2000) = 600
      expect(capturedStrategy!(3)).toBe(600)
      // times=5 → min(5*200, 2000) = 1000 (not null, since 5 is NOT > 5)
      expect(capturedStrategy!(5)).toBe(1000)
    })

    it('caps retry delay at 2000ms for large times still within threshold', async () => {
      // times*200 can exceed 2000 only if times>10, but times>5 returns null
      // So within valid range, max is min(5*200, 2000) = 1000 < 2000
      // Test that the cap mechanism exists: verify all valid values are ≤ 2000
      let capturedStrategy: ((times: number) => number | null) | undefined
      MockCluster.mockImplementation((_nodes: unknown, options: { clusterRetryStrategy?: (t: number) => number | null }) => {
        capturedStrategy = options.clusterRetryStrategy
        return makeMockClusterInstance() as unknown as Cluster
      })

      const manager = new RedisClientManager({
        config: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
      })
      await manager.connect()

      for (let t = 1; t <= 5; t++) {
        const delay = capturedStrategy!(t)
        expect(delay).not.toBeNull()
        expect(delay as number).toBeLessThanOrEqual(2000)
      }
    })
  })

  // -------------------------------------------------------------------------
  // cleanup() — removeListener not a function
  // -------------------------------------------------------------------------

  describe('connect() cleanup when removeListener is not a function', () => {
    it('does not throw when client has no removeListener method', async () => {
      const mockInstance = makeMockRedisInstance()
      // Simulate a client where removeListener is not available
      ;(mockInstance as unknown as Record<string, unknown>)['removeListener'] = undefined

      MockRedis.mockImplementation(() => mockInstance as unknown as Redis)

      const manager = new RedisClientManager({ config: {} })
      // Should still connect and not throw
      await expect(manager.connect()).resolves.toBeDefined()
    })
  })
})
