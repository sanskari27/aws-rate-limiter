/**
 * @fileoverview ElastiCache / Redis connection manager using ioredis.
 * Supports both single-node Redis and cluster mode, with TLS detection,
 * configurable timeouts, and lifecycle callbacks.
 */

import { Cluster, Redis } from 'ioredis'
import type { RedisOptions, ClusterOptions, ClusterNode } from 'ioredis'
import { RedisConfig, RedisConnectionError } from '../core/types'

/** Union of the two ioredis client types returned by this manager */
export type RedisClient = Cluster | Redis

/** Options for constructing a {@link RedisClientManager} */
export interface RedisClientOptions {
  /** Redis / ElastiCache connection configuration */
  config: RedisConfig
  /** Called when the Redis connection becomes ready */
  onConnect?: () => void
  /** Called when a Redis connection error occurs */
  onError?: (err: Error) => void
  /** Called when the client begins reconnecting after a lost connection */
  onReconnect?: () => void
}

/** Default timeout values (milliseconds) */
const DEFAULTS = {
  connectTimeout: 200,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
} as const

/**
 * Manages the lifecycle of an ioredis `Redis` or `Cluster` client.
 *
 * - Uses `Cluster` when `config.cluster` is provided.
 * - Uses a single-node `Redis` connection otherwise.
 * - Enables TLS automatically for `rediss://` URLs.
 *
 * @example
 * ```typescript
 * const manager = new RedisClientManager({
 *   config: { url: 'redis://localhost:6379' },
 *   onConnect: () => console.log('Redis ready'),
 * })
 * const client = await manager.connect()
 * ```
 */
export class RedisClientManager {
  private client: RedisClient | null = null
  private connected = false
  private readonly options: RedisClientOptions

  /**
   * @param options Connection options including the {@link RedisConfig} and optional callbacks.
   */
  constructor(options: RedisClientOptions) {
    this.options = options
  }

  /**
   * Establishes the Redis connection.
   *
   * If `config.cluster` is set, creates a `Cluster` client with auto-pipelining
   * and up to 3 slot redirections. Otherwise creates a single-node `Redis` client.
   * TLS is enabled automatically when the URL starts with `rediss://`.
   *
   * Resolves once the client emits the `ready` event, or rejects with a
   * {@link RedisConnectionError} if the connection fails.
   *
   * @returns The connected {@link RedisClient} instance.
   * @throws {RedisConnectionError} If the connection cannot be established.
   */
  async connect(): Promise<RedisClient> {
    const { config, onConnect, onError, onReconnect } = this.options

    const connectTimeout = config.connectTimeout ?? DEFAULTS.connectTimeout
    const commandTimeout = config.commandTimeout ?? DEFAULTS.commandTimeout
    const maxRetriesPerRequest = config.maxRetriesPerRequest ?? DEFAULTS.maxRetriesPerRequest

    const useTls = Boolean(config.url?.startsWith('rediss://'))

    if (config.cluster) {
      const nodes: ClusterNode[] = config.cluster.nodes.map((n) => ({
        host: n.host,
        port: n.port,
      }))

      const clusterOptions: ClusterOptions = {
        enableAutoPipelining: true,
        maxRedirections: 3,
        redisOptions: {
          password: config.password,
          connectTimeout,
          commandTimeout,
          maxRetriesPerRequest,
          ...(useTls ? { tls: {} } : {}),
        },
        clusterRetryStrategy: (times: number) => {
          // Exponential back-off capped at 2 seconds, stop after 5 attempts
          if (times > 5) return null
          return Math.min(times * 200, 2000)
        },
      }

      this.client = new Cluster(nodes, clusterOptions)
    } else {
      const url = config.url ?? 'redis://localhost:6379'

      const redisOptions: RedisOptions = {
        password: config.password,
        connectTimeout,
        commandTimeout,
        maxRetriesPerRequest,
        enableReadyCheck: true,
        lazyConnect: true,
        ...(useTls ? { tls: {} } : {}),
      }

      this.client = new Redis(url, redisOptions)
    }

    return new Promise<RedisClient>((resolve, reject) => {
      const client = this.client!
      let settled = false
      const timeoutMs = connectTimeout * 3

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          reject(new RedisConnectionError(`Redis connection timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      timer.unref()

      const cleanup = () => {
        clearTimeout(timer)
        if (typeof client.removeListener === 'function') {
          client.removeListener('ready', onReady)
          client.removeListener('error', onErrorHandler)
        }
      }

      const onReady = () => {
        if (settled) return
        settled = true
        cleanup()
        this.connected = true
        onConnect?.()
        resolve(client)
      }

      const onErrorHandler = (err: Error) => {
        if (!settled) {
          settled = true
          cleanup()
          this.connected = false
          reject(new RedisConnectionError(`Failed to connect to Redis: ${err.message}`))
        }
        onError?.(err)
      }

      const onReconnecting = () => {
        this.connected = false
        onReconnect?.()
      }

      client.once('ready', onReady)
      client.once('error', onErrorHandler)
      client.on('reconnecting', onReconnecting)

      // For single-node with lazyConnect, we must explicitly trigger the connection
      if (client instanceof Redis) {
        client.connect().catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err))
          onErrorHandler(error)
        })
      }
    })
  }

  /**
   * Returns the active Redis client.
   *
   * @returns The connected {@link RedisClient}.
   * @throws {RedisConnectionError} If `connect()` has not been called yet.
   */
  getClient(): RedisClient {
    if (this.client === null) {
      throw new RedisConnectionError(
        'Redis client is not connected. Call connect() before getClient().',
      )
    }
    return this.client
  }

  /**
   * Gracefully disconnects from Redis by calling `quit()`.
   * Marks the client as disconnected and nulls the internal reference.
   */
  async disconnect(): Promise<void> {
    if (this.client !== null) {
      await this.client.quit()
      this.connected = false
      this.client = null
    }
  }

  /**
   * Returns whether the client is currently in the connected/ready state.
   * @returns `true` if the client is ready to accept commands.
   */
  isConnected(): boolean {
    return this.connected && this.client !== null
  }

  /**
   * Executes `SCRIPT LOAD` to register a Lua script and return its SHA1.
   *
   * For Cluster mode, loads the script on every master node so that EVALSHA
   * succeeds regardless of which node handles the command.
   *
   * @param script The Lua script source code.
   * @returns The SHA1 hash string of the loaded script.
   * @throws {RedisConnectionError} If not connected.
   */
  async scriptLoad(script: string): Promise<string> {
    const client = this.getClient()

    if (client instanceof Cluster) {
      const masters = client.nodes('master')
      let sha = ''
      for (const node of masters) {
        sha = await node.script('LOAD', script) as string
      }
      return sha
    }

    const result = await (client as Redis).script('LOAD', script)
    return result as string
  }

  /**
   * Executes `EVALSHA` to run a pre-loaded Lua script.
   *
   * @param sha     The SHA1 of the script registered via SCRIPT LOAD.
   * @param numkeys The number of KEYS arguments.
   * @param args    Remaining arguments: KEYS followed by ARGV values.
   * @returns The raw result from the Lua script.
   * @throws {RedisConnectionError} If not connected.
   */
  async evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const client = this.getClient()
    if (client instanceof Cluster) {
      return client.evalsha(sha, numkeys, ...args)
    }
    return (client as Redis).evalsha(sha, numkeys, ...args)
  }
}
