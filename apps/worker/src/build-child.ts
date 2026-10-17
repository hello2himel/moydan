/**
 * Build child entry point.
 *
 * This file is the *only* thing that ever runs in the isolated compile sandbox.
 * It is deliberately trivial: read the job description the parent wrote, compile
 * the materialised project, write the artifact back, exit. It holds no
 * credentials, opens no socket, and knows nothing about the database - a
 * compromise in the compiler therefore costs a child process and nothing else.
 *
 * It is launched either directly
 *   `node --max-old-space-size=<mb> <this file> <workspace>`
 * or inside a container
 *   `docker run --network=none ... node /w/build.mjs`
 * where `build.mjs` in the workspace forwards to this file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runSandboxedBuild, type SandboxResultFile, type SandboxSpec } from './bundler.ts';
import { failureFromError } from './failure.ts';

const SPEC_FILE = 'build.json';
const RESULT_FILE = 'result.json';

async function main(): Promise<void> {
  const workspace = resolve(process.argv[2] ?? process.cwd());
  const spec = JSON.parse(readFileSync(resolve(workspace, SPEC_FILE), 'utf8')) as SandboxSpec;
  const resultFile = resolve(workspace, spec.resultFile || RESULT_FILE);
  try {
    const output = await runSandboxedBuild(spec);
    const payload: SandboxResultFile = {
      ok: true,
      log: output.log,
      manifest: output.manifest,
      files: output.manifest.files.map((file) => ({
        path: file.path,
        contentType: file.contentType,
        entry: file.path === output.manifest.entry,
        size: file.size,
        sha256: file.sha256,
      })),
    };
    writeFileSync(resultFile, JSON.stringify(payload));
  } catch (error) {
    const payload: SandboxResultFile = { ok: false, failure: failureFromError(error) };
    writeFileSync(resultFile, JSON.stringify(payload));
    process.exitCode = 1;
  }
}

await main();
