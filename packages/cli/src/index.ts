/**
 * `moydan` — the creator CLI.
 *
 * The command line is the whole documentation surface of this alpha: there is
 * no README to fall back on, so `moydan help` (and `--help` on every command)
 * has to be complete. Two rules shape everything here:
 *
 *   1. Never lie about the platform. Validation, budgets and path policy come
 *      from `@moydan/core`, the same modules the API uses at upload time, so a
 *      green run locally means a green upload.
 *   2. Never leak a secret. Session tokens are written 0600 and only ever shown
 *      masked, and password input never echoes.
 *
 * Exit codes: 0 success, 1 the project/build/check failed, 2 the invocation or
 * the command itself is wrong (`push` is intentionally not implemented yet).
 */

import { BUILD_TOOLCHAIN_ID, PLATFORM_NAME, PLATFORM_VERSION, SDK_VERSION } from '@moydan/core';
import { parseArgs, type ParsedArgs } from './args.ts';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/auth.ts';
import { buildCommand } from './commands/build.ts';
import { devCommand } from './commands/dev.ts';
import { initCommand } from './commands/init.ts';
import { packCommand } from './commands/pack.ts';
import { testCommand } from './commands/test.ts';
import { validateCommand } from './commands/validate.ts';
import { TEMPLATES } from './scaffold.ts';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, fail, line } from './ui.ts';

const USAGE = `${PLATFORM_NAME} CLI ${PLATFORM_VERSION} (toolchain ${BUILD_TOOLCHAIN_ID}, SDK ${SDK_VERSION})

usage: moydan <command> [options]

  init <template> [--dir <path>]   scaffold a project from a template
  validate [dir] [--json]          validate game.json, licences and assets
  build [dir] [--out dist]         bundle to an artifact and report the budget
  dev [dir] [--port 5175]          watch + preview with the real CSP
  test [dir]                       lifecycle smoke checks, no browser needed
  pack [dir] [--out slug.zip]      deterministic archive for the studio
  login [--email <address>]        sign in and store a session token (0600)
  whoami                           show the stored session
  logout                           revoke the session and forget the token
  push                             not available in this alpha (see below)
  help                             this text

templates for init:
${TEMPLATES.map((template) => `  ${template.id.padEnd(9)} ${template.label}`).join('\n')}

environment:
  MOYDAN_API_ORIGIN   API origin for login/whoami (default http://localhost:8787)
  MOYDAN_EMAIL        e-mail for "moydan login"
  MOYDAN_PASSWORD     password for "moydan login" (preferred over typing it)
  NO_COLOR            disable colour in scripts/dev.mjs output

"moydan push" is intentionally out of scope for the first alpha: uploads are
reviewed and published from the web studio, which is the only place that can
show the moderation and quota state a release depends on. Build and validate
locally with "moydan build" / "moydan test", produce an archive with
"moydan pack", then upload that archive from the studio.

exit codes: 0 ok, 1 project/build/check failed, 2 wrong usage or unavailable command`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === null || args.command === 'help' || args.options.has('help')) {
    line(USAGE);
    return args.command === null && !args.options.has('help') ? EXIT_USAGE : EXIT_OK;
  }

  try {
    switch (args.command) {
      case 'init':
        return initCommand(args);
      case 'validate':
      case 'check':
        return validateCommand(args);
      case 'build':
        return await buildCommand(args);
      case 'dev':
        return await devCommand(args);
      case 'test':
        return await testCommand(args);
      case 'pack':
        return packCommand(args);
      case 'login':
        return await loginCommand(args);
      case 'whoami':
        return await whoamiCommand(args);
      case 'logout':
        return await logoutCommand();
      case 'push':
        line('"moydan push" is not available in this alpha.');
        line();
        line('Uploads are published from the web studio, which is the only place that can');
        line('show the moderation state, quota and release history a publish depends on.');
        line();
        line('  1. moydan validate   # fail locally, not at upload time');
        line('  2. moydan test       # lifecycle and sandbox smoke checks');
        line('  3. moydan pack       # deterministic <slug>.zip');
        line('  4. open the studio and upload the archive');
        return EXIT_USAGE;
      default:
        fail(`unknown command "${args.command}"`);
        line(USAGE);
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof CliError) {
      fail(error.message);
      return error.exitCode;
    }
    fail(error instanceof Error ? `${error.message}` : String(error));
    if (process.env.MOYDAN_DEBUG === '1' && error instanceof Error && error.stack) line(error.stack);
    return EXIT_FAILURE;
  }
}

export { parseArgs };
export type { ParsedArgs };
