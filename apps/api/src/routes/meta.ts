/**
 * Platform metadata: what this deployment supports.
 *
 * The web app renders the create form, the remix editor and the limits page from
 * this endpoint instead of hard-coding platform policy, so a deployment that
 * changes quotas or engine versions stays self-describing.
 */

import type { FastifyInstance } from 'fastify';
import {
  ENGINE_SPECS,
  PLATFORM_NAME,
  PLATFORM_VERSION,
  PROJECT_FORMAT_VERSION,
  RUNTIME_API_VERSION,
  SDK_VERSION,
  publicationLicenseOptions,
  type Limits,
} from '@moydan/core';
import type { ApiDeps } from './context.ts';
import { listTemplates, templateDescriptors } from '../services/templates.ts';
import { gameOriginBase } from '../config.ts';
import { openReportCount } from '../services/moderation.ts';

function limitsForUi(limits: Limits): Record<string, number> {
  return {
    maxFileBytes: limits.maxFileBytes,
    maxProjectFiles: limits.maxProjectFiles,
    maxSourceBytes: limits.maxSourceBytes,
    maxArchiveBytes: limits.maxArchiveBytes,
    maxArchiveExpandedBytes: limits.maxArchiveExpandedBytes,
    maxArchiveRatio: limits.maxArchiveRatio,
    maxArchiveEntries: limits.maxArchiveEntries,
    maxArtifactBytes: limits.maxArtifactBytes,
    maxArtifactFiles: limits.maxArtifactFiles,
    maxFirstPlayableBytes: limits.maxFirstPlayableBytes,
    quotaUserSourceBytes: limits.quotaUserSourceBytes,
    quotaUserReleaseBytes: limits.quotaUserReleaseBytes,
    maxGamesPerUser: limits.maxGamesPerUser,
    maxBuildJobsPerDay: limits.maxBuildJobsPerDay,
    maxCommentsPerMinute: limits.maxCommentsPerMinute,
    buildTimeoutMs: limits.buildTimeoutMs,
  };
}

export function metaRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get('/meta', async () => ({
      platform: {
        name: PLATFORM_NAME,
        version: PLATFORM_VERSION,
        sdkVersion: SDK_VERSION,
        runtimeApiVersion: RUNTIME_API_VERSION,
        projectFormatVersion: PROJECT_FORMAT_VERSION,
        environment: deps.config.nodeEnv,
      },
      origins: {
        app: deps.config.appOrigin,
        game: deps.config.gameOrigin,
        assetBase: gameOriginBase(deps.config),
      },
      engines: Object.values(ENGINE_SPECS).map((spec) => ({
        name: spec.name,
        versions: spec.versions,
        description: spec.description,
        approximateEngineBytes: spec.approximateEngineBytes,
      })),
      templates: listTemplates(deps.config.repoRoot),
      licenses: publicationLicenseOptions().map((policy) => ({
        spdx: policy.spdx,
        name: policy.name,
        family: policy.family,
        appliesToCode: policy.appliesToCode,
        appliesToAssets: policy.appliesToAssets,
        allowsSourceRemix: policy.allowsSourceRemix,
        allowsParameterRemix: policy.allowsParameterRemix,
        requiresAttribution: policy.requiresAttribution,
        sourceRedistributable: policy.sourceRedistributable,
      })),
      limits: limitsForUi(deps.config.limits),
      capabilities: {
        storageDriver: deps.config.storage.driver,
        buildIsolation: deps.config.build.useDocker ? 'container' : 'child-process',
        moderation: true,
        reports: true,
      },
    }));

    app.get('/meta/templates', async () => ({ items: templateDescriptors() }));

    app.get('/meta/maintenance', async (request) => {
      // Only admins see queue depth.
      if (request.user?.role !== 'admin') return { openReports: 0 };
      return { openReports: openReportCount(deps.db) };
    });
  };
}
