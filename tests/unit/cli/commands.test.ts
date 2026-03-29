/**
 * @fileoverview Unit tests for CLI command handlers.
 *
 * Mocks RateLimiter and ioredis so no real Redis connection is required.
 */

import { RateLimiterConfig, RateLimitResult, ConfigurationError } from '../../../src/core/types';

// ---------------------------------------------------------------------------
// Mock RateLimiter
// ---------------------------------------------------------------------------

const mockConnect = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
const mockShutdown = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
const mockStatus = jest.fn<Promise<RateLimitResult>, [unknown]>();
const mockReset = jest.fn<Promise<number>, [string, string]>();

jest.mock('../../../src/rate-limiter', () => ({
  RateLimiter: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    shutdown: mockShutdown,
    status: mockStatus,
    reset: mockReset,
  })),
}));

// ---------------------------------------------------------------------------
// Mock ioredis (for top-users / health commands)
// ---------------------------------------------------------------------------

const mockPing = jest.fn<Promise<string>, []>();
const mockInfo = jest.fn<Promise<string>, [string]>();
const mockScan = jest.fn<Promise<[string, string[]]>, [string, string, string, string, number]>();
const mockGet = jest.fn<Promise<string | null>, [string]>();
const mockQuit = jest.fn<Promise<string>, []>().mockResolvedValue('OK');

const mockRedisClient = {
  ping: mockPing,
  info: mockInfo,
  scan: mockScan,
  get: mockGet,
  quit: mockQuit,
};

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { runStatusCommand } from '../../../scripts/cli/commands/status';
import { runResetCommand } from '../../../scripts/cli/commands/reset';
import { runTopUsersCommand, scanKeys } from '../../../scripts/cli/commands/top-users';
import { runHealthCommand } from '../../../scripts/cli/commands/health';
import { parseArgs } from '../../../scripts/cli/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: RateLimiterConfig = {
  redis: { url: 'redis://localhost:6379' },
  rules: [
    {
      name: 'test-rule',
      limits: {
        ip: { limit: 100, window: 60 },
        route: { limit: 5000, window: 60 },
      },
    },
  ],
};

const allowedResult: RateLimitResult = {
  allowed: true,
  dimension: 'none',
  effective: 45,
  limit: 100,
  remaining: 55,
  resetAt: new Date('2024-01-01T10:00:30Z').getTime(),
  source: 'redis',
};

const deniedResult: RateLimitResult = {
  allowed: false,
  dimension: 'ip',
  effective: 101,
  limit: 100,
  remaining: 0,
  resetAt: new Date('2024-01-01T10:00:30Z').getTime(),
  retryAfter: 5000,
  source: 'redis',
};

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --key value pairs correctly', () => {
    const result = parseArgs(['--ip', '192.168.1.1', '--route', '/api/users', '--method', 'GET']);
    expect(result).toEqual({ ip: '192.168.1.1', route: '/api/users', method: 'GET' });
  });

  it('handles boolean flags with no following value', () => {
    const result = parseArgs(['--verbose']);
    expect(result).toEqual({ verbose: 'true' });
  });

  it('handles boolean flags followed by another flag', () => {
    const result = parseArgs(['--verbose', '--dimension', 'user']);
    expect(result).toEqual({ verbose: 'true', dimension: 'user' });
  });

  it('returns empty record for empty input', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('ignores non-flag tokens', () => {
    const result = parseArgs(['orphan', '--key', 'value']);
    expect(result).toEqual({ key: 'value' });
  });

  it('handles multiple flags in sequence', () => {
    const result = parseArgs(['--a', '1', '--b', '2', '--c', '3']);
    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });
});

// ---------------------------------------------------------------------------
// runStatusCommand
// ---------------------------------------------------------------------------

describe('runStatusCommand', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls connect() and shutdown() on the limiter', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand({ ip: '192.168.1.1', route: '/api/users', method: 'GET' }, baseConfig);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it('calls status() with the provided context', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand(
      { ip: '10.0.0.1', userId: 'u123', route: '/api/orders', method: 'POST' },
      baseConfig,
    );

    expect(mockStatus).toHaveBeenCalledWith({
      ip: '10.0.0.1',
      userId: 'u123',
      route: '/api/orders',
      method: 'POST',
    });
  });

  it('uses default IP "0.0.0.0" when no ip is provided', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand({}, baseConfig);

    expect(mockStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '0.0.0.0' }),
    );
  });

  it('uses default route "/" when no route is provided', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand({}, baseConfig);

    expect(mockStatus).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/', method: 'GET' }),
    );
  });

  it('prints a status table to console.log', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand({ ip: '192.168.1.1', route: '/api/users', method: 'GET' }, baseConfig);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rate Limit Status'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dimension'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Effective'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Remaining'));
  });

  it('prints DENIED status when result is not allowed', async () => {
    mockStatus.mockResolvedValue(deniedResult);

    await runStatusCommand({ ip: '1.2.3.4', route: '/api' }, baseConfig);

    const allCalls = consoleSpy.mock.calls.flat().join('\n');
    expect(allCalls).toContain('DENIED');
  });

  it('prints ALLOWED status when result is allowed', async () => {
    mockStatus.mockResolvedValue(allowedResult);

    await runStatusCommand({ ip: '1.2.3.4', route: '/api' }, baseConfig);

    const allCalls = consoleSpy.mock.calls.flat().join('\n');
    expect(allCalls).toContain('ALLOWED');
  });

  it('calls shutdown() even if status() throws', async () => {
    mockStatus.mockRejectedValue(new Error('Redis error'));

    await expect(
      runStatusCommand({ ip: '1.2.3.4', route: '/api' }, baseConfig),
    ).rejects.toThrow('Redis error');

    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runResetCommand
// ---------------------------------------------------------------------------

describe('runResetCommand', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls reset() with the correct dimension and identifier', async () => {
    mockReset.mockResolvedValue(4);

    await runResetCommand({ dimension: 'ip', identifier: '192.168.1.1' }, baseConfig);

    expect(mockReset).toHaveBeenCalledWith('ip', '192.168.1.1');
  });

  it('prints the number of deleted keys', async () => {
    mockReset.mockResolvedValue(4);

    await runResetCommand({ dimension: 'ip', identifier: '192.168.1.1' }, baseConfig);

    const allCalls = consoleSpy.mock.calls.flat().join('\n');
    expect(allCalls).toContain('deleted 4');
    expect(allCalls).toContain('ip:192.168.1.1');
  });

  it('throws ConfigurationError for an invalid dimension', async () => {
    await expect(
      runResetCommand(
        // Cast deliberately to test runtime validation
        { dimension: 'bad-dimension' as 'ip', identifier: 'test' },
        baseConfig,
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('includes the invalid dimension name in the error message', async () => {
    await expect(
      runResetCommand({ dimension: 'global' as 'ip', identifier: 'test' }, baseConfig),
    ).rejects.toThrow('global');
  });

  it('throws ConfigurationError for empty identifier', async () => {
    await expect(
      runResetCommand({ dimension: 'ip', identifier: '' }, baseConfig),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('accepts all 4 valid dimensions', async () => {
    mockReset.mockResolvedValue(2);

    const dims: Array<'ip' | 'user' | 'route' | 'user-route'> = [
      'ip',
      'user',
      'route',
      'user-route',
    ];

    for (const dim of dims) {
      await expect(
        runResetCommand({ dimension: dim, identifier: 'test-value' }, baseConfig),
      ).resolves.not.toThrow();
    }
  });

  it('calls connect() and shutdown()', async () => {
    mockReset.mockResolvedValue(2);

    await runResetCommand({ dimension: 'user', identifier: 'alice' }, baseConfig);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it('calls shutdown() even if reset() throws', async () => {
    mockReset.mockRejectedValue(new Error('Redis error'));

    await expect(
      runResetCommand({ dimension: 'ip', identifier: '1.2.3.4' }, baseConfig),
    ).rejects.toThrow('Redis error');

    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runTopUsersCommand
// ---------------------------------------------------------------------------

describe('runTopUsersCommand', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls SCAN with a pattern containing the dimension', async () => {
    mockScan
      .mockResolvedValueOnce(['0', ['rl:v1:{user:abc1234}:28433334']])
    mockGet.mockResolvedValue('50');

    await runTopUsersCommand(
      { dimension: 'user', limit: 10, window: 60 },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockScan).toHaveBeenCalledWith('0', 'MATCH', expect.stringContaining('user'), 'COUNT', 100);
  });

  it('handles pagination correctly — continues until cursor is "0"', async () => {
    mockScan
      .mockResolvedValueOnce(['42', ['key1']])
      .mockResolvedValueOnce(['0', ['key2', 'key3']]);
    mockGet.mockResolvedValue('10');

    const keys = await scanKeys(
      mockRedisClient as unknown as import('ioredis').Redis,
      'rl:v1:*user*:28433334',
    );

    expect(keys).toEqual(['key1', 'key2', 'key3']);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('sorts results by count descending', async () => {
    mockScan.mockResolvedValueOnce([
      '0',
      [
        'rl:v1:{user:aaa}:28433334',
        'rl:v1:{user:bbb}:28433334',
        'rl:v1:{user:ccc}:28433334',
      ],
    ]);

    // Return different counts per key
    mockGet
      .mockResolvedValueOnce('100')
      .mockResolvedValueOnce('300')
      .mockResolvedValueOnce('200');

    await runTopUsersCommand(
      { dimension: 'user', limit: 3, window: 60 },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    // bbb (300) should appear before ccc (200) and aaa (100)
    const posBbb = allOutput.indexOf('bbb');
    const posCcc = allOutput.indexOf('ccc');
    const posAaa = allOutput.indexOf('aaa');
    expect(posBbb).toBeLessThan(posCcc);
    expect(posCcc).toBeLessThan(posAaa);
  });

  it('respects the limit argument — only shows top N rows', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `rl:v1:{user:u${i}}:28433334`);
    mockScan.mockResolvedValueOnce(['0', keys]);
    mockGet.mockResolvedValue('10');

    await runTopUsersCommand(
      { dimension: 'user', limit: 5, window: 60 },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    // Separator + header + 5 data rows = at most 7 relevant log calls with numbers
    const rowCalls = consoleSpy.mock.calls.filter((args) =>
      /^\d+\s/.test(String(args[0])),
    );
    expect(rowCalls.length).toBeLessThanOrEqual(5);
  });

  it('prints a message when no keys are found', async () => {
    mockScan.mockResolvedValueOnce(['0', []]);

    await runTopUsersCommand(
      { dimension: 'user', limit: 10, window: 60 },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('No keys found');
  });

  it('defaults dimension to "user" when not specified', async () => {
    mockScan.mockResolvedValueOnce(['0', []]);

    await runTopUsersCommand(
      {},
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockScan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      expect.stringContaining('user'),
      'COUNT',
      100,
    );
  });
});

// ---------------------------------------------------------------------------
// runHealthCommand
// ---------------------------------------------------------------------------

describe('runHealthCommand', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls PING on the Redis client', async () => {
    mockPing.mockResolvedValue('PONG');

    await runHealthCommand(
      {},
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockPing).toHaveBeenCalledTimes(1);
  });

  it('prints "Connected" when PING succeeds', async () => {
    mockPing.mockResolvedValue('PONG');

    await runHealthCommand(
      {},
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Connected');
  });

  it('prints ping latency when PING succeeds', async () => {
    mockPing.mockResolvedValue('PONG');

    await runHealthCommand(
      {},
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toMatch(/OK \(\d+ms\)/);
  });

  it('prints DISCONNECTED and error message when PING fails', async () => {
    mockPing.mockRejectedValue(new Error('ECONNREFUSED'));

    await runHealthCommand(
      {},
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('DISCONNECTED');
    expect(allOutput).toContain('ECONNREFUSED');
  });

  it('does not call INFO when verbose is false', async () => {
    mockPing.mockResolvedValue('PONG');

    await runHealthCommand(
      { verbose: false },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('calls INFO memory and prints stats when verbose is true', async () => {
    mockPing.mockResolvedValue('PONG');
    mockInfo.mockResolvedValue(
      '# Memory\r\nused_memory_human:45.2M\r\nmaxmemory:8589934592\r\nmem_fragmentation_ratio:1.05\r\n',
    );

    await runHealthCommand(
      { verbose: true },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockInfo).toHaveBeenCalledWith('memory');
    const allOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('used_memory_human');
    expect(allOutput).toContain('45.2M');
  });

  it('does not call INFO when PING fails even in verbose mode', async () => {
    mockPing.mockRejectedValue(new Error('down'));

    await runHealthCommand(
      { verbose: true },
      baseConfig,
      mockRedisClient as unknown as import('ioredis').Redis,
    );

    expect(mockInfo).not.toHaveBeenCalled();
  });
});
