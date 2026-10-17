/**
 * Platform metadata (`routes/meta.ts`) and the publication licence catalogue
 * (`routes/profiles.ts`).
 *
 * The UI must never hard-code a limit, a template list or a licence: a
 * deployment changes those through configuration, and `/api/meta` is the
 * self-describing source of truth.
 */

import { apiJson } from './client.ts';

export interface TemplateDescriptor {
  id: string;
  name: string;
  description: string;
  engine: string;
  mechanic: string;
}

export interface PlatformLicense {
  spdx: string;
  name: string;
  family: string;
  appliesToCode?: boolean;
  appliesToAssets?: boolean;
  allowsSourceRemix?: boolean;
  allowsParameterRemix?: boolean;
  requiresAttribution?: boolean;
  sourceRedistributable?: boolean;
}

export interface PlatformMeta {
  platform: {
    name: string;
    version: string;
    sdkVersion: string;
    runtimeApiVersion: string;
    projectFormatVersion: number | string;
    environment: string;
  };
  origins: { app: string; game: string; assetBase: string };
  engines: { name: string; versions: string[]; description: string; approximateEngineBytes: number }[];
  licenses: PlatformLicense[];
  limits: Record<string, number>;
  capabilities: Record<string, unknown>;
}

export function getTemplates(signal?: AbortSignal): Promise<{ items: TemplateDescriptor[] }> {
  return apiJson<{ items: TemplateDescriptor[] }>('/api/meta/templates', { signal });
}

export function getMeta(signal?: AbortSignal): Promise<PlatformMeta> {
  return apiJson<PlatformMeta>('/api/meta', { signal });
}

export function getLicenses(signal?: AbortSignal): Promise<{ items: PlatformLicense[] }> {
  return apiJson<{ items: PlatformLicense[] }>('/api/licenses', { signal });
}