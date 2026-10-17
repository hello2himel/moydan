/**
 * Creator studio.
 *
 * Every state shown here comes from the API: a build is a `BuildJob` that is
 * polled until it leaves `queued`/`building`, a release only exists after a
 * successful build, and publishing needs the release id that build produced.
 * Nothing is simulated - if the worker is down, the screen says the build
 * failed and shows the diagnostics and the log the owner is allowed to read.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { BuildJob, GameCard } from '@moydan/core';
import { describeError } from '../api/client.ts';
import { getGame, getLineage } from '../api/catalog.ts';
import { getRemixOptions } from '../api/remix.ts';
import {
  createPreviewGrant,
  getBuild,
  getDraft,
  listBuilds,
  listReleases,
  listVersions,
  publishGame,
  republishGame,
  startBuild,
  unpublishGame,
  updateGame,
  validateDraft,
} from '../api/projects.ts';
import { formatDate, formatRelativeTime } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useRequireAuth } from '../session/useRequireAuth.ts';
import { GamePlayer } from '../components/GamePlayer.tsx';
import { LineageView } from '../components/LineageView.tsx';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';
import { SocialActions } from '../components/SocialActions.tsx';
import { StudioFiles } from '../components/StudioFiles.tsx';

const POLL_INTERVAL_MS = 2_000;
const ACTIVE_BUILD_STATES = new Set<BuildJob['status']>(['queued', 'building']);

export function StudioScreen(): ReactNode {
  const { gameId = '' } = useParams();
  const { isPending: authPending } = useRequireAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const game = useQuery({
    queryKey: queryKeys.game(gameId),
    queryFn: ({ signal }) => getGame(gameId, signal),
    enabled: gameId.length > 0,
  });

  const draft = useQuery({
    queryKey: queryKeys.draft(gameId),
    queryFn: ({ signal }) => getDraft(gameId, signal),
    enabled: gameId.length > 0,
  });

  const builds = useQuery({
    queryKey: queryKeys.builds(gameId),
    queryFn: ({ signal }) => listBuilds(gameId, signal),
    enabled: gameId.length > 0,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((job) => ACTIVE_BUILD_STATES.has(job.status)) ? POLL_INTERVAL_MS : false;
    },
  });

  const releases = useQuery({
    queryKey: queryKeys.releases(gameId),
    queryFn: ({ signal }) => listReleases(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
  });

  const versions = useQuery({
    queryKey: queryKeys.versions(gameId),
    queryFn: ({ signal }) => listVersions(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
  });

  const lineage = useQuery({
    queryKey: queryKeys.lineage(gameId),
    queryFn: ({ signal }) => getLineage(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
  });

  const remixOptions = useQuery({
    queryKey: queryKeys.remixOptions(gameId),
    queryFn: ({ signal }) => getRemixOptions(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
    staleTime: 60_000,
  });

  const latestBuild = builds.data?.items[0] ?? null;
  const latestJob = useQuery({
    queryKey: queryKeys.build(latestBuild?.id ?? 'none'),
    queryFn: ({ signal }) => getBuild(latestBuild?.id ?? '', signal),
    enabled: Boolean(latestBuild) && ACTIVE_BUILD_STATES.has(latestBuild?.status ?? 'failed'),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const build = latestJob.data ?? latestBuild;

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.draft(gameId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.builds(gameId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.releases(gameId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.game(gameId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.versions(gameId) });
  };

  const saveDetails = useMutation({
    mutationFn: () =>
      updateGame(gameId, {
        title: title.trim(),
        description: description.trim(),
      }),
    onSuccess: (updated: GameCard) => {
      setDirty(false);
      setNote('Details saved.');
      queryClient.setQueryData(queryKeys.game(gameId), updated);
    },
    onError: (error) => setNote(describeError(error)),
  });

  const validate = useMutation({
    mutationFn: () => validateDraft(gameId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.draft(gameId) });
    },
  });

  const buildNow = useMutation({
    mutationFn: () => startBuild(gameId),
    onSuccess: () => {
      setNote('Build queued.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.builds(gameId) });
    },
    onError: (error) => setNote(describeError(error)),
  });

  const publish = useMutation({
    mutationFn: (releaseId: string) => publishGame(gameId, releaseId),
    onSuccess: () => {
      setNote('Published.');
      refreshAll();
    },
    onError: (error) => setNote(describeError(error)),
  });

  const unpublish = useMutation({
    mutationFn: () => unpublishGame(gameId),
    onSuccess: () => {
      setNote('Unpublished.');
      refreshAll();
    },
    onError: (error) => setNote(describeError(error)),
  });

  const republish = useMutation({
    mutationFn: () => republishGame(gameId),
    onSuccess: () => {
      setNote('Republished.');
      refreshAll();
    },
    onError: (error) => setNote(describeError(error)),
  });

  const preview = useMutation({
    mutationFn: (releaseId: string) => createPreviewGrant(releaseId),
    onSuccess: (grant) => {
      setPreviewUrl(grant.url);
      setNote(`Preview link valid until ${formatDate(grant.expiresAt)}.`);
    },
    onError: (error) => setNote(describeError(error)),
  });

  useEffect(() => {
    if (!game.data) return;
    setTitle(game.data.title);
    setDescription(game.data.description);
    setDirty(false);
  }, [game.data]);

  // A finished build changes what is publishable, so pull the release list again.
  useEffect(() => {
    if (build && !ACTIVE_BUILD_STATES.has(build.status)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.builds(gameId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases(gameId) });
    }
  }, [build, queryClient, gameId]);

  if (authPending) {
    return (
      <Page>
        <p className="muted">Taking you to sign in…</p>
      </Page>
    );
  }

  if (game.isPending || draft.isPending) return <LoadingScreen label="Loading project" />;

  if (game.isError) {
    return (
      <Page>
        <ErrorState
          error={game.error}
          onRetry={() => void game.refetch()}
          title="This project is not available to you"
        />
      </Page>
    );
  }

  if (draft.isError) {
    return (
      <Page>
        <ErrorState
          error={draft.error}
          onRetry={() => void draft.refetch()}
          title="The project files could not be loaded"
        />
      </Page>
    );
  }

  const card = game.data;
  const project = draft.data;
  if (!card || !project) return <LoadingScreen label="Loading project" />;

  const readyRelease =
    build?.status === 'ready_for_review' && build.releaseId ? build.releaseId : null;
  const releaseList = releases.data?.items ?? [];
  const currentReleaseId = card.release?.id ?? null;

  return (
    <Page className="studio">
      <PageHeader
        title={card.title}
        subtitle={
          <>
            <span className="badge">{card.status}</span>{' '}
            <span className="muted small">revision {project.revision} · updated {formatRelativeTime(project.updatedAt)}</span>
          </>
        }
        actions={
          <>
            <Link className="btn btn--ghost" to={`/games/${card.id}`}>
              Public page
            </Link>
            <Link className="btn btn--ghost" to="/create">
              All projects
            </Link>
          </>
        }
      />

      {note ? (
        <p className="form__note" role="status">
          {note}
        </p>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Details</h2>
        <form
          className="stack form"
          onSubmit={(event) => {
            event.preventDefault();
            saveDetails.mutate();
          }}
        >
          <label className="field" htmlFor="studio-title">
            <span className="field__label">Title</span>
            <input
              id="studio-title"
              className="input"
              value={title}
              maxLength={60}
              required
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="field" htmlFor="studio-description">
            <span className="field__label">Description</span>
            <textarea
              id="studio-description"
              className="textarea"
              value={description}
              maxLength={280}
              rows={3}
              required
              onChange={(event) => {
                setDescription(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <div className="row">
            <Button variant="primary" type="submit" busy={saveDetails.isPending} disabled={!dirty}>
              Save details
            </Button>
          </div>
        </form>

        <SocialActions
          game={card}
          remixEligible={remixOptions.data?.allowed ?? null}
          layout="row"
        />
      </section>

      <section className="panel">
        <h2 className="panel__title">Build</h2>

        <div className="row">
          <Button variant="secondary" busy={validate.isPending} onClick={() => validate.mutate()}>
            Run validation
          </Button>
          <Button variant="primary" busy={buildNow.isPending} onClick={() => buildNow.mutate()}>
            Start build
          </Button>
          {readyRelease ? (
            <Button variant="primary" busy={publish.isPending} onClick={() => publish.mutate(readyRelease)}>
              Publish
            </Button>
          ) : null}
          {card.status === 'published' ? (
            <Button variant="danger" busy={unpublish.isPending} onClick={() => unpublish.mutate()}>
              Unpublish
            </Button>
          ) : null}
          {card.status === 'unpublished' ? (
            <Button variant="secondary" busy={republish.isPending} onClick={() => republish.mutate()}>
              Republish
            </Button>
          ) : null}
        </div>

        <p className="muted small">
          {project.validation.ok
            ? 'The last validation run found no issues.'
            : `The last validation run reported ${project.validation.issues.length} issue${
                project.validation.issues.length === 1 ? '' : 's'
              }.`}
        </p>

        {project.validation.issues.length > 0 ? (
          <ul className="issues">
            {project.validation.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="issues__item">
                <code>{issue.path || 'project'}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {project.license.issues.length > 0 ? (
          <>
            <h3 className="panel__subtitle">Licence</h3>
            <ul className="issues">
              {project.license.issues.map((issue, index) => (
                <li
                  key={`${issue.path}-${index}`}
                  className={issue.severity === 'error' ? 'issues__item issues__item--error' : 'issues__item'}
                >
                  <code>{issue.path || 'LICENSE'}</code>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {validate.data && validate.data.issues.length > 0 ? (
          <ul className="issues">
            {validate.data.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="issues__item">
                <code>{issue.path || 'project'}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {build ? (
          <div className="build">
            <p className="build__status">
              <span className={ACTIVE_BUILD_STATES.has(build.status) ? 'badge badge--live' : 'badge'}>
                {build.status}
              </span>{' '}
              <span className="muted small">
                job {build.id} &middot; attempt {build.attempts} &middot; {build.toolchain}
              </span>
            </p>

            {build.errorMessage ? (
              <p className="form__error" role="alert">
                {build.errorCode ? `${build.errorCode}: ` : ''}
                {build.errorMessage}
              </p>
            ) : null}

            {build.diagnostics.length > 0 ? (
              <ul className="issues">
                {build.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`} className="issues__item">
                    <code>{diagnostic.path ?? diagnostic.code}</code>
                    <span>{diagnostic.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {build.log ? (
              <details className="log">
                <summary>Build log</summary>
                <pre className="log__body">{build.log}</pre>
              </details>
            ) : (
              <p className="muted small">The build log is only returned to the owner of this project.</p>
            )}

            <div className="row">
              {build.releaseId ? (
                <Button variant="secondary" busy={preview.isPending} onClick={() => preview.mutate(build.releaseId ?? '')}>
                  Create preview link
                </Button>
              ) : null}
              {currentReleaseId ? (
                <Button variant="secondary" busy={preview.isPending} onClick={() => preview.mutate(currentReleaseId)}>
                  Preview published release
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="muted small">No build has run for this project yet.</p>
        )}

        {previewUrl ? (
          <div className="stack">
            <p className="muted small">
              The preview grant points at unpublished content. It expires automatically.
            </p>
            <GamePlayer game={card} entryUrl={previewUrl} preview />
          </div>
        ) : null}
      </section>

      {project ? <StudioFiles gameId={gameId} draft={project} /> : null}

      <section className="panel">
        <h2 className="panel__title">Releases</h2>
        {releases.isPending ? <LoadingScreen label="Loading releases" /> : null}
        {releases.isError ? <ErrorState error={releases.error} onRetry={() => void releases.refetch()} /> : null}
        {releaseList.length === 0 && releases.isSuccess ? (
          <p className="muted small">No releases yet. Start a build to create one.</p>
        ) : null}
        {releaseList.length > 0 ? (
          <ul className="list">
            {releaseList.map((release) => (
              <li key={release.id} className="list__row">
                <span className="badge">{release.status}</span>
                <span className="strong">v{release.sequence}</span>
                <span className="muted small">
                  {release.engine.name} {release.engine.version} &middot; {release.fileCount} files &middot;{' '}
                  {formatDate(release.publishedAt ?? release.createdAt)}
                </span>
                <Button variant="ghost" busy={preview.isPending} onClick={() => preview.mutate(release.id)}>
                  Preview
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <h3 className="panel__subtitle">Source versions</h3>
        {versions.isError ? <ErrorState error={versions.error} onRetry={() => void versions.refetch()} /> : null}
        {versions.data && versions.data.items.length > 0 ? (
          <ul className="list">
            {versions.data.items.map((version) => (
              <li key={version.id} className="list__row">
                <span className="strong">{version.kind ?? 'version'}</span>
                <span className="muted small">
                  {version.licenseSpdx ?? 'unknown licence'} &middot; {version.fileCount ?? 0} files &middot;{' '}
                  {formatRelativeTime(version.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {versions.data && versions.data.items.length === 0 ? (
          <p className="muted small">No frozen versions yet.</p>
        ) : null}
      </section>

      <LineageView
        game={card}
        origin={lineage.data?.origin ?? card.remixOrigin}
        ancestors={lineage.data?.ancestors ?? []}
      />
    </Page>
  );
}