/**
 * @fileoverview Structured JSON logger with configurable minimum level and sampling.
 *
 * Log output is always a single-line JSON object that includes at minimum
 * `ts` (ISO-8601 timestamp), `level`, and `event` fields.  Additional
 * arbitrary fields can be passed via the `fields` argument and are merged
 * into the entry.
 *
 * Sampling is applied to `info` and `debug` log calls through
 * {@link Logger.sample} so that high-volume allowed-request logs can be
 * emitted at a configurable fraction without generating excessive I/O.
 * `warn` and `error` entries are never sampled out.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported log levels ordered by severity (ascending). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Shape of a single emitted log entry (all keys are `string | unknown`).
 */
export interface LogEntry {
  /** ISO-8601 timestamp string. */
  ts: string;
  /** Log level. */
  level: LogLevel;
  /** Short event name / message. */
  event: string;
  /** Additional fields merged from the `fields` argument. */
  [key: string]: unknown;
}

/**
 * Configuration for {@link Logger}.
 */
export interface LoggerConfig {
  /**
   * Minimum log level to emit.  Messages below this level are discarded.
   * Defaults to `'info'`.
   */
  level?: LogLevel;
  /**
   * Fraction of `info` / `debug` log entries to emit (0–1).
   * `warn` and `error` entries are always emitted regardless of this value.
   * Defaults to `1.0` (emit all).
   */
  sampleRate?: number;
  /**
   * Custom output function.  If not provided, entries are written to
   * `process.stdout` as newline-delimited JSON.
   *
   * @param entry Fully constructed log entry.
   */
  output?: (entry: LogEntry) => void;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Structured JSON logger.
 *
 * @example
 * ```typescript
 * const log = createLogger({ level: 'info', sampleRate: 0.01 })
 * log.info('request.allowed', { ip: '1.2.3.4', remaining: 42 })
 * log.error('redis.error', { err: error.message })
 * ```
 */
export class Logger {
  private readonly config: Required<LoggerConfig>;
  private readonly levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  /**
   * @param config Optional logger configuration.
   */
  constructor(config?: LoggerConfig) {
    this.config = {
      level: config?.level ?? 'info',
      sampleRate: config?.sampleRate ?? 1.0,
      output:
        config?.output ??
        ((entry: LogEntry) => {
          process.stdout.write(JSON.stringify(entry) + '\n');
        }),
    };
  }

  // -------------------------------------------------------------------------
  // Level-specific convenience methods
  // -------------------------------------------------------------------------

  /**
   * Emit a `debug` log entry.
   *
   * @param event  Short event name / message.
   * @param fields Optional additional fields to include in the entry.
   */
  debug(event: string, fields?: Record<string, unknown>): void {
    this.write('debug', event, fields);
  }

  /**
   * Emit an `info` log entry.
   *
   * @param event  Short event name / message.
   * @param fields Optional additional fields to include in the entry.
   */
  info(event: string, fields?: Record<string, unknown>): void {
    this.write('info', event, fields);
  }

  /**
   * Emit a `warn` log entry.
   *
   * @param event  Short event name / message.
   * @param fields Optional additional fields to include in the entry.
   */
  warn(event: string, fields?: Record<string, unknown>): void {
    this.write('warn', event, fields);
  }

  /**
   * Emit an `error` log entry.
   *
   * @param event  Short event name / message.
   * @param fields Optional additional fields to include in the entry.
   */
  error(event: string, fields?: Record<string, unknown>): void {
    this.write('error', event, fields);
  }

  // -------------------------------------------------------------------------
  // Sampled logging
  // -------------------------------------------------------------------------

  /**
   * Emit a log entry with sampling applied to `info` and `debug` levels.
   *
   * `warn` and `error` entries are always emitted (not subject to sampling).
   * For `info` and `debug` a random number is compared against
   * `config.sampleRate`; the entry is dropped if the number exceeds the rate.
   *
   * This method is intended for high-volume code paths such as allowed-request
   * logging where a 1% sample rate is typically sufficient.
   *
   * @param level  Log level for this entry.
   * @param event  Short event name / message.
   * @param fields Optional additional fields to include in the entry.
   */
  sample(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    // Always emit warn/error.
    if (level === 'warn' || level === 'error') {
      this.write(level, event, fields);
      return;
    }

    // Sample info/debug according to sampleRate.
    if (Math.random() <= this.config.sampleRate) {
      this.write(level, event, fields);
    }
  }

  // -------------------------------------------------------------------------
  // Level predicate
  // -------------------------------------------------------------------------

  /**
   * Returns `true` if the given level would be emitted given the configured
   * minimum level.
   *
   * @param level Log level to test.
   * @returns Whether log entries at this level would be output.
   */
  isEnabled(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.config.level];
  }

  // -------------------------------------------------------------------------
  // Private core writer
  // -------------------------------------------------------------------------

  /**
   * Build and emit a log entry if the level is enabled.
   *
   * @param level  Log level.
   * @param event  Short event name.
   * @param fields Optional additional fields.
   */
  private write(
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void {
    if (!this.isEnabled(level)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };

    this.config.output(entry);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory that creates a {@link Logger} with the given config.
 *
 * @param config Optional logger configuration.
 * @returns A new {@link Logger} instance.
 */
export function createLogger(config?: LoggerConfig): Logger {
  return new Logger(config);
}
