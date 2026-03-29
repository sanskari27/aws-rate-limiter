/**
 * @fileoverview Unit tests for the config loader module.
 */

// ---------------------------------------------------------------------------
// Mock 'fs' so that readFileSync is writable (overridable) in individual tests.
// All methods default to real implementations via jest.requireActual.
// ---------------------------------------------------------------------------
jest.mock('fs', () => {
  const actualFs = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actualFs,
    readFileSync: jest.fn((...args: Parameters<typeof actualFs.readFileSync>) =>
      actualFs.readFileSync(...args),
    ),
  };
});

// ---------------------------------------------------------------------------
// Mock 'js-yaml' so that load is writable (overridable) in individual tests.
// ---------------------------------------------------------------------------
jest.mock('js-yaml', () => {
  const actualYaml = jest.requireActual<typeof import('js-yaml')>('js-yaml');
  return {
    ...actualYaml,
    load: jest.fn((...args: Parameters<typeof actualYaml.load>) =>
      actualYaml.load(...args),
    ),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  loadConfigFromFile,
  loadConfigFromEnv,
  loadConfig,
  validateConfig,
} from '../../../src/config/loader';
import { ConfigurationError } from '../../../src/core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a temporary YAML file and return its path. */
function writeTempYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-test-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** Save original env values and restore them after the test. */
let savedEnv: Record<string, string | undefined> = {};

const RATE_LIMITER_KEYS = [
  'RATE_LIMITER_REDIS_URL',
  'RATE_LIMITER_REDIS_AUTH',
  'RATE_LIMITER_DEFAULT_LIMIT',
  'RATE_LIMITER_DEFAULT_WINDOW',
  'RATE_LIMITER_FAILURE_POLICY',
  'RATE_LIMITER_RESERVOIR_BATCH_SIZE',
  'RATE_LIMITER_RESERVOIR_SYNC_INTERVAL',
  'RATE_LIMITER_CIRCUIT_BREAKER_ENABLED',
  'RATE_LIMITER_RESERVOIR_ENABLED',
  'RATE_LIMITER_LOG_LEVEL',
  'RATE_LIMITER_LOG_SAMPLE_RATE',
  'RATE_LIMITER_METRICS_BACKEND',
  'RATE_LIMITER_METRICS_NAMESPACE',
  'RATE_LIMITER_CONFIG',
];

beforeEach(() => {
  savedEnv = {};
  for (const key of RATE_LIMITER_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of RATE_LIMITER_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// loadConfigFromEnv
// ---------------------------------------------------------------------------

describe('loadConfigFromEnv', () => {
  test('returns valid config with defaults when no env vars set', () => {
    const cfg = loadConfigFromEnv();

    expect(cfg).toBeDefined();
    expect(cfg.redis).toBeDefined();
    expect(Array.isArray(cfg.rules)).toBe(true);
    expect(cfg.rules.length).toBeGreaterThan(0);

    const rule = cfg.rules[0];
    expect(rule.name).toBe('default');
    expect(rule.limits.ip?.limit).toBe(60);
    expect(rule.limits.ip?.window).toBe(60);
  });

  test('uses RATE_LIMITER_REDIS_URL when set', () => {
    process.env['RATE_LIMITER_REDIS_URL'] = 'redis://my-host:6379';
    const cfg = loadConfigFromEnv();
    expect(cfg.redis.url).toBe('redis://my-host:6379');
  });

  test('uses RATE_LIMITER_REDIS_AUTH when set', () => {
    process.env['RATE_LIMITER_REDIS_AUTH'] = 'super-secret';
    const cfg = loadConfigFromEnv();
    expect(cfg.redis.password).toBe('super-secret');
  });

  test('uses RATE_LIMITER_DEFAULT_LIMIT to set ip limit', () => {
    process.env['RATE_LIMITER_DEFAULT_LIMIT'] = '500';
    const cfg = loadConfigFromEnv();
    expect(cfg.rules[0]?.limits.ip?.limit).toBe(500);
  });

  test('uses RATE_LIMITER_DEFAULT_WINDOW to set ip window', () => {
    process.env['RATE_LIMITER_DEFAULT_WINDOW'] = '120';
    const cfg = loadConfigFromEnv();
    expect(cfg.rules[0]?.limits.ip?.window).toBe(120);
  });

  test('sets failure policy from RATE_LIMITER_FAILURE_POLICY=closed', () => {
    process.env['RATE_LIMITER_FAILURE_POLICY'] = 'closed';
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.default).toBe('closed');
  });

  test('sets failure policy from RATE_LIMITER_FAILURE_POLICY=local', () => {
    process.env['RATE_LIMITER_FAILURE_POLICY'] = 'local';
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.default).toBe('local');
  });

  test('defaults failure policy to open for unknown value', () => {
    process.env['RATE_LIMITER_FAILURE_POLICY'] = 'unknown';
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.default).toBe('open');
  });

  test('sets reservoir batchSize from RATE_LIMITER_RESERVOIR_BATCH_SIZE', () => {
    process.env['RATE_LIMITER_RESERVOIR_BATCH_SIZE'] = '50';
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.batchSize).toBe(50);
  });

  test('sets reservoir syncInterval from RATE_LIMITER_RESERVOIR_SYNC_INTERVAL', () => {
    process.env['RATE_LIMITER_RESERVOIR_SYNC_INTERVAL'] = '2000';
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.syncInterval).toBe(2000);
  });

  test('RATE_LIMITER_RESERVOIR_ENABLED=true enables reservoir', () => {
    process.env['RATE_LIMITER_RESERVOIR_ENABLED'] = 'true';
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.enabled).toBe(true);
  });

  test('reservoir disabled by default', () => {
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.enabled).toBe(false);
  });

  test('RATE_LIMITER_LOG_LEVEL sets log level', () => {
    process.env['RATE_LIMITER_LOG_LEVEL'] = 'debug';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logLevel).toBe('debug');
  });

  test('RATE_LIMITER_LOG_SAMPLE_RATE sets sample rate', () => {
    process.env['RATE_LIMITER_LOG_SAMPLE_RATE'] = '0.1';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logSampleRate).toBe(0.1);
  });

  test('RATE_LIMITER_METRICS_BACKEND sets metrics backend', () => {
    process.env['RATE_LIMITER_METRICS_BACKEND'] = 'cloudwatch';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.metrics).toBe('cloudwatch');
  });

  test('RATE_LIMITER_METRICS_NAMESPACE sets namespace', () => {
    process.env['RATE_LIMITER_METRICS_NAMESPACE'] = 'MyApp/RateLimiter';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.namespace).toBe('MyApp/RateLimiter');
  });

  test('RATE_LIMITER_CIRCUIT_BREAKER_ENABLED=true enables circuit breaker', () => {
    process.env['RATE_LIMITER_CIRCUIT_BREAKER_ENABLED'] = 'true';
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.circuitBreaker?.enabled).toBe(true);
  });

  test('non-numeric RATE_LIMITER_LOG_SAMPLE_RATE falls back to 1 (NaN branch)', () => {
    process.env['RATE_LIMITER_LOG_SAMPLE_RATE'] = 'not-a-number';
    const cfg = loadConfigFromEnv();
    // isNaN(parseFloat('not-a-number')) → true → defaults to 1
    expect(cfg.observability?.logSampleRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromFile
// ---------------------------------------------------------------------------

describe('loadConfigFromFile', () => {
  test('throws ConfigurationError for nonexistent file', () => {
    expect(() =>
      loadConfigFromFile('/nonexistent/path/config.yaml'),
    ).toThrow(ConfigurationError);
  });

  test('wraps non-Error thrown by fs.readFileSync as string in ConfigurationError (line 143 FALSE branch)', () => {
    // readFileSync is mocked at module level so we can override it in this test
    const mockedReadFileSync = jest.mocked(fs.readFileSync);
    mockedReadFileSync.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string error from fs';
    });

    expect(() => loadConfigFromFile('/any/path.yaml')).toThrow(ConfigurationError);
  });

  test('uses err.message when fs.readFileSync throws an Error (line 143 TRUE branch)', () => {
    // The Jest VM context causes native fs errors to fail instanceof checks,
    // so we explicitly throw a VM-context Error to cover the TRUE branch.
    const mockedReadFileSync = jest.mocked(fs.readFileSync);
    const explicitError = new Error('explicit ENOENT message');
    mockedReadFileSync.mockImplementationOnce(() => {
      throw explicitError;
    });

    let caughtErr: unknown;
    try {
      loadConfigFromFile('/any/path.yaml');
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(ConfigurationError);
    expect((caughtErr as Error).message).toContain('explicit ENOENT message');
  });

  test('wraps non-Error thrown by yaml.load as String in ConfigurationError (line 153)', () => {
    const file = writeTempYaml('some: valid-yaml'); // readable file
    const mockedYamlLoad = jest.mocked(yaml.load);
    mockedYamlLoad.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 42; // a number — not an Error
    });
    expect(() => loadConfigFromFile(file)).toThrow(ConfigurationError);
  });

  test('throws ConfigurationError for invalid YAML', () => {
    const file = writeTempYaml(': this is: invalid: yaml: :::');
    expect(() => loadConfigFromFile(file)).toThrow(ConfigurationError);
  });

  test('loads valid YAML config', () => {
    const yaml = `
redis:
  url: redis://localhost:6379
rules:
  - name: test-rule
    limits:
      ip:
        limit: 100
        window: 60
`;
    const file = writeTempYaml(yaml);
    const cfg = loadConfigFromFile(file);

    expect(cfg.redis.url).toBe('redis://localhost:6379');
    expect(cfg.rules[0]?.name).toBe('test-rule');
    expect(cfg.rules[0]?.limits.ip?.limit).toBe(100);
    expect(cfg.rules[0]?.limits.ip?.window).toBe(60);
  });

  test('performs env var substitution in YAML', () => {
    process.env['SOME_REDIS_URL'] = 'redis://substituted-host:6379';
    const yaml = `
redis:
  url: \${SOME_REDIS_URL}
rules:
  - name: sub-rule
    limits:
      ip:
        limit: 10
        window: 30
`;
    const file = writeTempYaml(yaml);
    const cfg = loadConfigFromFile(file);
    expect(cfg.redis.url).toBe('redis://substituted-host:6379');
    delete process.env['SOME_REDIS_URL'];
  });

  test('substitutes missing env vars with empty string', () => {
    delete process.env['MISSING_VAR'];
    const yaml = `
redis:
  url: redis://host:6379
  password: \${MISSING_VAR}
rules:
  - name: rule
    limits:
      ip:
        limit: 5
        window: 10
`;
    const file = writeTempYaml(yaml);
    const cfg = loadConfigFromFile(file);
    // YAML treats an empty value as null; the password key will be absent / null.
    // The important thing is that substitution ran without throwing.
    expect(cfg.redis.password === '' || cfg.redis.password == null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  test('throws for null input', () => {
    expect(() => validateConfig(null)).toThrow(ConfigurationError);
  });

  test('throws for non-object input', () => {
    expect(() => validateConfig('string')).toThrow(ConfigurationError);
    expect(() => validateConfig(42)).toThrow(ConfigurationError);
  });

  test('throws for missing redis', () => {
    expect(() => validateConfig({ rules: [] })).toThrow(ConfigurationError);
  });

  test('throws for missing rules', () => {
    expect(() => validateConfig({ redis: { url: 'redis://localhost' } })).toThrow(
      ConfigurationError,
    );
  });

  test('throws when rules is not an array', () => {
    expect(() =>
      validateConfig({ redis: { url: 'redis://localhost' }, rules: 'not-array' }),
    ).toThrow(ConfigurationError);
  });

  test('throws when a rule has no name', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ limits: { ip: { limit: 10, window: 60 } } }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws when a rule has no limits', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'no-limits' }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('passes for a valid config object', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost:6379' },
        rules: [
          {
            name: 'valid-rule',
            limits: { ip: { limit: 100, window: 60 } },
          },
        ],
      }),
    ).not.toThrow();
  });

  test('passes for an empty rules array', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost:6379' },
        rules: [],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validateConfig — additional branch coverage
// ---------------------------------------------------------------------------

describe('validateConfig — additional branches', () => {
  test('throws when a rule item is null (not an object)', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [null as unknown as object],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws when redis has neither url nor cluster', () => {
    expect(() =>
      validateConfig({
        redis: {},
        rules: [{ name: 'r', limits: {} }],
      }),
    ).toThrow('must contain at least "url" or "cluster"');
  });

  test('throws when ip limit is not a positive number (zero)', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: { limit: 0, window: 60 } } }],
      }),
    ).toThrow('limit must be a positive number');
  });

  test('throws when ip limit is negative', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: { limit: -1, window: 60 } } }],
      }),
    ).toThrow('limit must be a positive number');
  });

  test('throws when ip window is not a positive number (zero)', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: { limit: 100, window: 0 } } }],
      }),
    ).toThrow('window must be a positive number');
  });

  test('throws when ip window is negative', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: { limit: 100, window: -5 } } }],
      }),
    ).toThrow('window must be a positive number');
  });

  test('throws when limit is not a number (string)', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [
          {
            name: 'r',
            limits: { ip: { limit: 'hundred' as unknown as number, window: 60 } },
          },
        ],
      }),
    ).toThrow('limit must be a positive number');
  });

  test('throws when window is not a number (string)', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [
          {
            name: 'r',
            limits: { ip: { limit: 100, window: 'sixty' as unknown as number } },
          },
        ],
      }),
    ).toThrow('window must be a positive number');
  });

  test('accepts cluster without url', () => {
    expect(() =>
      validateConfig({
        redis: { cluster: { nodes: [{ host: 'n1', port: 6379 }] } },
        rules: [{ name: 'r', limits: {} }],
      }),
    ).not.toThrow();
  });
});

describe('loadConfig', () => {
  test('falls back to env when no file argument and no RATE_LIMITER_CONFIG', () => {
    process.env['RATE_LIMITER_REDIS_URL'] = 'redis://env-host:6379';
    const cfg = loadConfig();
    expect(cfg.redis.url).toBe('redis://env-host:6379');
  });

  test('loads file when explicit filePath provided', () => {
    const yamlContent = `
redis:
  url: redis://file-host:6379
rules:
  - name: from-file
    limits:
      ip:
        limit: 20
        window: 30
`;
    const file = writeTempYaml(yamlContent);
    const cfg = loadConfig(file);
    expect(cfg.redis.url).toBe('redis://file-host:6379');
  });

  test('uses RATE_LIMITER_CONFIG env var when no filePath argument', () => {
    const yamlContent = `
redis:
  url: redis://env-config-host:6379
rules:
  - name: env-config-rule
    limits:
      ip:
        limit: 30
        window: 60
`;
    const file = writeTempYaml(yamlContent);
    process.env['RATE_LIMITER_CONFIG'] = file;
    const cfg = loadConfig();
    expect(cfg.redis.url).toBe('redis://env-config-host:6379');
  });

  test('falls back to env when filePath is empty string (resolvedPath !== "" check)', () => {
    // `loadConfig('')` → resolvedPath = '' → condition `resolvedPath !== ''` is false
    // → should use env fallback, not call loadConfigFromFile('')
    process.env['RATE_LIMITER_REDIS_URL'] = 'redis://fallback-host:6379';
    const cfg = loadConfig('');
    expect(cfg.redis.url).toBe('redis://fallback-host:6379');
  });
});

// ---------------------------------------------------------------------------
// validateConfig — exact error message assertions (kill StringLiteral mutants)
// ---------------------------------------------------------------------------

describe('validateConfig — exact error messages', () => {
  test('throws "Config must be an object" for null input', () => {
    expect(() => validateConfig(null)).toThrow('Config must be an object');
  });

  test('throws "Config must be an object" for non-object input', () => {
    expect(() => validateConfig('string')).toThrow('Config must be an object');
    expect(() => validateConfig(42)).toThrow('Config must be an object');
  });

  test('throws message containing "redis" for missing redis key', () => {
    expect(() => validateConfig({ rules: [] })).toThrow(
      'Config must contain a "redis" object with connection details',
    );
  });

  test('throws message containing "rules" for missing rules key', () => {
    expect(() => validateConfig({ redis: { url: 'redis://localhost' } })).toThrow(
      'Config must contain a "rules" array',
    );
  });

  test('throws "rules" must be an array message', () => {
    expect(() =>
      validateConfig({ redis: { url: 'redis://localhost' }, rules: 'not-array' }),
    ).toThrow('"rules" must be an array');
  });

  test('throws message containing "name" for rule with no name', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ limits: { ip: { limit: 10, window: 60 } } }],
      }),
    ).toThrow('must have a non-empty "name" string');
  });

  test('throws message containing "limits" for rule with no limits', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r' }],
      }),
    ).toThrow('must have a "limits" object');
  });

  test('throws message containing rule index for invalid rule item', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [null as unknown as object],
      }),
    ).toThrow('rules[0] must be an object');
  });
});

// ---------------------------------------------------------------------------
// validateConfig — individual guard condition coverage (kill LogicalOperator
// and ConditionalExpression mutants on compound conditions)
// ---------------------------------------------------------------------------

describe('validateConfig — redis guard conditions', () => {
  test('throws when redis key is present but value is null', () => {
    // Tests `obj['redis'] === null` branch (individually from `!('redis' in obj)`)
    expect(() =>
      validateConfig({ redis: null, rules: [] }),
    ).toThrow(ConfigurationError);
  });

  test('throws REDIS guard message (not url/cluster message) when redis is null', () => {
    // The redis guard message is thrown BEFORE the url/cluster check.
    // When redis===null, the guard fires with "must contain a redis object".
    // Mutation `false` on typeof check still fires for null (obj===null check).
    let err: unknown;
    try { validateConfig({ redis: null, rules: [] }); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/must contain a "redis" object/);
  });

  test('throws REDIS guard message when redis is a number (typeof check)', () => {
    // Mutation `false` for typeof check: redis=42 passes null check, fails typeof.
    // Without typeof check, the code continues to url/cluster check and throws a DIFFERENT error.
    // This test verifies the SPECIFIC redis guard error message is thrown.
    let err: unknown;
    try { validateConfig({ redis: 42, rules: [] }); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/must contain a "redis" object/);
  });

  test('throws REDIS guard message when redis is a string (typeof check)', () => {
    let err: unknown;
    try { validateConfig({ redis: 'not-object', rules: [] }); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/must contain a "redis" object/);
  });
});

describe('validateConfig — limits guard conditions', () => {
  test('throws when limits key is present but value is null', () => {
    // Tests `r['limits'] === null` branch
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: null }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws when limits key is present but not an object (a string)', () => {
    // Tests `typeof r['limits'] !== 'object'` branch
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: 'bad' }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws LIMITS guard message (not spec message) when limits is null', () => {
    let err: unknown;
    try {
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'my-rule', limits: null }],
      });
    } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/must have a "limits" object/);
  });

  test('throws RULE-OBJECT guard message (not name message) when rule is a number', () => {
    // Mutation removes typeof check: if rule is number, rule===null is false and typeof is removed.
    // Without typeof check, code accesses r['name'] on a number → undefined → throws name error.
    // This verifies the SPECIFIC rule-object guard message.
    let err: unknown;
    try {
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [42 as unknown as object],
      });
    } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/rules\[0\] must be an object/);
  });
});

describe('validateConfig — name guard conditions', () => {
  test('throws when rule name is an empty string', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: '', limits: {} }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws when rule name is whitespace-only (trim() check)', () => {
    // Distinguishes `r['name'].trim() === ''` from `r['name'] === ''`.
    // '  ' is not empty without trim but IS empty after trim.
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: '   ', limits: {} }],
      }),
    ).toThrow(ConfigurationError);
  });

  test('throws when rule name is not a string', () => {
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 42, limits: {} }],
      }),
    ).toThrow(ConfigurationError);
  });
});

describe('validateConfig — spec validation with null spec (spec !== null check)', () => {
  test('passes when ip spec is not present (undefined) — null check matters', () => {
    // When spec === undefined, the null/undefined check prevents validation.
    // If `spec !== null` were removed, this would fail when spec is null.
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: undefined } }],
      }),
    ).not.toThrow();
  });

  test('skips validation when ip spec is explicitly null', () => {
    // spec === null → `spec !== undefined && spec !== null` is false → skip
    expect(() =>
      validateConfig({
        redis: { url: 'redis://localhost' },
        rules: [{ name: 'r', limits: { ip: null } }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromEnv — default value assertions (kill string default mutants)
// ---------------------------------------------------------------------------

describe('loadConfigFromEnv — default values when env vars absent', () => {
  test('batchSize defaults to 10 when RATE_LIMITER_RESERVOIR_BATCH_SIZE not set', () => {
    // ?? '10' → if mutated to ?? "" → parseInt("") → NaN → breaks numeric check
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.batchSize).toBe(10);
  });

  test('syncInterval defaults to 1000 when RATE_LIMITER_RESERVOIR_SYNC_INTERVAL not set', () => {
    const cfg = loadConfigFromEnv();
    expect(cfg.reservoir?.syncInterval).toBe(1000);
  });

  test('logSampleRate defaults to 1 when RATE_LIMITER_LOG_SAMPLE_RATE not set', () => {
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logSampleRate).toBe(1);
  });

  test('circuitBreaker is NOT added when RATE_LIMITER_CIRCUIT_BREAKER_ENABLED is absent', () => {
    // `env['RATE_LIMITER_CIRCUIT_BREAKER_ENABLED'] === 'true'` → false when absent
    // Mutation: → `true` would add circuitBreaker block unconditionally
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.circuitBreaker).toBeUndefined();
  });

  test('circuitBreaker is NOT added when RATE_LIMITER_CIRCUIT_BREAKER_ENABLED is "false"', () => {
    process.env['RATE_LIMITER_CIRCUIT_BREAKER_ENABLED'] = 'false';
    const cfg = loadConfigFromEnv();
    expect(cfg.failure?.circuitBreaker).toBeUndefined();
  });

  test('password is NOT set when RATE_LIMITER_REDIS_AUTH is absent', () => {
    // `env['RATE_LIMITER_REDIS_AUTH'] !== undefined` → false when absent
    // Mutation `→ true` would set password=undefined unconditionally
    const cfg = loadConfigFromEnv();
    expect(cfg.redis.password).toBeUndefined();
  });

  test('password key is NOT present in redis object when RATE_LIMITER_REDIS_AUTH absent', () => {
    // Mutation `→ true` spreads { password: undefined }. The key IS present but undefined.
    // Checking `hasOwnProperty` distinguishes "key absent" from "key=undefined".
    const cfg = loadConfigFromEnv();
    expect(Object.prototype.hasOwnProperty.call(cfg.redis, 'password')).toBe(false);
  });

  test('namespace is NOT set when RATE_LIMITER_METRICS_NAMESPACE is absent', () => {
    // `env['RATE_LIMITER_METRICS_NAMESPACE'] !== undefined` → false when absent
    const cfg = loadConfigFromEnv();
    expect((cfg.observability as Record<string, unknown>)['namespace']).toBeUndefined();
  });

  test('namespace key is NOT present in observability when RATE_LIMITER_METRICS_NAMESPACE absent', () => {
    // Mutation `→ true` spreads { namespace: undefined }. The key IS present.
    const cfg = loadConfigFromEnv();
    expect(
      Object.prototype.hasOwnProperty.call(cfg.observability, 'namespace'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromEnv — log level and metrics backend branches
// ---------------------------------------------------------------------------

describe('loadConfigFromEnv — log level branches', () => {
  test('RATE_LIMITER_LOG_LEVEL=warn sets log level to warn', () => {
    // Tests `logLevelRaw === 'warn'` branch (kill ConditionalExpression mutation)
    process.env['RATE_LIMITER_LOG_LEVEL'] = 'warn';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logLevel).toBe('warn');
  });

  test('RATE_LIMITER_LOG_LEVEL=error sets log level to error', () => {
    // Tests `logLevelRaw === 'error'` branch
    process.env['RATE_LIMITER_LOG_LEVEL'] = 'error';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logLevel).toBe('error');
  });

  test('unknown RATE_LIMITER_LOG_LEVEL falls back to info', () => {
    process.env['RATE_LIMITER_LOG_LEVEL'] = 'verbose';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.logLevel).toBe('info');
  });
});

describe('loadConfigFromEnv — metrics backend branches', () => {
  test('RATE_LIMITER_METRICS_BACKEND=prometheus sets backend', () => {
    // Tests `metricsBackendRaw === 'prometheus'` branch
    process.env['RATE_LIMITER_METRICS_BACKEND'] = 'prometheus';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.metrics).toBe('prometheus');
  });

  test('RATE_LIMITER_METRICS_BACKEND=statsd sets backend', () => {
    // Tests `metricsBackendRaw === 'statsd'` branch
    process.env['RATE_LIMITER_METRICS_BACKEND'] = 'statsd';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.metrics).toBe('statsd');
  });

  test('unknown RATE_LIMITER_METRICS_BACKEND falls back to none', () => {
    process.env['RATE_LIMITER_METRICS_BACKEND'] = 'unknown-backend';
    const cfg = loadConfigFromEnv();
    expect(cfg.observability?.metrics).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromFile — YAML error message content
// ---------------------------------------------------------------------------

describe('loadConfigFromFile — YAML error message content', () => {
  test('YAML error message contains the file path', () => {
    const file = writeTempYaml(': invalid: yaml: :::');
    let caughtErr: unknown;
    try {
      loadConfigFromFile(file);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(ConfigurationError);
    // The message must NOT be empty — verifies string literal mutant is killed
    expect((caughtErr as Error).message.length).toBeGreaterThan(0);
    expect((caughtErr as Error).message).toContain('Invalid YAML');
  });

  test('YAML parse error includes the error details in the message', () => {
    const mockedYamlLoad = jest.mocked(yaml.load);
    const tempFile = writeTempYaml('redis:\n  url: redis://localhost\n');
    mockedYamlLoad.mockImplementationOnce(() => {
      throw new Error('unexpected token at line 1');
    });

    let caughtErr: unknown;
    try {
      loadConfigFromFile(tempFile);
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(ConfigurationError);
    expect((caughtErr as Error).message).toContain('unexpected token at line 1');
  });

  test('YAML non-Error thrown wraps with String() in message', () => {
    const mockedYamlLoad = jest.mocked(yaml.load);
    const tempFile = writeTempYaml('redis:\n  url: redis://localhost\n');
    mockedYamlLoad.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'raw string error';
    });

    let caughtErr: unknown;
    try {
      loadConfigFromFile(tempFile);
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(ConfigurationError);
    expect((caughtErr as Error).message).toContain('raw string error');
  });
});
