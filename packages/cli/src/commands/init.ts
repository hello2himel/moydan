/**
 * `moydan init <template>` — scaffold a new project.
 *
 * The generated project is deliberately complete: a manifest that passes the
 * platform validator, an MIT `LICENSE` the manifest points at, a README with
 * the real commands, a `tsconfig.json` for editors, and one playable entry
 * module that already uses the whole SDK lifecycle.
 */

import { basename, resolve } from 'node:path';
import { optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { TEMPLATES, findTemplate, scaffoldProject, slugify, titleFromSlug } from '../scaffold.ts';
import { loadProject } from '../validate.ts';
import { CliError, EXIT_OK, EXIT_USAGE, line, printIssues, warn } from '../ui.ts';

export function initCommand(args: ParsedArgs): number {
  const unknown = unknownOptions(args, ['dir', 'title', 'slug', 'author']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const templateId = args.positionals[0];
  if (!templateId) {
    warn('a template is required.');
    line(`usage: moydan init <template> [--dir <path>]`);
    line();
    line('templates:');
    for (const template of TEMPLATES) {
      line(`  ${template.id.padEnd(10)} ${template.label}`);
      line(`  ${''.padEnd(10)} ${template.description}`);
    }
    return EXIT_USAGE;
  }
  const template = findTemplate(templateId);
  const target = resolve(optionString(args, 'dir', args.positionals[1] ?? basename(process.cwd())));
  const slug = slugify(optionString(args, 'slug', basename(target)));
  const title = optionString(args, 'title', titleFromSlug(slug));
  const author = optionString(args, 'author', 'your name');

  const result = scaffoldProject({
    template,
    dir: target,
    slug,
    title,
    author,
    year: new Date().getFullYear(),
  });

  // A scaffold that does not validate would teach creators the wrong habit, so
  // the CLI proves it before handing the directory over.
  const report = loadProject({ dir: result.root });
  if (report.issues.length > 0) {
    printIssues('the scaffold failed validation', report.issues);
    throw new CliError('internal error: the generated project did not validate');
  }

  line(`created ${slug} (${template.engine}, ${template.mechanic}) in ${result.root}`);
  for (const file of report.files) line(`  ${file.path}`);
  line();
  line('next:');
  line(`  cd ${basename(result.root)}`);
  line('  moydan dev      # preview with the real sandbox CSP');
  line('  moydan test     # lifecycle smoke checks');
  line('  moydan pack     # deterministic archive for the web studio');
  line();
  line('Remember: uploading happens in the web studio — "moydan push" is not part of this alpha.');
  return EXIT_OK;
}
