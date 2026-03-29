#!/usr/bin/env node
/**
 * @fileoverview AWS Rate Limiter Admin CLI
 *
 * A zero-dependency command-line tool for inspecting and managing the rate
 * limiter in production. Commands are dispatched by name from argv[2].
 *
 * Usage:
 *   rate-limiter-admin status --ip <ip> [--userId <id>] [--route <route>] [--method <method>]
 *   rate-limiter-admin reset --dimension ip|user|route|user-route --identifier <value>
 *   rate-limiter-admin top-users [--dimension user] [--limit 10] [--window 60]
 *   rate-limiter-admin health [--verbose]
 *
 * Environment:
 *   RATE_LIMITER_REDIS_URL   Redis connection URL (required when no config file)
 *   RATE_LIMITER_REDIS_AUTH  Redis auth token (optional)
 *   RATE_LIMITER_CONFIG      Path to YAML config file (optional)
 */

import * as fs from 'fs';
import type { Redis, Cluster } from 'ioredis';

import { RateLimiterConfig } from '../../src/core/types';
import { RedisClientManager } from '../../src/redis/client';
import { runStatusCommand, StatusArgs } from './commands/status';
import { runResetCommand, ResetArgs, ResetDimension } from './commands/reset';
import { runTopUsersCommand, TopUsersArgs } from './commands/top-users';
import { runHealthCommand, HealthArgs } from './commands/health';

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * Parses `--key value` pairs from a raw argv array.
 *
 * Boolean flags (a key not followed by a non-flag value) are set to `"true"`.
 *
 * @param argv Array of raw argument strings (typically `process.argv.slice(3)`).
 * @returns A record mapping flag names (without `--`) to their string values.
 *
 * @example
 * parseArgs(['--ip', '1.2.3.4', '--verbose'])
 * // => { ip: '1.2.3.4', verbose: 'true' }
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key?.startsWith('--')) {
      const name = key.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        args[name] = val;
        i++;
      } else {
        args[name] = 'true';
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link RateLimiterConfig} from environment variables.
 *
 * When `RATE_LIMITER_REDIS_URL` is set, creates a single-node config with an
 * empty default rule so the RateLimiter can connect.
 *
 * @param redisUrl Redis connection URL.
 * @param password Optional Redis AUTH password.
 * @returns Minimal rate limiter config.
 */
function buildConfigFromEnv(redisUrl: string, password?: string): RateLimiterConfig {
  return {
    redis: {
      url: redisUrl,
      ...(password !== undefined ? { password } : {}),
    },
    rules: [
      {
        name: 'cli-default',
        limits: {
          ip: { limit: 1000, window: 60 },
        },
      },
    ],
  };
}

/**
 * Loads the rate limiter config from a YAML file path using dynamic require.
 *
 * Falls back to a best-effort JSON parse when js-yaml is unavailable.
 * The YAML file must export/contain a valid {@link RateLimiterConfig} object.
 *
 * @param configPath Absolute or relative path to the YAML config file.
 * @returns Parsed config object.
 * @throws {Error} If the file cannot be read or parsed.
 */
function loadConfigFromFile(configPath: string): RateLimiterConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as { load: (s: string) => unknown };
    return yaml.load(raw) as RateLimiterConfig;
  } catch {
    // js-yaml not installed — attempt JSON parse as fallback
    return JSON.parse(raw) as RateLimiterConfig;
  }
}

// ---------------------------------------------------------------------------
// Direct Redis client (for commands that need raw access: top-users, health)
// ---------------------------------------------------------------------------

/**
 * Establishes a direct ioredis connection for commands that need raw Redis access.
 *
 * @param config Rate limiter config (used for connection details).
 * @returns Connected Redis or Cluster client.
 */
async function connectRawClient(config: RateLimiterConfig): Promise<Redis | Cluster> {
  const manager = new RedisClientManager({ config: config.redis });
  return manager.connect() as Promise<Redis | Cluster>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main CLI dispatcher.
 *
 * Reads `process.argv`, resolves config, and dispatches to the appropriate
 * command handler. Exits with code 1 on error.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  // ---- Print help if no command or --help flag ----
  if (command === undefined || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  // ---- Resolve config ----
  const configPath = process.env['RATE_LIMITER_CONFIG'];
  const redisUrl = process.env['RATE_LIMITER_REDIS_URL'];
  const redisAuth = process.env['RATE_LIMITER_REDIS_AUTH'];

  let config: RateLimiterConfig;

  if (configPath !== undefined) {
    try {
      config = loadConfigFromFile(configPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: failed to load config from "${configPath}": ${msg}`);
      process.exit(1);
    }
  } else if (redisUrl !== undefined) {
    config = buildConfigFromEnv(redisUrl, redisAuth);
  } else {
    console.error(
      'Error: RATE_LIMITER_REDIS_URL environment variable is required when no config file is set.\n' +
        'Set RATE_LIMITER_CONFIG to a YAML config path or RATE_LIMITER_REDIS_URL to the Redis URL.',
    );
    process.exit(1);
  }

  // ---- Dispatch command ----
  try {
    switch (command) {
      case 'status': {
        const statusArgs: StatusArgs = {
          ip: args['ip'],
          userId: args['userId'],
          route: args['route'],
          method: args['method'],
        };
        await runStatusCommand(statusArgs, config);
        break;
      }

      case 'reset': {
        const dimension = args['dimension'];
        const identifier = args['identifier'];

        if (dimension === undefined) {
          console.error('Error: --dimension is required for the reset command');
          process.exit(1);
        }
        if (identifier === undefined) {
          console.error('Error: --identifier is required for the reset command');
          process.exit(1);
        }

        const resetArgs: ResetArgs = {
          dimension: dimension as ResetDimension,
          identifier,
        };
        await runResetCommand(resetArgs, config);
        break;
      }

      case 'top-users': {
        const topArgs: TopUsersArgs = {
          dimension: args['dimension'],
          limit: args['limit'] !== undefined ? parseInt(args['limit'], 10) : undefined,
          window: args['window'] !== undefined ? parseInt(args['window'], 10) : undefined,
        };

        const client = await connectRawClient(config);
        try {
          await runTopUsersCommand(topArgs, config, client);
        } finally {
          await (client as Redis).quit();
        }
        break;
      }

      case 'health': {
        const healthArgs: HealthArgs = {
          verbose: args['verbose'] === 'true',
        };

        const client = await connectRawClient(config);
        try {
          await runHealthCommand(healthArgs, config, client);
        } finally {
          await (client as Redis).quit();
        }
        break;
      }

      default:
        console.error(`Error: unknown command "${command}"`);
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

/**
 * Prints the CLI usage/help text to stdout.
 */
function printHelp(): void {
  console.log(`
AWS Rate Limiter Admin CLI

Usage:
  rate-limiter-admin <command> [options]

Commands:
  status      Show current rate limit status for a request context
  reset       Delete rate limit keys for a dimension/identifier
  top-users   List top N identifiers by request volume
  health      Check Redis connection health

Options for status:
  --ip <address>      IP address to check (default: 0.0.0.0)
  --userId <id>       Optional user identifier
  --route <path>      Route path (default: /)
  --method <method>   HTTP method (default: GET)

Options for reset:
  --dimension <dim>        ip | user | route | user-route (required)
  --identifier <value>     Identifier value (required)

Options for top-users:
  --dimension <dim>   Dimension to scan: user | ip | route (default: user)
  --limit <n>         Number of results to show (default: 10)
  --window <seconds>  Window size in seconds (default: 60)

Options for health:
  --verbose           Also print Redis memory statistics

Environment Variables:
  RATE_LIMITER_REDIS_URL   Redis connection URL (required if no config file)
  RATE_LIMITER_REDIS_AUTH  Redis auth token (optional)
  RATE_LIMITER_CONFIG      Path to YAML config file (optional)
`);
}

// Only run main() when this file is executed directly (not when imported by tests).
if (require.main === module) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error: ${msg}`);
    process.exit(1);
  });
}
