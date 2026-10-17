/**
 * `moydan validate` — run the real manifest validator over a project.
 *
 * Why not a private, "nicer" validator: creators must be able to reproduce a
 * publish failure locally, so this calls `validateGameManifest` from
 * `@moydan/core` — the same function the API runs on upload — and then adds the
 * local checks that need the files on disk (asset bytes, stray files).
 */

import { optionBoolean, optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { loadProject, projectSummary } from '../validate.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, line, printIssues, warn } from '../ui.ts';

export function validateCommand(args: ParsedArgs): number {
  const unknown = unknownOptions(args, ['dir', 'json', 'quiet']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const dir = args.positionals[0] ?? optionString(args, 'dir', '.');
  const quiet = optionBoolean(args, 'quiet');
  const report = loadProject({ dir });

  if (args.options.has('json')) {
    line(
      JSON.stringify(
        {
          ok: report.issues.length === 0,
          root: report.project.root,
          issues: report.issues,
          warnings: report.warnings,
          manifest: report.manifest,
        },
        null,
        2,
      ),
    );
    return report.issues.length === 0 ? EXIT_OK : EXIT_FAILURE;
  }

  const label = report.manifest ? report.manifest.slug : 'project';
  line(`${label}  ${report.project.root}`);
  line();

  if (report.issues.length > 0) {
    printIssues('invalid', report.issues);
    line();
  }
  for (const message of report.warnings) warn(message);

  if (report.issues.length === 0 && !quiet) {
    for (const entry of projectSummary(report)) line(`  ${entry}`);
    const assetCount = report.files.filter((file) => file.role === 'asset').length;
    const declaredAssets = report.manifest?.license.assets.length ?? 0;
    line();
    line(
      `ok  ${report.files.length} project files, ${assetCount} assets, ${declaredAssets} asset licence declaration${
        declaredAssets === 1 ? '' : 's'
      }`,
    );
  }
  return report.issues.length === 0 ? EXIT_OK : EXIT_FAILURE;
}
