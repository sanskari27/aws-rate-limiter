/**
 * @fileoverview SSM Parameter Store hot-reload watcher.
 *
 * Polls AWS SSM Parameter Store at a configurable interval and calls
 * `onUpdate` whenever parameter values change.  This allows rate limit
 * configuration to be updated at runtime without restarting the process.
 *
 * Uses dynamic import of `@aws-sdk/client-ssm` so that the module can be
 * loaded without the AWS SDK being available (e.g. in unit tests).
 */

import { RateLimiterConfig, ConfigurationError } from '../core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link SSMWatcher}.
 */
export interface SSMWatcherConfig {
  /**
   * SSM parameter path prefix to poll, e.g. `/rate-limiter/prod/limits`.
   * All parameters under this path hierarchy will be fetched.
   */
  parameterPath: string;
  /** AWS region where the SSM parameters live. */
  region: string;
  /** Polling interval in milliseconds.  Defaults to 60 000 ms (1 minute). */
  refreshInterval?: number;
  /**
   * Callback invoked whenever one or more parameter values change.
   * Receives a partial config built from the changed parameters.
   */
  onUpdate?: (newConfig: Partial<RateLimiterConfig>) => void;
}

// ---------------------------------------------------------------------------
// SSM client factory (lazy dynamic import avoids hard dep at load time)
// ---------------------------------------------------------------------------

/**
 * Lazily create an SSM client using dynamic import.
 *
 * @param region AWS region.
 * @returns Configured SSM client.
 */
async function getSSMClient(
  region: string,
): Promise<{ getParametersByPath: (params: unknown) => { promise?: () => Promise<unknown>; then?: (fn: (v: unknown) => unknown) => unknown } }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic SDK import
  const mod = await import('@aws-sdk/client-ssm') as any;
  const SSM = mod.SSM ?? mod.default?.SSM;
  if (typeof SSM !== 'function') {
    throw new ConfigurationError('Cannot load @aws-sdk/client-ssm');
  }
  return new SSM({ region }) as {
    getParametersByPath: (params: unknown) => {
      promise?: () => Promise<unknown>;
      then?: (fn: (v: unknown) => unknown) => unknown;
    };
  };
}

// ---------------------------------------------------------------------------
// SSMWatcher
// ---------------------------------------------------------------------------

/**
 * Polls AWS SSM Parameter Store for configuration changes and notifies the
 * application via the `onUpdate` callback.
 *
 * @example
 * ```typescript
 * const watcher = new SSMWatcher({
 *   parameterPath: '/rate-limiter/prod',
 *   region: 'us-east-1',
 *   refreshInterval: 30_000,
 *   onUpdate: (cfg) => limiter.applyConfig(cfg),
 * })
 * watcher.start()
 * // … later …
 * watcher.stop()
 * ```
 */
export class SSMWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly config: Required<SSMWatcherConfig>;
  private lastParams: Map<string, string> = new Map();

  /**
   * @param config Watcher configuration.
   * @throws {ConfigurationError} If `parameterPath` or `region` are empty.
   */
  constructor(config: SSMWatcherConfig) {
    if (!config.parameterPath || config.parameterPath.trim() === '') {
      throw new ConfigurationError('SSMWatcher requires a non-empty parameterPath');
    }
    if (!config.region || config.region.trim() === '') {
      throw new ConfigurationError('SSMWatcher requires a non-empty region');
    }

    this.config = {
      parameterPath: config.parameterPath,
      region: config.region,
      refreshInterval: config.refreshInterval ?? 60_000,
      onUpdate: config.onUpdate ?? (() => undefined),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start polling SSM for parameter changes at the configured interval.
   * If the watcher is already running this is a no-op.
   */
  start(): void {
    if (this.intervalId !== null) return;

    // Fire immediately on first start, then on each interval tick.
    void this.poll();

    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.config.refreshInterval);

    // Prevent the interval from keeping the Node process alive.
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop polling.  The in-flight poll (if any) may still complete.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Returns `true` when the watcher is actively polling.
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Fetch all SSM parameters under the configured path once.
   * Exposed for testing and manual refresh.
   *
   * @returns Map from parameter name to its string value.
   * @throws {ConfigurationError} If the AWS SDK cannot be loaded.
   */
  async fetchParams(): Promise<Map<string, string>> {
    const client = await getSSMClient(this.config.region);
    const result = new Map<string, string>();

    let nextToken: string | undefined;

    do {
      const params: Record<string, unknown> = {
        Path: this.config.parameterPath,
        Recursive: true,
        WithDecryption: true,
        ...(nextToken !== undefined ? { NextToken: nextToken } : {}),
      };

      // Support both SDK v2 (.promise()) and SDK v3 (direct promise)
      const response = await (async () => {
        const call = client.getParametersByPath(params);
        if (call && typeof (call as { promise?: () => Promise<unknown> }).promise === 'function') {
          return (call as { promise: () => Promise<unknown> }).promise();
        }
        return call as Promise<unknown>;
      })();

      const resp = response as {
        Parameters?: { Name?: string; Value?: string }[];
        NextToken?: string;
      };

      for (const p of resp.Parameters ?? []) {
        if (p.Name !== undefined && p.Value !== undefined) {
          result.set(p.Name, p.Value);
        }
      }

      nextToken = resp.NextToken;
    } while (nextToken !== undefined);

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Internal poll: fetch params, diff against last snapshot, call onUpdate if changed.
   */
  private async poll(): Promise<void> {
    try {
      const current = await this.fetchParams();
      const changed = this.diff(this.lastParams, current);

      if (changed.size > 0) {
        this.lastParams = current;
        const partial = this.buildPartialConfig(changed);
        this.config.onUpdate(partial);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[SSMWatcher] poll error: ${message}\n`);
    }
  }

  /**
   * Compute which parameters changed between `prev` and `next`.
   *
   * @param prev Previous snapshot.
   * @param next Current snapshot.
   * @returns Map containing only the changed entries from `next`.
   */
  private diff(
    prev: Map<string, string>,
    next: Map<string, string>,
  ): Map<string, string> {
    const changed = new Map<string, string>();
    for (const [key, value] of next) {
      if (prev.get(key) !== value) {
        changed.set(key, value);
      }
    }
    // Also detect deleted params (value disappears).
    for (const key of prev.keys()) {
      if (!next.has(key)) {
        changed.set(key, '');
      }
    }
    return changed;
  }

  /**
   * Build a partial {@link RateLimiterConfig} from the changed SSM parameters.
   *
   * Parameter name conventions (relative to `parameterPath`):
   * - `/ip/limit`   → first rule ip.limit
   * - `/ip/window`  → first rule ip.window
   * - `/log/level`  → observability.logLevel
   *
   * @param changed Map of changed parameter names → new values.
   * @returns Partial config derived from the changed parameters.
   */
  private buildPartialConfig(
    changed: Map<string, string>,
  ): Partial<RateLimiterConfig> {
    const partial: Partial<RateLimiterConfig> = {};

    for (const [name, value] of changed) {
      const suffix = name.replace(this.config.parameterPath, '');

      if (suffix === '/ip/limit' || suffix === '/ip/window') {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed)) {
          if (!partial.rules) {
            partial.rules = [{ name: 'default', limits: {} }];
          }
          const rule = partial.rules[0];
          if (!rule.limits.ip) {
            rule.limits.ip = { limit: 60, window: 60 };
          }
          if (suffix === '/ip/limit') rule.limits.ip.limit = parsed;
          else rule.limits.ip.window = parsed;
        }
      } else if (suffix === '/log/level') {
        const level = value as 'debug' | 'info' | 'warn' | 'error';
        if (['debug', 'info', 'warn', 'error'].includes(level)) {
          partial.observability = { ...partial.observability, logLevel: level };
        }
      }
    }

    return partial;
  }
}
