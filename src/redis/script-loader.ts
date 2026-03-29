/**
 * @fileoverview Lua script loader for Redis EVALSHA operations.
 * Loads all 5 rate-limiter Lua scripts via SCRIPT LOAD, caches their SHAs,
 * and handles NOSCRIPT errors (which occur after Redis failover) by reloading
 * and retrying automatically.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { RateLimiterError } from '../core/types'

/** Names of the 5 Lua scripts used by the rate limiter */
export type ScriptName = 'check' | 'checkMulti' | 'status' | 'reset' | 'reservoirFetch'

/** Map of all 5 script names to their Redis-computed SHAs */
export interface ScriptShas {
  check: string
  checkMulti: string
  status: string
  reset: string
  reservoirFetch: string
}

/**
 * Minimal Redis client interface required by the ScriptLoader.
 * Both a single-node Redis and a Cluster satisfy this interface.
 */
export interface RedisClientForScripts {
  /** Load a Lua script and return its SHA1 hash */
  scriptLoad(script: string): Promise<string>
  /** Execute a cached Lua script by SHA */
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
}

/** Mapping from logical script name to the corresponding .lua file */
const SCRIPT_FILE_MAP: Record<ScriptName, string> = {
  check: 'check.lua',
  checkMulti: 'check_multi.lua',
  status: 'status.lua',
  reset: 'reset.lua',
  reservoirFetch: 'reservoir_fetch.lua',
}

/** All script names in load order */
const ALL_SCRIPT_NAMES: ScriptName[] = ['check', 'checkMulti', 'status', 'reset', 'reservoirFetch']

/**
 * Thrown when a Lua script execution fails with a Redis BUSY error.
 * BUSY means Redis is running a long-running Lua script; callers should not retry.
 */
export class ScriptBusyError extends RateLimiterError {
  /**
   * @param message Human-readable description of the BUSY condition.
   */
  constructor(message: string) {
    super(message, 'SCRIPT_BUSY_ERROR')
    this.name = 'ScriptBusyError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Thrown when a requested script has not been loaded yet.
 */
export class ScriptNotLoadedError extends RateLimiterError {
  /**
   * @param name The script name that was requested before loading.
   */
  constructor(name: ScriptName) {
    super(`Script "${name}" has not been loaded. Call loadAll() first.`, 'SCRIPT_NOT_LOADED_ERROR')
    this.name = 'ScriptNotLoadedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Manages loading and execution of Lua scripts via Redis EVALSHA.
 *
 * Usage pattern:
 * 1. Call {@link loadAll} once at startup to register all scripts with Redis.
 * 2. Use {@link eval} to execute scripts; NOSCRIPT errors are handled automatically.
 *
 * @example
 * ```typescript
 * const loader = new ScriptLoader()
 * await loader.loadAll(redisClient)
 * const result = await loader.eval(redisClient, 'check', ['rl:v1:{ip:c0a80101}:28433334'], [100, 60000])
 * ```
 */
export class ScriptLoader {
  private shas: Partial<ScriptShas> = {}
  private readonly luaDir: string

  /**
   * @param luaDir Directory containing the .lua files.
   *               Defaults to `path.join(__dirname, '../lua')`.
   */
  constructor(luaDir?: string) {
    this.luaDir = luaDir ?? path.join(__dirname, '../lua')
  }

  /**
   * Reads all 5 Lua scripts from disk and loads them into Redis via SCRIPT LOAD.
   * Idempotent — safe to call multiple times (e.g., after a failover).
   *
   * @param client A Redis client that implements {@link RedisClientForScripts}.
   * @returns A {@link ScriptShas} object mapping each script name to its SHA1.
   * @throws {Error} If a Lua file cannot be read from disk.
   */
  async loadAll(client: RedisClientForScripts): Promise<ScriptShas> {
    const entries = await Promise.all(
      ALL_SCRIPT_NAMES.map(async (name) => {
        const filePath = path.join(this.luaDir, SCRIPT_FILE_MAP[name])
        const source = await fs.readFile(filePath, 'utf8')
        const sha = await client.scriptLoad(source)
        return [name, sha] as const
      }),
    )

    const newShas: Partial<ScriptShas> = {}
    for (const [name, sha] of entries) {
      newShas[name] = sha
    }
    this.shas = newShas as ScriptShas
    return this.shas as ScriptShas
  }

  /**
   * Returns the SHA1 for a named script.
   *
   * @param name The logical script name.
   * @returns The SHA1 string registered with Redis.
   * @throws {ScriptNotLoadedError} If {@link loadAll} has not been called yet.
   */
  getSha(name: ScriptName): string {
    const sha = this.shas[name]
    if (sha === undefined) {
      throw new ScriptNotLoadedError(name)
    }
    return sha
  }

  /**
   * Executes a named Lua script using EVALSHA.
   *
   * On a `NOSCRIPT` error (Redis lost the script cache after a failover),
   * all scripts are reloaded automatically and the call is retried once.
   *
   * On a `BUSY` error (Redis is executing a long-running script), a
   * {@link ScriptBusyError} is thrown immediately without retrying.
   *
   * @param client A Redis client that implements {@link RedisClientForScripts}.
   * @param name   The logical name of the script to execute.
   * @param keys   The KEYS array to pass to the Lua script.
   * @param args   The ARGV array to pass to the Lua script.
   * @returns The raw result returned by the Lua script.
   * @throws {ScriptNotLoadedError} If the script has not been loaded.
   * @throws {ScriptBusyError}      If Redis returns a BUSY error.
   * @throws {RateLimiterError}     On any other unexpected Redis error.
   */
  async eval(
    client: RedisClientForScripts,
    name: ScriptName,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    const sha = this.getSha(name)

    try {
      return await client.evalsha(sha, keys.length, ...keys, ...args)
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err)

      if (errorMessage.includes('NOSCRIPT')) {
        // Scripts were flushed (e.g. after Redis failover). Reload and retry once.
        await this.loadAll(client)
        const reloadedSha = this.getSha(name)
        return await client.evalsha(reloadedSha, keys.length, ...keys, ...args)
      }

      if (errorMessage.includes('BUSY')) {
        throw new ScriptBusyError(
          `Redis is busy executing a long-running script: ${errorMessage}`,
        )
      }

      // Re-throw unknown errors as-is
      throw err
    }
  }

  /**
   * Returns `true` if all 5 scripts have been loaded and their SHAs are cached.
   * @returns Boolean indicating whether all scripts are ready for use.
   */
  isLoaded(): boolean {
    return ALL_SCRIPT_NAMES.every((name) => this.shas[name] !== undefined)
  }
}

/**
 * Extracts a string message from an unknown caught value.
 * @param err The caught error value.
 * @returns A string representation of the error.
 */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
