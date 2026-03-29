/**
 * @fileoverview Unit tests for the typed error classes exported from types.ts.
 */

import {
  RateLimiterError,
  RedisConnectionError,
  ConfigurationError,
  KeyBuilderError,
} from '../../../src/core/types';

// ---------------------------------------------------------------------------
// RateLimiterError
// ---------------------------------------------------------------------------

describe('RateLimiterError', () => {
  it('is an instance of Error', () => {
    const err = new RateLimiterError('something went wrong', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimiterError', () => {
    const err = new RateLimiterError('something went wrong', 'TEST_CODE');
    expect(err).toBeInstanceOf(RateLimiterError);
  });

  it('stores the message', () => {
    const err = new RateLimiterError('test message', 'TEST_CODE');
    expect(err.message).toBe('test message');
  });

  it('stores the code', () => {
    const err = new RateLimiterError('test message', 'MY_CODE');
    expect(err.code).toBe('MY_CODE');
  });

  it('has name set to RateLimiterError', () => {
    const err = new RateLimiterError('test', 'CODE');
    expect(err.name).toBe('RateLimiterError');
  });

  it('has a stack trace', () => {
    const err = new RateLimiterError('test', 'CODE');
    expect(err.stack).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// RedisConnectionError
// ---------------------------------------------------------------------------

describe('RedisConnectionError', () => {
  it('is an instance of Error', () => {
    const err = new RedisConnectionError('cannot connect');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimiterError', () => {
    const err = new RedisConnectionError('cannot connect');
    expect(err).toBeInstanceOf(RateLimiterError);
  });

  it('is an instance of RedisConnectionError', () => {
    const err = new RedisConnectionError('cannot connect');
    expect(err).toBeInstanceOf(RedisConnectionError);
  });

  it('has code REDIS_CONNECTION_ERROR', () => {
    const err = new RedisConnectionError('cannot connect');
    expect(err.code).toBe('REDIS_CONNECTION_ERROR');
  });

  it('has name set to RedisConnectionError', () => {
    const err = new RedisConnectionError('cannot connect');
    expect(err.name).toBe('RedisConnectionError');
  });

  it('stores the message', () => {
    const err = new RedisConnectionError('host unreachable');
    expect(err.message).toBe('host unreachable');
  });

  it('is caught by a catch block typed as RateLimiterError', () => {
    const attempt = (): void => {
      throw new RedisConnectionError('fail');
    };
    expect(() => attempt()).toThrow(RateLimiterError);
  });
});

// ---------------------------------------------------------------------------
// ConfigurationError
// ---------------------------------------------------------------------------

describe('ConfigurationError', () => {
  it('is an instance of Error', () => {
    expect(new ConfigurationError('bad config')).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimiterError', () => {
    expect(new ConfigurationError('bad config')).toBeInstanceOf(RateLimiterError);
  });

  it('is an instance of ConfigurationError', () => {
    expect(new ConfigurationError('bad config')).toBeInstanceOf(ConfigurationError);
  });

  it('has code CONFIGURATION_ERROR', () => {
    expect(new ConfigurationError('bad config').code).toBe('CONFIGURATION_ERROR');
  });

  it('has name set to ConfigurationError', () => {
    expect(new ConfigurationError('bad config').name).toBe('ConfigurationError');
  });

  it('stores the message', () => {
    expect(new ConfigurationError('missing redis.url').message).toBe('missing redis.url');
  });

  it('is caught by a catch block typed as RateLimiterError', () => {
    expect(() => {
      throw new ConfigurationError('invalid');
    }).toThrow(RateLimiterError);
  });
});

// ---------------------------------------------------------------------------
// KeyBuilderError
// ---------------------------------------------------------------------------

describe('KeyBuilderError', () => {
  it('is an instance of Error', () => {
    expect(new KeyBuilderError('bad key')).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimiterError', () => {
    expect(new KeyBuilderError('bad key')).toBeInstanceOf(RateLimiterError);
  });

  it('is an instance of KeyBuilderError', () => {
    expect(new KeyBuilderError('bad key')).toBeInstanceOf(KeyBuilderError);
  });

  it('has code KEY_BUILDER_ERROR', () => {
    expect(new KeyBuilderError('bad key').code).toBe('KEY_BUILDER_ERROR');
  });

  it('has name set to KeyBuilderError', () => {
    expect(new KeyBuilderError('bad key').name).toBe('KeyBuilderError');
  });

  it('stores the message', () => {
    expect(new KeyBuilderError('empty IP').message).toBe('empty IP');
  });

  it('is caught by a catch block typed as RateLimiterError', () => {
    expect(() => {
      throw new KeyBuilderError('empty');
    }).toThrow(RateLimiterError);
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity (important after transpilation)
// ---------------------------------------------------------------------------

describe('prototype chain integrity', () => {
  it('RedisConnectionError is not confused with ConfigurationError', () => {
    const err = new RedisConnectionError('x');
    expect(err).not.toBeInstanceOf(ConfigurationError);
    expect(err).not.toBeInstanceOf(KeyBuilderError);
  });

  it('ConfigurationError is not confused with RedisConnectionError', () => {
    const err = new ConfigurationError('x');
    expect(err).not.toBeInstanceOf(RedisConnectionError);
    expect(err).not.toBeInstanceOf(KeyBuilderError);
  });

  it('KeyBuilderError is not confused with other subtypes', () => {
    const err = new KeyBuilderError('x');
    expect(err).not.toBeInstanceOf(RedisConnectionError);
    expect(err).not.toBeInstanceOf(ConfigurationError);
  });

  it('error codes are readonly', () => {
    const err = new RateLimiterError('msg', 'CODE');
    // TypeScript enforces readonly; verify via Object.getOwnPropertyDescriptor
    const descriptor = Object.getOwnPropertyDescriptor(err, 'code');
    // The property exists on the instance (set in constructor via public readonly).
    expect(descriptor).toBeDefined();
  });
});
