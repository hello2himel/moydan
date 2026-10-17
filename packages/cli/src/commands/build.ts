/**
 * `moydan build` — bundle a project into a servable artifact.
 *
 * The output directory is exactly what a release artifact contains: the
 * generated entry document, one bundle, and the copied assets. Nothing else is
 * written, so `moydan build` output can be uploaded (or served) as-is.
 */

import { resolve } from 'node:path';
import { optionBoolean, optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { buildArtifact, describeArtifact, writeArtifact, type BuildResult } from '../bundle.ts';
import { resolveRepoRoot } from '../repo.ts';
import { loadProject } from '../validate.ts';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, line, printIssues, warn } from '../ui.ts';

export interface BuildCommandResult {
  exitCode: number;
}

export async function buildCommand(args: ParsedArgs): Promise<number> {
  const unknown = unknownOptions(args, ['out', 'minify', 'dir', 'quiet']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const dir = args.positionals[0] ?? optionString(args, 'dir', '.');
  const quiet = optionBoolean(args, 'quiet');
  const minify = optionBoolean(args, 'minify', true);
  const report = loadProject({ dir });

  if (report.issues.length > 0 || !report.manifest) {
    line(`${dir}`);
    printIssues('cannot build', report.issues);
    line();
    warn('fix the issues above (or run "moydan validate") and build again');
    return EXIT_FAILURE;
  }

  const outDir = resolve(report.project.root, optionString(args, 'out', 'dist'));
  const repoRoot = resolveRepoRoot();
  const manifest = report.manifest;
  if (!quiet) line(`building ${manifest.slug}  (${manifest.entry}, ${manifest.engine.name} ${manifest.engine.version})`);

  const result = await buildArtifact(report.project, repoRoot, { minify, limits: report.limits });
  const written = writeArtifact(result, outDir);

  if (!quiet) {
    line();
    line('  artifact');
    for (const entry of describeArtifact(result, report.limits)) line(entry);
    line();
    for (const note of result.notes) line(`  note: ${note}`);
    line();
  }
  if (result.issues.length > 0) printIssues('build issues', result.issues);
  line(`wrote ${written.length} file${written.length === 1 ? '' : 's'} to ${outDir}`);

  if (result.issues.length > 0) return EXIT_FAILURE;
  if (manifest.engine.name === 'phaser') {
    if (!quiet) {
      line();
      line('  The engine is served by the game origin at /vendor/phaser.min.js, so it is not in dist/.');
      line('  Preview with "moydan dev" (it serves the same pinned bundle) or upload with "moydan pack".');
    }
  }
  return EXIT_OK;
}

/** Shared by `moydan test`, which builds into a temporary directory. */
export async function buildOrThrow(args: ParsedArgs, outDir: string): Promise<BuildResult> {
  const report = loadProject({ dir: args.positionals[0] ?? optionString(args, 'dir', '.') });
  if (report.issues.length > 0 || !report.manifest) {
    throw new CliError('the project manifest is not valid; run "moydan validate" for details');
  }
  const result = await buildArtifact(report.project, resolveRepoRoot(), {
    minify: optionBoolean(args, 'minify', true),
    limits: report.limits,
  });
  writeArtifact(result, resolve(outDir));
  return result;
}
