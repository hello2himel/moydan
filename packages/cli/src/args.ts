/**
 * Argument parsing for the `moydan` CLI.
 *
 * Why hand-rolled: the CLI is bundled with `--packages=external`, so anything it
 * imports has to exist in the creator's `node_modules`. A parser is the one
 * dependency a build tool should not have, and the grammar we need is small:
 * `moydan <command> [positional] [--flag] [--key value] [--key=value] [--no-key]`.
 */

export interface ParsedArgs {
  /** First positional token after the program name, e.g. `validate`. */
  command: string | null;
  /** Remaining positional tokens. */
  positionals: string[];
  /** `--key value` becomes the string; a bare `--key` becomes `true`. */
  options: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body === '') {
      onlyPositionals = true;
      continue;
    }
    const equals = body.indexOf('=');
    if (equals !== -1) {
      options.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (body.startsWith('no-')) {
      options.set(body.slice(3), false);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      options.set(body, next);
      index += 1;
      continue;
    }
    options.set(body, true);
  }

  const [command, ...rest] = positionals;
  return { command: command ?? null, positionals: rest, options };
}

/** Options the command understands; anything else is a usage error. */
export function unknownOptions(args: ParsedArgs, allowed: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const key of args.options.keys()) {
    if (!allowed.includes(key)) unknown.push(`--${key}`);
  }
  return unknown;
}

export function hasOption(args: ParsedArgs, key: string): boolean {
  return args.options.has(key);
}

export function optionString(args: ParsedArgs, key: string, fallback = ''): string {
  const value = args.options.get(key);
  if (typeof value === 'string') return value;
  return fallback;
}

export function optionBoolean(args: ParsedArgs, key: string, fallback = false): boolean {
  const value = args.options.get(key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'false' && value !== '0';
  return fallback;
}

export function optionNumber(args: ParsedArgs, key: string, fallback: number): number {
  const value = args.options.get(key);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
