/**
 * `moydan pack` — deterministic source archive for upload.
 *
 * Determinism matters because the studio compares uploads: entries are sorted,
 * timestamps are pinned to the zip epoch and compression is fixed, so the same
 * project tree always produces byte-identical output. The archive contains only
 * files the project format allows, so packing also fails early on the same path
 * policy the server enforces.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { sourceBytes } from '../project.ts';
import { loadProject } from '../validate.ts';
import { createDeterministicZip } from '../zip.ts';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, formatBytes, line, printIssues, warn } from '../ui.ts';

export function packCommand(args: ParsedArgs): number {
  const unknown = unknownOptions(args, ['out', 'dir']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const dir = args.positionals[0] ?? optionString(args, 'dir', '.');
  const report = loadProject({ dir });

  if (report.issues.length > 0 || !report.manifest) {
    printIssues('cannot pack', report.issues);
    line();
    warn('fix the issues above and pack again');
    return EXIT_FAILURE;
  }
  if (report.files.length === 0) throw new CliError('the project has no files to pack');

  const entries = report.files.map((file) => ({
    // `files` is already sorted by path and the writer sorts again, so the
    // archive order is stable no matter how the tree was read.
    path: file.path,
    bytes: new Uint8Array(readFileSync(resolve(report.project.root, file.path))),
  }));
  const archive = createDeterministicZip(entries);

  const slug = report.manifest.slug;
  const outPath = resolve(optionString(args, 'out', `${slug}.zip`));
  writeFileSync(outPath, archive);

  line(`${slug}  ${report.project.root}`);
  for (const file of report.files) {
    line(`  ${file.path.padEnd(48)} ${formatBytes(file.bytes).padStart(10)}  ${file.role}`);
  }
  line();
  line(`  ${report.files.length} files, ${formatBytes(sourceBytes(report.files))} source, ${formatBytes(archive.byteLength)} archive`);
  line(`  sha256 ${createHash('sha256').update(archive).digest('hex')}`);
  line();
  line(`wrote ${outPath}`);
  line('Upload it from the web studio: "moydan push" is intentionally out of scope for this alpha.');
  return EXIT_OK;
}
