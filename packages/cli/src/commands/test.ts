/**
 * `moydan test` — lifecycle and sandbox smoke checks that need no browser.
 *
 * These are the failure modes that are cheap to catch locally and expensive to
 * discover after a release is live:
 *
 *   - a manifest the server would reject;
 *   - a bundle that does not build, or that smuggles `eval`/`new Function`
 *     (blocked by the game origin's CSP, so the game would silently do nothing);
 *   - a remote URL that only resolves on the creator's machine;
 *   - a payload that blows the first-playable budget;
 *   - a missing `pause`/`visibility`/`dispose` hook, which shows up as a frozen
 *     tab and a leaked animation frame after a rematch;
 *   - an artifact that bundles a second copy of the SDK or the engine.
 */

import { optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { BUNDLE_NAME, ENGINE_MODULE_PATH, ENTRY_DOCUMENT, SDK_MODULE_PATH, buildArtifact, type BuildResult } from '../bundle.ts';
import { readProjectFileBytes } from '../project.ts';
import { resolveRepoRoot } from '../repo.ts';
import { loadProject } from '../validate.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, failed, formatBytes, line, pass, skipped, warn } from '../ui.ts';

interface Check {
  name: string;
  /** `null` means pass; a `skipped:` prefix means "not applicable". */
  run: () => string | null;
}

const REMOTE_URL = /(?:https?|ftp|file):\/\//i;
const EVAL = /\beval\s*\(|new\s+Function\s*\(/;
const REQUIRED_HOOKS = ['start', 'pause', 'resume', 'visibility', 'dispose'];
const REQUIRED_SDK_CALLS = ['defineGame', 'api.score', 'api.ended'];

export async function testCommand(args: ParsedArgs): Promise<number> {
  const unknown = unknownOptions(args, ['dir']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const dir = args.positionals[0] ?? optionString(args, 'dir', '.');
  const report = loadProject({ dir });
  const project = report.project;

  let bundle: BuildResult | null = null;
  let buildError: string | null = null;
  if (report.manifest) {
    try {
      bundle = await buildArtifact(project, resolveRepoRoot(), { limits: report.limits });
    } catch (error) {
      buildError = error instanceof Error ? error.message : String(error);
    }
  } else {
    buildError = 'skipped: the manifest is not valid';
  }

  const bundleFile = bundle?.files.find((file) => file.path === BUNDLE_NAME) ?? null;
  const bundleText = bundleFile ? new TextDecoder().decode(bundleFile.bytes) : '';
  const engineName = report.manifest?.engine.name ?? '';

  const sourceText = (): string =>
    project.files
      .filter((file) => file.role === 'source')
      .map((file) => readProjectFileBytes(project, file.path))
      .map((bytes) => new TextDecoder().decode(bytes))
      .join('\n');

  const checks: Check[] = [
    {
      name: 'manifest validates',
      run: () =>
        report.issues.length === 0
          ? null
          : `${report.issues.length} issue(s); first: ${report.issues[0]?.path ?? '$'} ${report.issues[0]?.message ?? ''}`,
    },
    {
      name: 'entry point exists inside src/',
      run: () => {
        const entry = report.manifest?.entry ?? '';
        const file = project.files.find((candidate) => candidate.path === entry);
        if (!entry) return 'skipped: the manifest has no entry';
        if (!file) return `entry "${entry}" is not a project file`;
        return file.role === 'source' ? null : `entry "${entry}" is classified as ${file.role}, not source`;
      },
    },
    {
      name: 'every asset has a licence declaration',
      run: () => {
        const licence = report.manifest?.license;
        if (!licence) return 'skipped: the manifest is not valid';
        const undeclared = project.files
          .filter((file) => file.role === 'asset')
          .map((file) => file.path)
          .filter((path) => !licence.assets.some((entry) => entry.path === path));
        return undeclared.length === 0 ? null : `no license.assets entry for: ${undeclared.join(', ')}`;
      },
    },
    {
      name: 'bundle builds',
      run: () => buildError,
    },
    {
      name: `artifact contains ${ENTRY_DOCUMENT} and ${BUNDLE_NAME}`,
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        const paths = bundle.files.map((file) => file.path);
        const missing = [ENTRY_DOCUMENT, BUNDLE_NAME].filter((path) => !paths.includes(path));
        return missing.length === 0 ? null : `missing ${missing.join(', ')}`;
      },
    },
    {
      name: 'artifact contains no source maps or TypeScript sources',
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        const bad = bundle.files.filter((file) => /\.(map|ts|tsx|mjs|cjs)$/.test(file.path)).map((file) => file.path);
        return bad.length === 0 ? null : `not publishable: ${bad.join(', ')}`;
      },
    },
    {
      name: `SDK is imported from ${SDK_MODULE_PATH} instead of being bundled`,
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        return bundleText.includes(SDK_MODULE_PATH)
          ? null
          : `the bundle never imports ${SDK_MODULE_PATH}; an artifact must not ship a second SDK copy`;
      },
    },
    {
      name: 'bundle contains no eval() or new Function()',
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        const match = EVAL.exec(bundleText);
        return match ? `found "${match[0]}", which the game origin's CSP blocks at runtime` : null;
      },
    },
    {
      name: 'bundle references no absolute or remote URLs',
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        const match = REMOTE_URL.exec(bundleText);
        return match ? `found "${match[0]}"; keep every asset under assets/ so it ships with the artifact` : null;
      },
    },
    {
      name: 'first-playable budget respected',
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        const declared = bundle.manifest.budgets?.firstPlayableBytes;
        const limit = declared ?? report.limits.maxFirstPlayableBytes;
        return bundle.payloadBytes <= limit
          ? null
          : `payload is ${formatBytes(bundle.payloadBytes)}; budget is ${formatBytes(limit)}`;
      },
    },
    {
      name: `engine ${engineName} comes from the platform, not the artifact`,
      run: () => {
        if (!bundle) return 'skipped: the bundle did not build';
        if (engineName !== 'phaser') return null;
        return bundleText.includes(ENGINE_MODULE_PATH)
          ? null
          : `phaser is not imported from ${ENGINE_MODULE_PATH}; the artifact would ship a second engine copy`;
      },
    },
    {
      name: `lifecycle hooks are implemented (${REQUIRED_HOOKS.join(', ')})`,
      run: () => {
        const text = sourceText();
        const missing = REQUIRED_HOOKS.filter((hook) => !new RegExp(`\\b${hook}\\s*\\(`).test(text));
        return missing.length === 0 ? null : `no implementation of: ${missing.join(', ')}`;
      },
    },
    {
      name: `SDK lifecycle is used (${REQUIRED_SDK_CALLS.join(', ')})`,
      run: () => {
        const text = sourceText();
        const missing = REQUIRED_SDK_CALLS.filter((call) => !text.includes(call));
        return missing.length === 0 ? null : `not found in src/: ${missing.join(', ')}`;
      },
    },
  ];

  line(`moydan test  ${project.root}`);
  line();
  let failedCount = 0;
  for (const check of checks) {
    const problem = check.run();
    if (problem === null) {
      pass(check.name);
      continue;
    }
    if (problem.startsWith('skipped:')) {
      skipped(check.name);
      continue;
    }
    failed(`${check.name} — ${problem}`);
    failedCount += 1;
  }
  line();
  if (bundle) {
    line(`  ${bundle.files.length} artifact files, ${formatBytes(bundle.payloadBytes)} first playable payload`);
  }
  line(`  ${checks.length - failedCount} passed, ${failedCount} failed`);
  return failedCount === 0 ? EXIT_OK : EXIT_FAILURE;
}
