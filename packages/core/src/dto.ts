/**
 * API response contracts shared by the server and the web application.
 *
 * These types are the *public* shape of the API: they never contain password
 * hashes, session tokens, storage keys, blob digests of private files, private
 * build logs, or another account's private data.
 */

import type { RemixParameter, RemixParameterValues } from './manifest.ts';

export interface CreatorRef {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicProfile extends CreatorRef {
  bio: string;
  createdAt: string;
  stats: {
    publishedGames: number;
    remixes: number;
    followers: number;
    following: number;
    totalPlays: number;
  };
  isViewer: boolean;
  viewerFollows: boolean;
}

export interface LicenseInfo {
  spdx: string;
  name: string;
  url: string;
  family: string;
  requiresAttribution: boolean;
  sourceRedistributable: boolean;
}

export interface SourceInfo {
  license: LicenseInfo;
  /** True when the platform may show the source tree to any visitor. */
  visible: boolean;
  /** Explanation shown when `visible` is false. */
  visibilityNote: string | null;
  versionId: string;
  versionSequence: number;
  fileCount: number;
  totalBytes: number;
  treeHash: string;
  notices: string[];
  attributionText: string | null;
  /** Optional informational link. Never required for publishing. */
  repository: { provider: string; url: string } | null;
  artifactHash: string;
  publishedAt: string | null;
}

export interface RemixOrigin {
  mode: 'source' | 'parameters';
  parent: {
    gameId: string;
    title: string;
    creator: CreatorRef;
    versionId: string;
    releaseId: string | null;
    licenseSpdx: string;
  };
  rootGameId: string;
  attributionText: string;
  params: RemixParameterValues | null;
  createdAt: string;
}

export interface LineageNode {
  gameId: string;
  title: string;
  creator: CreatorRef;
  versionId: string;
  releaseId: string | null;
  licenseSpdx: string;
  mode: 'source' | 'parameters' | 'original';
  attributionText: string | null;
  createdAt: string;
}

export interface GameStats {
  reactions: number;
  comments: number;
  saves: number;
  plays: number;
  remixes: number;
  reactionBreakdown: Record<string, number>;
}

export interface ViewerState {
  reacted: string | null;
  saved: boolean;
  following: boolean;
}

export interface ReleaseSummary {
  id: string;
  sequence: number;
  status: 'building' | 'ready_for_review' | 'published' | 'failed' | 'withdrawn';
  engine: { name: string; version: string };
  apiVersion: string;
  orientation: 'portrait' | 'landscape' | 'any';
  viewport: { width: number; height: number; scale: 'fit' | 'cover' | 'stretch' };
  input: string[];
  capabilities: string[];
  entryUrl: string;
  /** Every distinct file the release needs (for the timeline/prefetch budget). */
  fileCount: number;
  totalBytes: number;
  firstPlayableBytes: number;
  artifactHash: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface GameCard {
  id: string;
  slug: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  accentColor: string;
  tags: string[];
  status: 'draft' | 'published' | 'unpublished' | 'removed' | 'suspended';
  isRemix: boolean;
  createdAt: string;
  publishedAt: string | null;
  creator: CreatorRef;
  release: ReleaseSummary | null;
  source: SourceInfo | null;
  remixOrigin: RemixOrigin | null;
  remixParameters: RemixParameter[];
  /** Parameter values that apply to the release being played (defaults + remix overrides). */
  params: RemixParameterValues;
  stats: GameStats;
  viewer: ViewerState;
  /** True when the viewer owns the game. */
  owned: boolean;
}

/** The author shape is the public creator shape; kept as an alias for readability in comments. */
export type CommentAuthor = CreatorRef;

export interface Comment {
  id: string;
  gameId: string;
  parentId: string | null;
  body: string;
  author: CommentAuthor;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  removed: boolean;
  hidden: boolean;
  viewerCanEdit: boolean;
  viewerCanDelete: boolean;
  replyCount: number;
  replies?: Comment[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  /** Total available when it is cheap to compute, otherwise null. */
  total: number | null;
}

export interface ProjectFile {
  path: string;
  size: number;
  contentType: string;
  role: 'source' | 'asset' | 'document' | 'manifest' | 'license';
  /** Content digest; identical files across projects share a digest. */
  sha256: string;
  updatedAt: string;
}

export interface DraftState {
  gameId: string;
  slug: string;
  title: string;
  description: string;
  revision: number;
  updatedAt: string;
  files: ProjectFile[];
  manifest: unknown | null;
  validation: {
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  license: {
    spdx: string;
    declaration: unknown | null;
    issues: { path: string; message: string; severity: 'error' | 'warning' }[];
  };
  capabilities: {
    remixModes: string[];
    parameters: RemixParameter[];
    engine: { name: string; version: string } | null;
    orientation: string | null;
  };
  usage: { sourceBytes: number; fileCount: number };
}

export interface BuildJob {
  id: string;
  gameId: string;
  versionId: string;
  status: 'queued' | 'building' | 'validation_failed' | 'ready_for_review' | 'published' | 'failed' | 'cancelled';
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  diagnostics: { code: string; message: string; path?: string }[];
  releaseId: string | null;
  toolchain: string;
  /** Only returned to the requesting creator. */
  log: string | null;
}

export interface ReleaseDetail extends ReleaseSummary {
  artifactManifest: {
    version: number;
    entry: string;
    files: { path: string; size: number; contentType: string; encodings?: string[]; sha256: string }[];
    totalBytes: number;
    firstPlayableBytes: number;
  };
  buildJobId: string | null;
  versionId: string;
}

export interface StorageUsageResponse {
  sourceBytes: number;
  releaseBytes: number;
  previewBytes: number;
  blobCount: number;
  gameCount: number;
  limits: {
    sourceBytes: number;
    releaseBytes: number;
    games: number;
    fileBytes: number;
    projectFiles: number;
    projectSourceBytes: number;
    artifactBytes: number;
    firstPlayableBytes: number;
  };
}

export interface ModerationReport {
  id: string;
  targetType: 'game' | 'comment' | 'user';
  targetId: string;
  targetLabel: string;
  reasonCode: string;
  details: string;
  status: 'open' | 'actioned' | 'dismissed';
  reporter: CreatorRef | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface SessionResponse {
  user: CreatorRef & { email: string; role: 'user' | 'admin'; csrfToken: string };
  devNotice?: string;
}
