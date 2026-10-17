/**
 * Remix lineage.
 *
 * Every game on Moydan is either original or a derivative of an earlier one.
 * The chain is what makes attribution enforceable, so it is rendered as an
 * explicit tree (this game -> parent -> grandparent ...) instead of a sentence
 * somebody has to trust.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GameCard, LineageNode, RemixOrigin } from '@moydan/core';
import { formatDate } from '../lib/format.ts';
import { Avatar } from './Avatar.tsx';

export interface LineageViewProps {
  game: GameCard;
  origin: RemixOrigin | null;
  /** Ordered direct parent first, oldest ancestor last. */
  ancestors: LineageNode[];
}

interface ChainEntry {
  gameId: string;
  title: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  licenseSpdx: string;
  mode: LineageNode['mode'];
  attributionText: string | null;
  createdAt: string;
}

function entriesFor(origin: RemixOrigin | null, ancestors: LineageNode[]): ChainEntry[] {
  const entries: ChainEntry[] = [];
  const seen = new Set<string>();

  const fromOrigin: ChainEntry | null = origin
    ? {
        gameId: origin.parent.gameId,
        title: origin.parent.title,
        handle: origin.parent.creator.handle,
        displayName: origin.parent.creator.displayName,
        avatarUrl: origin.parent.creator.avatarUrl,
        licenseSpdx: origin.parent.licenseSpdx,
        mode: origin.mode,
        attributionText: origin.attributionText,
        createdAt: origin.createdAt,
      }
    : null;

  if (fromOrigin) {
    entries.push(fromOrigin);
    seen.add(fromOrigin.gameId);
  }

  for (const node of ancestors) {
    if (seen.has(node.gameId)) continue;
    seen.add(node.gameId);
    entries.push({
      gameId: node.gameId,
      title: node.title,
      handle: node.creator.handle,
      displayName: node.creator.displayName,
      avatarUrl: node.creator.avatarUrl,
      licenseSpdx: node.licenseSpdx,
      mode: node.mode,
      attributionText: node.attributionText,
      createdAt: node.createdAt,
    });
  }

  return entries;
}

const MODE_LABELS: Record<ChainEntry['mode'], string> = {
  original: 'Original',
  parameters: 'Parameter remix',
  source: 'Source remix',
};

export function LineageView({ game, origin, ancestors }: LineageViewProps): ReactNode {
  const chain = entriesFor(origin, ancestors);

  if (!origin && chain.length === 0) {
    return (
      <div className="panel">
        <p className="muted">
          {game.isRemix
            ? 'This game is a remix, but its parent is no longer available.'
            : 'This is an original game - nothing to attribute.'}
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 className="panel__title">Lineage</h3>
      <ol className="lineage">
        <li className="lineage__node lineage__node--self">
          <div className="lineage__row">
            <Avatar url={game.creator.avatarUrl} name={game.creator.displayName} size="xs" />
            <div className="lineage__text">
              <Link className="lineage__title" to={`/games/${game.id}`}>
                {game.title}
              </Link>
              <p className="lineage__meta">
                {MODE_LABELS.original} &middot; @{game.creator.handle}
              </p>
            </div>
          </div>
        </li>
        {chain.map((entry) => (
          <li key={entry.gameId} className="lineage__node">
            <div className="lineage__row">
              <Avatar url={entry.avatarUrl} name={entry.displayName} size="xs" />
              <div className="lineage__text">
                <Link className="lineage__title" to={`/games/${entry.gameId}`}>
                  {entry.title}
                </Link>
                <p className="lineage__meta">
                  {MODE_LABELS[entry.mode]} of a {entry.licenseSpdx} work by @{entry.handle} &middot;{' '}
                  {formatDate(entry.createdAt)}
                </p>
                {entry.attributionText ? <p className="lineage__attribution">{entry.attributionText}</p> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}