/**
 * @fileoverview YAML + environment variable config loader for the AWS Rate Limiter.
 *
 * Provides three loading strategies:
 *  1. {@link loadConfigFromFile} — parse a YAML file with ${ENV_VAR} substitution.
 *  2. {@link loadConfigFromEnv}  — build a minimal config from RATE_LIMITER_* env vars.
 *  3. {@link loadConfig}         — try file first (or RATE_LIMITER_CONFIG), fall back to env.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  RateLimiterConfig,
  RuleConfig,
  ConfigurationError,
} from '../core/types';

// ---------------------------------------------------------------------------
// Env-var substitution
// ---------------------------------------------------------------------------

/**
 * Replace all `${VAR_NAME}` placeholders in `content` with the corresponding
 * `process.env` value.  Missing variables are replaced with an empty string.
 *
 * @param content Raw YAML string potentially containing `${...}` placeholders.
 * @returns String with all placeholders resolved.
 */
function substituteEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? '');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a config object. Throws {@link ConfigurationError} with a helpful
 * message if any required field is absent or malformed.
 *
 * This is an *asserting* type-guard: after a successful call, TypeScript knows
 * the value satisfies `RateLimiterConfig`.
 *
 * @param config  The unknown value to validate.
 * @throws {ConfigurationError} If the config is missing required fields.
 */
export function validateConfig(config: unknown): asserts config is RateLimiterConfig {
  if (config === null || typeof config !== 'object') {
    throw new ConfigurationError('Config must be an object');
  }

  const obj = config as Record<string, unknown>;

  // -- redis ------------------------------------------------------------------
  if (!('redis' in obj) || obj['redis'] === null || typeof obj['redis'] !== 'object') {
    throw new ConfigurationError(
      'Config must contain a "redis" object with connection details (e.g. { url: "redis://..." })',
    );
  }

  // -- rules ------------------------------------------------------------------
  if (!('rules' in obj)) {
    throw new ConfigurationError(
      'Config must contain a "rules" array. Provide an empty array [] if no rules are needed.',
    );
  }

  if (!Array.isArray(obj['rules'])) {
    throw new ConfigurationError('"rules" must be an array');
  }

  const rules = obj['rules'] as unknown[];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule === null || typeof rule !== 'object') {
      throw new ConfigurationError(`rules[${i}] must be an object`);
    }
    const r = rule as Record<string, unknown>;
    if (typeof r['name'] !== 'string' || r['name'].trim() === '') {
      throw new ConfigurationError(`rules[${i}] must have a non-empty "name" string`);
    }
    if (!('limits' in r) || r['limits'] === null || typeof r['limits'] !== 'object') {
      throw new ConfigurationError(
        `rules[${i}] ("${r['name'] as string}") must have a "limits" object`,
      );
    }
  }

  // Validate redis has at least url or cluster
  const redis = obj['redis'] as Record<string, unknown>;
  if (!redis['url'] && !redis['cluster']) {
    throw new ConfigurationError(
      'Config "redis" must contain at least "url" or "cluster" connection details',
    );
  }

  // Validate each rule's limit specs have valid values
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown>;
    const limits = r['limits'] as Record<string, unknown>;
    for (const dim of ['ip', 'route', 'user', 'userRoute'] as const) {
      const spec = limits[dim];
      if (spec !== undefined && spec !== null) {
        const s = spec as Record<string, unknown>;
        if (typeof s['limit'] !== 'number' || s['limit'] <= 0) {
          throw new ConfigurationError(
            `rules[${i}].limits.${dim}.limit must be a positive number`,
          );
        }
        if (typeof s['window'] !== 'number' || s['window'] <= 0) {
          throw new ConfigurationError(
            `rules[${i}].limits.${dim}.window must be a positive number`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// loadConfigFromFile
// ---------------------------------------------------------------------------

/**
 * Load rate limiter configuration from a YAML file.
 *
 * Performs `${ENV_VAR}` substitution before parsing so that secrets can be
 * injected via environment variables without being stored in the YAML file.
 *
 * @param filePath Absolute or relative path to the YAML configuration file.
 * @returns Parsed and validated {@link RateLimiterConfig}.
 * @throws {ConfigurationError} If the file does not exist, cannot be read, or
 *   contains invalid YAML / missing required fields.
 */
export function loadConfigFromFile(filePath: string): RateLimiterConfig {
  const resolved = path.resolve(filePath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigurationError(`Cannot read config file "${resolved}": ${msg}`);
  }

  const substituted = substituteEnvVars(raw);

  let parsed: unknown;
  try {
    parsed = yaml.load(substituted);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigurationError(`Invalid YAML in config file "${resolved}": ${msg}`);
  }

  validateConfig(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// loadConfigFromEnv
// ---------------------------------------------------------------------------

/**
 * Build a {@link RateLimiterConfig} entirely from `RATE_LIMITER_*` environment
 * variables.  Sensible defaults are applied when variables are absent.
 *
 * | Environment variable               | Config path                         | Default   |
 * |------------------------------------|-------------------------------------|-----------|
 * | `RATE_LIMITER_REDIS_URL`           | `redis.url`                         | (none)    |
 * | `RATE_LIMITER_REDIS_AUTH`          | `redis.password`                    | (none)    |
 * | `RATE_LIMITER_DEFAULT_LIMIT`       | default rule ip.limit               | `60`      |
 * | `RATE_LIMITER_DEFAULT_WINDOW`      | default rule ip.window (seconds)    | `60`      |
 * | `RATE_LIMITER_FAILURE_POLICY`      | `failure.default`                   | `open`    |
 * | `RATE_LIMITER_RESERVOIR_BATCH_SIZE`| `reservoir.batchSize`               | `10`      |
 * | `RATE_LIMITER_RESERVOIR_SYNC_INTERVAL`| `reservoir.syncInterval` (ms)   | `1000`    |
 * | `RATE_LIMITER_CIRCUIT_BREAKER_ENABLED`| circuit breaker enabled          | `false`   |
 * | `RATE_LIMITER_RESERVOIR_ENABLED`   | `reservoir.enabled`                 | `false`   |
 * | `RATE_LIMITER_LOG_LEVEL`           | `observability.logLevel`            | `info`    |
 * | `RATE_LIMITER_LOG_SAMPLE_RATE`     | `observability.logSampleRate`       | `1`       |
 * | `RATE_LIMITER_METRICS_BACKEND`     | `observability.metrics`             | `none`    |
 * | `RATE_LIMITER_METRICS_NAMESPACE`   | `observability.namespace`           | (none)    |
 *
 * @returns A valid {@link RateLimiterConfig} derived from the current environment.
 */
export function loadConfigFromEnv(): RateLimiterConfig {
  const env = process.env;

  const defaultLimit = parseInt(env['RATE_LIMITER_DEFAULT_LIMIT'] ?? '60', 10);
  const defaultWindow = parseInt(env['RATE_LIMITER_DEFAULT_WINDOW'] ?? '60', 10);

  const failurePolicyRaw = env['RATE_LIMITER_FAILURE_POLICY'];
  const failurePolicy: 'open' | 'closed' | 'local' =
    failurePolicyRaw === 'closed' || failurePolicyRaw === 'local'
      ? failurePolicyRaw
      : 'open';

  const reservoirEnabled = env['RATE_LIMITER_RESERVOIR_ENABLED'] === 'true';
  const batchSize = parseInt(env['RATE_LIMITER_RESERVOIR_BATCH_SIZE'] ?? '10', 10);
  const syncInterval = parseInt(env['RATE_LIMITER_RESERVOIR_SYNC_INTERVAL'] ?? '1000', 10);

  const circuitBreakerEnabled = env['RATE_LIMITER_CIRCUIT_BREAKER_ENABLED'] === 'true';

  const logLevelRaw = env['RATE_LIMITER_LOG_LEVEL'];
  const logLevel: 'debug' | 'info' | 'warn' | 'error' =
    logLevelRaw === 'debug' || logLevelRaw === 'warn' || logLevelRaw === 'error'
      ? logLevelRaw
      : 'info';

  const logSampleRate = parseFloat(env['RATE_LIMITER_LOG_SAMPLE_RATE'] ?? '1');
  const metricsBackendRaw = env['RATE_LIMITER_METRICS_BACKEND'];
  const metricsBackend: 'cloudwatch' | 'prometheus' | 'statsd' | 'none' =
    metricsBackendRaw === 'cloudwatch' ||
    metricsBackendRaw === 'prometheus' ||
    metricsBackendRaw === 'statsd'
      ? metricsBackendRaw
      : 'none';

  const defaultRule: RuleConfig = {
    name: 'default',
    limits: {
      ip: { limit: defaultLimit, window: defaultWindow },
    },
  };

  const redisUrl = env['RATE_LIMITER_REDIS_URL'];

  const config: RateLimiterConfig = {
    redis: {
      ...(redisUrl !== undefined ? { url: redisUrl } : { url: 'redis://localhost:6379' }),
      ...(env['RATE_LIMITER_REDIS_AUTH'] !== undefined
        ? { password: env['RATE_LIMITER_REDIS_AUTH'] }
        : {}),
    },
    rules: [defaultRule],
    reservoir: {
      enabled: reservoirEnabled,
      batchSize,
      syncInterval,
    },
    failure: {
      default: failurePolicy,
      ...(circuitBreakerEnabled
        ? {
            circuitBreaker: {
              enabled: true,
              threshold: 5,
              recoveryTimeout: 30000,
            },
          }
        : {}),
    },
    observability: {
      logLevel,
      logSampleRate: isNaN(logSampleRate) ? 1 : logSampleRate,
      metrics: metricsBackend,
      ...(env['RATE_LIMITER_METRICS_NAMESPACE'] !== undefined
        ? { namespace: env['RATE_LIMITER_METRICS_NAMESPACE'] }
        : {}),
    },
  };

  validateConfig(config);
  return config;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load configuration using the following resolution order:
 *  1. `filePath` argument (if provided).
 *  2. `RATE_LIMITER_CONFIG` environment variable (path to YAML file).
 *  3. Fall back to {@link loadConfigFromEnv}.
 *
 * @param filePath Optional explicit path to a YAML configuration file.
 * @returns Parsed and validated {@link RateLimiterConfig}.
 * @throws {ConfigurationError} If a file path is resolved but the file is
 *   missing or invalid.
 */
export function loadConfig(filePath?: string): RateLimiterConfig {
  const resolvedPath = filePath ?? process.env['RATE_LIMITER_CONFIG'];
  if (resolvedPath !== undefined && resolvedPath !== '') {
    return loadConfigFromFile(resolvedPath);
  }
  return loadConfigFromEnv();
}
