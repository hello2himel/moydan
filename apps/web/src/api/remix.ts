/**
 * Remixing (`routes/catalog.ts` for capabilities, `routes/projects.ts` for the
 * draft).
 *
 * The two modes are different products, not two flavours of the same request:
 * a parameter remix inherits the parent's code and only changes declared
 * values, while a source remix copies the tree into a new draft the creator is
 * expected to modify. Both are handled here, both end in a studio.
 */

import type { GameCard, DraftState, RemixParameter, RemixParameterValues } from '@moydan/core';
import { apiJson, apiSend } from './client.ts';

export interface RemixOptions {
  gameId: string;
  title: string;
  licenseSpdx: string;
  allowed: boolean;
  reason: string | null;
  modes: string[];
  parameters: RemixParameter[];
  allowedChildLicenses: string[];
}

export type RemixMode = 'parameters' | 'source';

export interface CreateRemixInput {
  mode: RemixMode;
  title?: string;
  slug?: string;
  params?: RemixParameterValues | null;
  childLicenseSpdx?: string;
}

export interface CreatedRemix {
  game: GameCard;
  draft: DraftState;
}

export function getRemixOptions(gameId: string, signal?: AbortSignal): Promise<RemixOptions> {
  return apiJson<RemixOptions>(`/api/games/${gameId}/remix-options`, { signal });
}

export function createRemix(gameId: string, input: CreateRemixInput): Promise<CreatedRemix> {
  return apiSend<CreatedRemix>('POST', `/api/games/${gameId}/remix`, input);
}

/** Narrow an unknown mode list (the API sends `string[]`) to real modes. */
export function parseRemixModes(modes: readonly string[]): RemixMode[] {
  const parsed: RemixMode[] = [];
  for (const mode of modes) {
    if (mode === 'parameters' || mode === 'source') parsed.push(mode);
  }
  return parsed;
}

/** Defaults for the parameter editor, straight from the parent's declarations. */
export function defaultRemixValues(parameters: readonly RemixParameter[]): RemixParameterValues {
  const values: RemixParameterValues = {};
  for (const parameter of parameters) values[parameter.key] = parameter.default;
  return values;
}

/** Every declared parameter must be present, so an untouched form is valid. */
export function validateRemixValues(
  parameters: readonly RemixParameter[],
  values: RemixParameterValues,
): { ok: boolean; issues: { key: string; message: string }[] } {
  const issues: { key: string; message: string }[] = [];
  for (const parameter of parameters) {
    const value = values[parameter.key];
    switch (parameter.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ key: parameter.key, message: 'Enter a number.' });
        } else if (value < parameter.min || value > parameter.max) {
          issues.push({ key: parameter.key, message: `Must be between ${parameter.min} and ${parameter.max}.` });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') issues.push({ key: parameter.key, message: 'Choose on or off.' });
        break;
      case 'select':
        if (typeof value !== 'string' || !parameter.options.some((option) => option.value === value)) {
          issues.push({ key: parameter.key, message: 'Choose one of the offered options.' });
        }
        break;
      case 'color':
        if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
          issues.push({ key: parameter.key, message: 'Use a hex colour such as #7c5cff.' });
        }
        break;
    }
  }
  return { ok: issues.length === 0, issues };
}