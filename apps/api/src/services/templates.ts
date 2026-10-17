/**
 * Starter templates.
 *
 * Templates are *ordinary* games: they live in `examples/` as real projects with
 * their own manifests and licences, are built by the same pipeline as anything
 * else, and are copied into a new draft byte for byte. Nothing about them is
 * privileged in the runtime.
 *
 * If the examples directory is missing (for example a deployment that ships only
 * the server bundle), project creation fails with a clear error instead of
 * silently producing an empty project.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { errors, classifyProjectPath, type ProjectFileRole } from '@moydan/core';

export interface TemplateFile {
  path: string;
  content: Uint8Array;
  role: ProjectFileRole;
}

export interface TemplateDescriptor {
  id: string;
  name: string;
  description: string;
  engine: string;
  mechanic: string;
}

interface TemplateSource {
  descriptor: TemplateDescriptor;
  directory: string;
}

const TEMPLATE_SOURCES: TemplateSource[] = [
  {
    descriptor: {
      id: 'bounce-dodge',
      name: 'Bounce Dodge',
      description: 'Reflex dodge game on the platform Canvas runtime: move to avoid falling blocks.',
      engine: 'canvas2d',
      mechanic: 'movement / dodging',
    },
    directory: 'bounce-dodge',
  },
  {
    descriptor: {
      id: 'pulse-tap',
      name: 'Pulse Tap',
      description: 'Timing/rhythm game built with Phaser 4: tap when the ring lines up with the band.',
      engine: 'phaser',
      mechanic: 'timing / rhythm',
    },
    directory: 'pulse-tap',
  },
  {
    descriptor: {
      id: 'pattern-grid',
      name: 'Pattern Grid',
      description: 'Pattern-recognition puzzle: repeat the sequence, one step longer each round.',
      engine: 'canvas2d',
      mechanic: 'puzzle / memory',
    },
    directory: 'pattern-grid',
  },
];

export function examplesRoot(repoRoot: string): string {
  return resolve(repoRoot, 'examples');
}

export function listTemplates(repoRoot: string): TemplateDescriptor[] {
  return TEMPLATE_SOURCES.filter((source) => {
    try {
      return statSync(join(examplesRoot(repoRoot), source.directory)).isDirectory();
    } catch {
      return false;
    }
  }).map((source) => source.descriptor);
}

export function templateExists(repoRoot: string, templateId: string): boolean {
  return listTemplates(repoRoot).some((template) => template.id === templateId);
}

/** Read a template's files, applying the same path policy as an upload. */
export function readTemplateFiles(repoRoot: string, templateId: string): TemplateFile[] {
  const source = TEMPLATE_SOURCES.find((entry) => entry.descriptor.id === templateId);
  if (!source) throw errors.notFound(`Unknown template "${templateId}".`);
  const root = join(examplesRoot(repoRoot), source.directory);
  const files: TemplateFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      const relativePath = relative(root, full).split(sep).join('/');
      const role = classifyProjectPath(relativePath, { allowTests: true });
      if (!role) continue;
      files.push({ path: relativePath, content: new Uint8Array(readFileSync(full)), role });
    }
  };
  walk(root);
  if (files.length === 0) {
    throw errors.internal(`Template "${templateId}" has no files. Run the app from the repository root.`);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function templateDescriptors(): TemplateDescriptor[] {
  return TEMPLATE_SOURCES.map((source) => source.descriptor);
}
