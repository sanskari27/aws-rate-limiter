/**
 * @fileoverview Unit tests for the structured JSON logger.
 */

import { Logger, createLogger, LogEntry, LogLevel } from '../../../src/observability/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect emitted log entries instead of writing to stdout. */
function makeCollector(): {
  entries: LogEntry[];
  output: (entry: LogEntry) => void;
} {
  const entries: LogEntry[] = [];
  return {
    entries,
    output: (entry: LogEntry) => entries.push({ ...entry }),
  };
}

// ---------------------------------------------------------------------------
// Basic output
// ---------------------------------------------------------------------------

describe('Logger basic output', () => {
  test('logger.info() outputs a JSON entry to the configured output function', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });

    log.info('test.event', { key: 'value' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
  });

  test('log entry has ts, level, and event fields', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });

    log.info('my.event', { extra: 123 });

    const entry = entries[0]!;
    expect(typeof entry.ts).toBe('string');
    expect(entry.level).toBe('info');
    expect(entry.event).toBe('my.event');
  });

  test('ts field is a valid ISO-8601 timestamp', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });

    log.info('ts.check');

    const ts = entries[0]?.ts ?? '';
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  test('extra fields are merged into the log entry', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });

    log.info('fields.test', { ip: '1.2.3.4', remaining: 99, flag: true });

    const entry = entries[0]!;
    expect(entry['ip']).toBe('1.2.3.4');
    expect(entry['remaining']).toBe(99);
    expect(entry['flag']).toBe(true);
  });

  test('logger.warn() emits at warn level', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });
    log.warn('warn.event');
    expect(entries[0]?.level).toBe('warn');
  });

  test('logger.error() emits at error level', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ output });
    log.error('error.event');
    expect(entries[0]?.level).toBe('error');
  });

  test('logger.debug() emits at debug level when level is debug', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'debug', output });
    log.debug('debug.event');
    expect(entries[0]?.level).toBe('debug');
  });
});

// ---------------------------------------------------------------------------
// Level filtering
// ---------------------------------------------------------------------------

describe('Logger level filtering', () => {
  test('logger.debug() is skipped when level is info', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'info', output });

    log.debug('hidden.debug');

    expect(entries).toHaveLength(0);
  });

  test('logger.info() is skipped when level is warn', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'warn', output });

    log.info('hidden.info');

    expect(entries).toHaveLength(0);
  });

  test('logger.error() is always output regardless of level setting', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'error', output });

    log.debug('no');
    log.info('no');
    log.warn('no');
    log.error('yes.error');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('yes.error');
  });

  test('logger.warn() outputs when level is warn', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'warn', output });

    log.warn('visible.warn');

    expect(entries).toHaveLength(1);
  });

  test('all levels output when level is debug', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'debug', output });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(entries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe('Logger.isEnabled', () => {
  test('isEnabled returns true for levels at or above the configured level', () => {
    const log = new Logger({ level: 'info' });

    expect(log.isEnabled('info')).toBe(true);
    expect(log.isEnabled('warn')).toBe(true);
    expect(log.isEnabled('error')).toBe(true);
  });

  test('isEnabled returns false for levels below the configured level', () => {
    const log = new Logger({ level: 'info' });

    expect(log.isEnabled('debug')).toBe(false);
  });

  test('isEnabled with level=debug returns true for all levels', () => {
    const log = new Logger({ level: 'debug' });
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    for (const l of levels) {
      expect(log.isEnabled(l)).toBe(true);
    }
  });

  test('isEnabled with level=error only returns true for error', () => {
    const log = new Logger({ level: 'error' });

    expect(log.isEnabled('debug')).toBe(false);
    expect(log.isEnabled('info')).toBe(false);
    expect(log.isEnabled('warn')).toBe(false);
    expect(log.isEnabled('error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sample() — sampled logging
// ---------------------------------------------------------------------------

describe('Logger.sample', () => {
  test('sample() always outputs for warn level regardless of sampleRate', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0, output }); // 0 = never sample info/debug

    log.sample('warn', 'always.warn');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
  });

  test('sample() always outputs for error level regardless of sampleRate', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0, output });

    log.sample('error', 'always.error');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
  });

  test('sample() samples at configured rate for info level', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0.5, output });

    // Mock Math.random to return 0.3 (< 0.5 → should emit)
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.3);
    log.sample('info', 'sampled.in');
    spy.mockRestore();

    expect(entries).toHaveLength(1);
  });

  test('sample() drops info log when Math.random > sampleRate', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0.1, output });

    // 0.9 > 0.1 → should NOT emit
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
    log.sample('info', 'sampled.out');
    spy.mockRestore();

    expect(entries).toHaveLength(0);
  });

  test('sample() samples at configured rate for debug level', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'debug', sampleRate: 0.5, output });

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.4);
    log.sample('debug', 'debug.sampled.in');
    spy.mockRestore();

    expect(entries).toHaveLength(1);
  });

  test('sample() drops debug log when Math.random > sampleRate', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ level: 'debug', sampleRate: 0.2, output });

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.8);
    log.sample('debug', 'debug.sampled.out');
    spy.mockRestore();

    expect(entries).toHaveLength(0);
  });

  test('sample() with sampleRate=1 always emits info', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 1.0, output });

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9999);
    log.sample('info', 'always.info');
    spy.mockRestore();

    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createLogger factory
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  test('createLogger with no args returns a Logger', () => {
    const log = createLogger();
    expect(log).toBeInstanceOf(Logger);
  });

  test('createLogger respects provided config', () => {
    const { entries, output } = makeCollector();
    const log = createLogger({ level: 'warn', output });

    log.info('should.not.appear');
    log.warn('should.appear');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('should.appear');
  });
});

// ---------------------------------------------------------------------------
// Default stdout output (smoke test — does not assert stdout content)
// ---------------------------------------------------------------------------

describe('Logger default output', () => {
  test('writes JSON to stdout without error', () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = new Logger({ level: 'info' });
    log.info('stdout.test', { payload: 1 });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written.trim()) as LogEntry;
    expect(parsed.event).toBe('stdout.test');
    expect(parsed.level).toBe('info');

    writeSpy.mockRestore();
  });

  test('output is newline-terminated (ends with \\n)', () => {
    // Verifies the literal '\n' is appended, not '' or another character.
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = new Logger({ level: 'info' });
    log.info('newline.test');

    const written = writeSpy.mock.calls[0]?.[0] as string;
    expect(written.endsWith('\n')).toBe(true);

    writeSpy.mockRestore();
  });
});

describe('Logger.sample boundary', () => {
  test('sample() emits when Math.random() === sampleRate (boundary: <= not <)', () => {
    // The condition is `Math.random() <= sampleRate`.
    // When random === sampleRate, `<=` is true (emit) but `<` would be false (skip).
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0.5, output });

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    log.sample('info', 'boundary.emit');
    spy.mockRestore();

    expect(entries).toHaveLength(1);
  });

  test('sample() drops log when Math.random() is just above sampleRate', () => {
    const { entries, output } = makeCollector();
    const log = new Logger({ sampleRate: 0.5, output });

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5001);
    log.sample('info', 'just.above');
    spy.mockRestore();

    expect(entries).toHaveLength(0);
  });
});
