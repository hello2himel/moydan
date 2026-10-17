/**
 * The game player.
 *
 * This component owns the sandbox boundary and nothing else: it hands the
 * release `entryUrl` to `GameHost` from `@moydan/runtime`, lets the runtime's
 * playback controller decide when the game may run, and translates host state
 * into something a person can read (loading, ready, paused, ended, error).
 *
 * It deliberately does *not* implement any postMessage handling of its own -
 * the runtime already validates every message, rate limits the chatty ones and
 * mediates storage/share/link-out.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GameHost, observePlayback, type HostState } from '@moydan/runtime';
import type { GameCard } from '@moydan/core';
import { createPlaySession, heartbeat as playHeartbeat, reportSession } from '../api/play.ts';
import { createShareLink } from '../api/social.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { resolveEntry } from '../lib/player.ts';
import { Button, IconButton } from './Button.tsx';
import { Skeleton } from './Skeleton.tsx';

const HEARTBEAT_INTERVAL_MS = 15_000;
/** How long a game may stay in the handshake before we say something. */
const STALL_AFTER_MS = 12_000;

export interface GamePlayerProps {
  game: GameCard;
  /** Preview grant URL. Overrides the release entry and skips play sessions. */
  entryUrl?: string | null;
  preview?: boolean;
  /** Called when the game (or the player) finished a run. */
  onEnded?: (reason: string) => void;
  /** Scrolls to the next item in the feed; hidden when omitted. */
  onNext?: (() => void) | undefined;
  nextLabel?: string;
  /** Feed cards hide the heavier chrome so the game gets the whole frame. */
  compact?: boolean;
  className?: string;
}

export function GamePlayer({
  game,
  entryUrl,
  preview = false,
  onEnded,
  onNext,
  nextLabel = 'Next game',
  compact = false,
  className,
}: GamePlayerProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<GameHost | null>(null);
  const startedAtRef = useRef(0);
  const reportedRef = useRef(false);
  const lastScoreRef = useRef<{ value: number; unit?: string; difficulty?: string } | null>(null);

  const [attempt, setAttempt] = useState(0);
  const [hostState, setHostState] = useState<HostState>('idle');
  const [muted, setMuted] = useState(true);
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [score, setScore] = useState<{ value: number; unit?: string } | null>(null);
  const [stalled, setStalled] = useState(false);

  // Callbacks are read through a ref so an inline handler from the parent can
  // never tear down and rebuild the host (which would restart the game).
  const onEndedRef = useRef<((reason: string) => void) | undefined>(undefined);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const release = game.release;
  const releaseId = release?.id ?? null;

  const session = useQuery({
    queryKey: queryKeys.playSession(releaseId ?? 'none'),
    queryFn: () => {
      if (!releaseId) throw new Error('This game has no playable release.');
      return createPlaySession(game.id, releaseId);
    },
    enabled: Boolean(releaseId) && !preview,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: false,
  });

  const sourceUrl = preview ? (entryUrl ?? null) : (session.data?.entryUrl ?? entryUrl ?? release?.entryUrl ?? null);
  const entry = useMemo(() => resolveEntry(sourceUrl), [sourceUrl]);
  const sessionId = session.data?.sessionId ?? 'preview';

  // The host is only created once the play session has settled: its `entryUrl`
  // and session id are part of the handshake, so rebuilding the host later
  // would restart the game the viewer already started.
  const sessionSettled = preview || !releaseId || !session.isPending;

  const handleShare = useCallback(
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const link = await createShareLink(game.id);
        if (typeof navigator.share === 'function') {
          await navigator.share({ title: link.title || game.title, url: link.url });
        } else {
          await navigator.clipboard.writeText(link.url);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'share failed' };
      }
    },
    [game.id, game.title],
  );

  const handleOpenLink = useCallback(async (url: string): Promise<{ ok: boolean; error?: string }> => {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    return opened ? { ok: true } : { ok: false, error: 'the browser blocked the new tab' };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!entry || !container) return;
    if (!releaseId && !preview) return;
    if (!sessionSettled) return;

    reportedRef.current = false;
    lastScoreRef.current = null;
    startedAtRef.current = performance.now();
    setFatalMessage(null);
    setScore(null);
    setHostState('idle');

    const host = new GameHost({
      container,
      src: entry.src,
      gameOrigin: entry.origin,
      gameId: game.id,
      releaseId: releaseId ?? `preview-${game.id}`,
      gameTitle: game.title,
      params: game.params,
      capabilities: release?.capabilities ?? [],
      apiVersion: release?.apiVersion ?? '1',
      viewport: release?.viewport ?? { width: 720, height: 1280, scale: 'fit' },
      orientation: release?.orientation ?? 'portrait',
      sessionId,
      preview,
      muted: true,
      onStateChange: (state) => setHostState(state),
      onFirstFrame: () => setHostState((state) => (state === 'loading' || state === 'ready' ? 'running' : state)),
      onScore: (payload) => {
        lastScoreRef.current = { value: payload.value, unit: payload.unit, difficulty: payload.difficulty };
        setScore({ value: payload.value, unit: payload.unit });
      },
      onError: (payload) => {
        if (payload.fatal) setFatalMessage(payload.message);
      },
      onEnded: (payload) => {
        onEndedRef.current?.(payload.reason);
      },
      onShare: handleShare,
      onOpenLink: handleOpenLink,
    });
    hostRef.current = host;
    const stopPlayback = observePlayback(host, container, { muted: true, threshold: 0.6 });

    return () => {
      stopPlayback();
      host.dispose();
      hostRef.current = null;
    };
  }, [
    entry,
    game.id,
    game.params,
    game.title,
    releaseId,
    preview,
    release?.apiVersion,
    release?.capabilities,
    release?.orientation,
    release?.viewport,
    sessionId,
    sessionSettled,
    attempt,
    handleShare,
    handleOpenLink,
  ]);

  // Platform-side play heartbeat: how long and how smoothly the game ran.
  useEffect(() => {
    if (hostState !== 'running' || !session.data) return;
    const timer = window.setInterval(() => {
      const stats = hostRef.current?.stats();
      if (!stats) return;
      void playHeartbeat(session.data.sessionId, stats.frames, stats.fps).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hostState, session.data]);

  // A handshake that never completes must not leave an eternal spinner: say so
  // and offer to load the game again.
  useEffect(() => {
    const finished = hostState === 'running' || hostState === 'ended' || hostState === 'error';
    if (finished) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), STALL_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hostState, attempt]);

  // A score is a claim from an untrusted frame: report it once, at the end.
  useEffect(() => {
    if (hostState !== 'ended' || !session.data || reportedRef.current) return;
    reportedRef.current = true;
    const claim = lastScoreRef.current;
    void reportSession(session.data.sessionId, {
      outcome: 'completed',
      durationMs: Math.max(0, Math.round(performance.now() - startedAtRef.current)),
      ...(claim ? { score: claim.value, scoreUnit: claim.unit, difficulty: claim.difficulty } : {}),
    }).catch(() => {});
  }, [hostState, session.data]);

  const isLoading = hostState === 'idle' || hostState === 'loading' || hostState === 'ready';
  const failed = hostState === 'error' || Boolean(fatalMessage);
  const hasRelease = Boolean(entry) && (Boolean(releaseId) || preview);

  const retry = (): void => {
    setAttempt((value) => value + 1);
  };

  const togglePause = (): void => {
    const host = hostRef.current;
    if (!host) return;
    if (host.state === 'running') host.pause();
    else if (host.state === 'paused') host.resume();
  };

  const toggleMute = (): void => {
    const host = hostRef.current;
    const next = !muted;
    setMuted(next);
    host?.setMuted(next);
  };

  const toggleFullscreen = (): void => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.requestFullscreen().catch(() => {});
  };

  const classes = ['player'];
  if (compact) classes.push('player--compact');
  if (className) classes.push(className);

  return (
    <div
      className={classes.join(' ')}
      style={game.accentColor ? ({ '--game-accent': game.accentColor } as Record<string, string>) : undefined}
      data-state={hostState}
    >
      <div className="player__frame" ref={containerRef} />

      {!hasRelease ? (
        <div className="player__status">
          <p className="player__status-text">
            {releaseId === null && !preview
              ? 'This game has no playable release yet.'
              : 'No release is available to play.'}
          </p>
        </div>
      ) : null}

      {hasRelease && isLoading ? (
        <div className="player__status" role="status" aria-live="polite">
          <Skeleton variant="block" width="48%" height="14px" />
          <p className="player__status-text">Loading {game.title}…</p>
          {stalled ? (
            <>
              <p className="player__status-text muted">
                The game is taking longer than usual to start. It may be a slow connection or a build that
                cannot run here.
              </p>
              <Button variant="secondary" onClick={retry}>
                Load again
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {hasRelease && failed ? (
        <div className="player__status player__status--error" role="alert">
          <p className="player__status-text">{fatalMessage ?? 'The game stopped unexpectedly.'}</p>
          <Button variant="primary" onClick={retry}>
            Restart
          </Button>
        </div>
      ) : null}

      {hasRelease && hostState === 'ended' && !failed ? (
        <div className="player__status">
          {score ? (
            <p className="player__status-text">
              Score {score.value}
              {score.unit ? ` ${score.unit}` : ''}
            </p>
          ) : (
            <p className="player__status-text">Run complete.</p>
          )}
          <div className="row">
            <Button variant="secondary" onClick={() => hostRef.current?.restart()}>
              Play again
            </Button>
            {onNext ? (
              <Button variant="primary" onClick={onNext}>
                {nextLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {hasRelease && !failed && hostState !== 'ended' ? (
        <div className="player__controls" role="group" aria-label="Playback controls">
          <span className="player__score" aria-live="off">
            {score ? `${score.value}${score.unit ? ` ${score.unit}` : ''}` : ''}
          </span>
          {hostState === 'running' || hostState === 'paused' ? (
            <IconButton
              label={hostState === 'paused' ? 'Resume game' : 'Pause game'}
              variant="ghost"
              onClick={togglePause}
            >
              {hostState === 'paused' ? '▶' : '❚❚'}
            </IconButton>
          ) : null}
          <IconButton label="Restart game" variant="ghost" onClick={() => hostRef.current?.restart()}>
            ⟲
          </IconButton>
          <IconButton label={muted ? 'Unmute game' : 'Mute game'} variant="ghost" onClick={toggleMute}>
            {muted ? '🔇' : '🔊'}
          </IconButton>
          <IconButton label="Fullscreen" variant="ghost" onClick={toggleFullscreen}>
            ⛶
          </IconButton>
          {onNext ? (
            <IconButton label={nextLabel} variant="ghost" onClick={onNext}>
              ↓
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}