/**
 * @fileoverview Unit tests for ScriptLoader.
 * Mocks fs.readFileSync and a minimal Redis client to verify script loading,
 * SHA caching, NOSCRIPT retry, and BUSY error propagation.
 */

import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { ScriptLoader, ScriptBusyError, ScriptNotLoadedError } from '../../../src/redis/script-loader'
import type { RedisClientForScripts, ScriptName } from '../../../src/redis/script-loader'

// ---------------------------------------------------------------------------
// Mock fs/promises so no real disk I/O occurs
// ---------------------------------------------------------------------------
jest.mock('fs/promises')
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Script content is unique per script to let tests assert correct file mapping */
function scriptContent(name: string): string {
  return `-- lua script: ${name}`
}

/** SHA is deterministic per script name for easy assertions */
function fakeSha(name: string): string {
  return `sha_${name}`
}

/** Expected file names for each logical script name */
const EXPECTED_FILE_MAP: Record<ScriptName, string> = {
  check: 'check.lua',
  checkMulti: 'check_multi.lua',
  status: 'status.lua',
  reset: 'reset.lua',
  reservoirFetch: 'reservoir_fetch.lua',
}

const ALL_NAMES: ScriptName[] = ['check', 'checkMulti', 'status', 'reset', 'reservoirFetch']

/** Builds a mock Redis client */
function buildMockClient(): jest.Mocked<RedisClientForScripts> {
  return {
    scriptLoad: jest.fn(async (source: string): Promise<string> => {
      // Reverse-map source → name to return deterministic SHA
      for (const name of ALL_NAMES) {
        if (source === scriptContent(name)) return fakeSha(name)
      }
      return 'sha_unknown'
    }),
    evalsha: jest.fn(
      async (_sha: string, _numkeys: number, ..._args: (string | number)[]): Promise<unknown> => 1,
    ),
  }
}

/** Configures mockReadFile to return dummy script bodies based on file name */
function setupReadFileMock(): void {
  mockReadFile.mockImplementation(async (filePath: unknown): Promise<string> => {
    const p = filePath as string
    const basename = path.basename(p)
    for (const [name, file] of Object.entries(EXPECTED_FILE_MAP)) {
      if (file === basename) {
        return scriptContent(name as ScriptName)
      }
    }
    throw new Error(`Unexpected file read: ${p}`)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScriptLoader', () => {
  let loader: ScriptLoader
  let client: jest.Mocked<RedisClientForScripts>

  beforeEach(() => {
    jest.clearAllMocks()
    setupReadFileMock()
    loader = new ScriptLoader('/fake/lua')
    client = buildMockClient()
  })

  // -------------------------------------------------------------------------
  // isLoaded()
  // -------------------------------------------------------------------------

  describe('isLoaded()', () => {
    it('returns false before loadAll()', () => {
      expect(loader.isLoaded()).toBe(false)
    })

    it('returns true after loadAll()', async () => {
      await loader.loadAll(client)
      expect(loader.isLoaded()).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // loadAll()
  // -------------------------------------------------------------------------

  describe('loadAll()', () => {
    it('calls scriptLoad exactly 5 times', async () => {
      await loader.loadAll(client)
      expect(client.scriptLoad).toHaveBeenCalledTimes(5)
    })

    it('reads each script from the correct file path', async () => {
      await loader.loadAll(client)
      for (const [, filename] of Object.entries(EXPECTED_FILE_MAP)) {
        expect(mockReadFile).toHaveBeenCalledWith(
          expect.stringContaining(filename),
          'utf8',
        )
      }
    })

    it('returns a complete ScriptShas map', async () => {
      const shas = await loader.loadAll(client)
      expect(Object.keys(shas).sort()).toEqual(ALL_NAMES.slice().sort())
      for (const name of ALL_NAMES) {
        expect(shas[name]).toBe(fakeSha(name))
      }
    })

    it('maps check → check.lua', async () => {
      await loader.loadAll(client)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('check.lua'),
        'utf8',
      )
    })

    it('maps checkMulti → check_multi.lua', async () => {
      await loader.loadAll(client)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('check_multi.lua'),
        'utf8',
      )
    })

    it('maps status → status.lua', async () => {
      await loader.loadAll(client)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('status.lua'),
        'utf8',
      )
    })

    it('maps reset → reset.lua', async () => {
      await loader.loadAll(client)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('reset.lua'),
        'utf8',
      )
    })

    it('maps reservoirFetch → reservoir_fetch.lua', async () => {
      await loader.loadAll(client)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('reservoir_fetch.lua'),
        'utf8',
      )
    })
  })

  // -------------------------------------------------------------------------
  // getSha()
  // -------------------------------------------------------------------------

  describe('getSha()', () => {
    it('returns correct SHA for each script after loading', async () => {
      await loader.loadAll(client)
      for (const name of ALL_NAMES) {
        expect(loader.getSha(name)).toBe(fakeSha(name))
      }
    })

    it('throws ScriptNotLoadedError if not yet loaded', () => {
      expect(() => loader.getSha('check')).toThrow(ScriptNotLoadedError)
    })

    it('ScriptNotLoadedError has the correct code', () => {
      try {
        loader.getSha('reset')
      } catch (err) {
        expect(err).toBeInstanceOf(ScriptNotLoadedError)
        if (err instanceof ScriptNotLoadedError) {
          expect(err.code).toBe('SCRIPT_NOT_LOADED_ERROR')
        }
      }
    })
  })

  // -------------------------------------------------------------------------
  // eval()
  // -------------------------------------------------------------------------

  describe('eval()', () => {
    beforeEach(async () => {
      await loader.loadAll(client)
    })

    it('calls evalsha with the correct SHA and numkeys', async () => {
      const keys = ['key1', 'key2']
      const args = [100, 60000]
      await loader.eval(client, 'check', keys, args)
      expect(client.evalsha).toHaveBeenCalledWith(
        fakeSha('check'),
        2,
        'key1',
        'key2',
        100,
        60000,
      )
    })

    it('passes keys and args in the correct order (keys before args)', async () => {
      const keys = ['mykey']
      const args = ['arg1', 42]
      await loader.eval(client, 'status', keys, args)
      expect(client.evalsha).toHaveBeenCalledWith(fakeSha('status'), 1, 'mykey', 'arg1', 42)
    })

    it('returns the result from evalsha', async () => {
      client.evalsha.mockResolvedValueOnce('ok_result')
      const result = await loader.eval(client, 'check', [], [])
      expect(result).toBe('ok_result')
    })

    // -----------------------------------------------------------------------
    // NOSCRIPT retry
    // -----------------------------------------------------------------------

    it('retries after a NOSCRIPT error: reloads all scripts then calls evalsha again', async () => {
      client.evalsha
        .mockRejectedValueOnce(new Error('NOSCRIPT No matching script'))
        .mockResolvedValueOnce('retried_ok')

      const result = await loader.eval(client, 'check', ['k'], [1])

      // scriptLoad called once in beforeEach setup + 5 times during reload
      expect(client.scriptLoad).toHaveBeenCalledTimes(5 + 5)
      expect(result).toBe('retried_ok')
    })

    it('evalsha is called twice on NOSCRIPT: initial attempt + retry', async () => {
      client.evalsha
        .mockRejectedValueOnce(new Error('NOSCRIPT No matching script'))
        .mockResolvedValueOnce('ok')

      await loader.eval(client, 'checkMulti', [], [])
      expect(client.evalsha).toHaveBeenCalledTimes(2)
    })

    // -----------------------------------------------------------------------
    // BUSY error — no retry
    // -----------------------------------------------------------------------

    it('throws ScriptBusyError immediately on BUSY error without retrying', async () => {
      client.evalsha.mockRejectedValueOnce(new Error('BUSY Redis is busy running a script'))

      await expect(loader.eval(client, 'reset', [], [])).rejects.toBeInstanceOf(ScriptBusyError)
      // evalsha should only have been called once
      expect(client.evalsha).toHaveBeenCalledTimes(1)
      // No script reload should have occurred
      expect(client.scriptLoad).toHaveBeenCalledTimes(5) // only from setup
    })

    it('ScriptBusyError has code SCRIPT_BUSY_ERROR', async () => {
      client.evalsha.mockRejectedValueOnce(new Error('BUSY'))
      try {
        await loader.eval(client, 'check', [], [])
      } catch (err) {
        expect(err).toBeInstanceOf(ScriptBusyError)
        if (err instanceof ScriptBusyError) {
          expect(err.code).toBe('SCRIPT_BUSY_ERROR')
        }
      }
    })

    it('re-throws unknown errors without retrying', async () => {
      const unknownError = new Error('Some unexpected Redis error')
      client.evalsha.mockRejectedValueOnce(unknownError)

      await expect(loader.eval(client, 'check', [], [])).rejects.toBe(unknownError)
      expect(client.evalsha).toHaveBeenCalledTimes(1)
    })

    // -------------------------------------------------------------------------
    // getErrorMessage — non-Error / non-string thrown values
    // -------------------------------------------------------------------------

    it('getErrorMessage: re-throws a number (String(err) path)', async () => {
      // Throw a plain number: not instanceof Error, not string → String(42) = '42'
      // '42' doesn't include 'NOSCRIPT' or 'BUSY', so the original value is re-thrown
      client.evalsha.mockRejectedValueOnce(42)
      await expect(loader.eval(client, 'check', [], [])).rejects.toEqual(42)
    })

    it('getErrorMessage: handles a thrown string containing NOSCRIPT (string typeof path)', async () => {
      // Throw a plain string → typeof err === 'string' → getErrorMessage returns the string
      // String includes 'NOSCRIPT' → triggers reload and retry
      client.evalsha
        .mockRejectedValueOnce('NOSCRIPT No matching script: script hash not found')
        .mockResolvedValueOnce([1, '', 0, 0, 0])

      const result = await loader.eval(client, 'check', [], [])
      expect(result).toEqual([1, '', 0, 0, 0])
    })
  })

  // -------------------------------------------------------------------------
  // Default luaDir
  // -------------------------------------------------------------------------

  describe('default luaDir', () => {
    it('defaults to __dirname/../lua when no luaDir is provided', async () => {
      const defaultLoader = new ScriptLoader()
      await defaultLoader.loadAll(client)
      const calls = mockReadFile.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0][0]).toEqual(expect.stringContaining('lua'))
    })
  })
})
