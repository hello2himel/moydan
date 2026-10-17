/**
 * Source, licence and release facts.
 *
 * Moydan treats provenance as a first-class feature: what licence the code is
 * under, who must be credited, whether the tree is public, which runtime API it
 * was built against. None of that fits in a feed card, so it lives here and is
 * opened as a sheet - the game keeps playing while you read it.
 */

import type { ReactNode } from 'react';
import { RUNTIME_API_VERSION, type GameCard } from '@moydan/core';
import { formatBytes, formatDate, shortHash } from '../lib/format.ts';

export interface SourcePanelProps {
  game: GameCard;
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="kv">
      <dt className="kv__k">{label}</dt>
      <dd className="kv__v">{children}</dd>
    </div>
  );
}

export function SourcePanel({ game }: SourcePanelProps): ReactNode {
  const { source, release } = game;

  if (!source) {
    return (
      <div className="panel">
        <p className="muted">
          {game.status === 'published'
            ? 'No source information is available for this release yet.'
            : 'Source information appears once a build has been published.'}
        </p>
      </div>
    );
  }

  const apiSupported = release ? Number(release.apiVersion) <= Number(RUNTIME_API_VERSION) : null;

  return (
    <div className="panel">
      <h3 className="panel__title">Licence</h3>
      <dl className="kv-list">
        <Row label="Licence">
          <a href={source.license.url} target="_blank" rel="noreferrer noopener">
            {source.license.name}
          </a>{' '}
          <span className="muted">({source.license.spdx})</span>
        </Row>
        <Row label="Family">{source.license.family}</Row>
        {source.license.requiresAttribution ? <Row label="Attribution">Required</Row> : null}
        {source.license.sourceRedistributable ? (
          <Row label="Source redistribution">Allowed by this licence</Row>
        ) : (
          <Row label="Source redistribution">Not granted by this licence</Row>
        )}
      </dl>

      {source.attributionText ? (
        <>
          <h3 className="panel__title">Attribution</h3>
          <p className="panel__prose">{source.attributionText}</p>
        </>
      ) : null}

      {source.notices.length > 0 ? (
        <>
          <h3 className="panel__title">Notices</h3>
          <ul className="panel__list">
            {source.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="panel__title">Source</h3>
      <dl className="kv-list">
        <Row label="Visibility">
          {source.visible ? 'Anyone can read this tree.' : (source.visibilityNote ?? 'The source is not public.')}
        </Row>
        <Row label="Version">
          <code>{shortHash(source.versionId, 10)}</code> (v{source.versionSequence})
        </Row>
        <Row label="Tree hash">
          <code title={source.treeHash}>{shortHash(source.treeHash, 10)}</code>
        </Row>
        <Row label="Files">
          {source.fileCount} &middot; {formatBytes(source.totalBytes)}
        </Row>
        {source.repository ? (
          <Row label="Repository">
            <a href={source.repository.url} target="_blank" rel="noreferrer noopener">
              {source.repository.provider}
            </a>
          </Row>
        ) : null}
        <Row label="Published">{formatDate(source.publishedAt)}</Row>
      </dl>

      {release ? (
        <>
          <h3 className="panel__title">Release</h3>
          <dl className="kv-list">
            <Row label="Status">{release.status}</Row>
            <Row label="Engine">
              {release.engine.name} {release.engine.version}
            </Row>
            <Row label="Runtime API">
              v{release.apiVersion}{' '}
              {apiSupported === null ? null : apiSupported ? '· supported here' : '· newer than this platform'}
            </Row>
            <Row label="Orientation">{release.orientation}</Row>
            <Row label="First playable">{formatBytes(release.firstPlayableBytes)}</Row>
            <Row label="Total">{formatBytes(release.totalBytes)}</Row>
            <Row label="Artifact">
              <code title={release.artifactHash}>{shortHash(release.artifactHash, 10)}</code>
            </Row>
            {release.capabilities.length > 0 ? (
              <Row label="Capabilities">{release.capabilities.join(', ')}</Row>
            ) : null}
            {release.input.length > 0 ? <Row label="Input">{release.input.join(', ')}</Row> : null}
          </dl>
        </>
      ) : null}
    </div>
  );
}