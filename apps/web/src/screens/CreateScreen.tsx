/**
 * Studio landing: your projects and the "start something new" form.
 *
 * Templates and licences come from the API (`/api/meta/templates`,
 * `/api/licenses`) so a deployment can change either without a frontend
 * release. Creating a game copies the chosen template byte for byte into a new
 * draft and opens the studio.
 */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { describeError, fieldIssues } from '../api/client.ts';
import { getLicenses, getTemplates } from '../api/meta.ts';
import { getOwnGames } from '../api/session.ts';
import { createGame } from '../api/projects.ts';
import { formatCount, formatRelativeTime } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useRequireAuth } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function CreateScreen(): ReactNode {
  const { isPending: authPending } = useRequireAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  const [template, setTemplate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const games = useQuery({
    queryKey: queryKeys.ownGames,
    queryFn: ({ signal }) => getOwnGames(signal),
    enabled: !authPending,
  });

  const templates = useQuery({
    queryKey: queryKeys.templates,
    queryFn: ({ signal }) => getTemplates(signal),
    staleTime: 10 * 60_000,
  });

  const licenses = useQuery({
    queryKey: queryKeys.licenses,
    queryFn: ({ signal }) => getLicenses(signal),
    staleTime: 10 * 60_000,
  });

  const publicationLicenses = useMemo(
    () => (licenses.data?.items ?? []).filter((entry) => entry.appliesToCode !== false),
    [licenses.data],
  );

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(title));
  }, [title, slugTouched]);

  useEffect(() => {
    if (license === '' && publicationLicenses.length > 0) setLicense(publicationLicenses[0]?.spdx ?? '');
  }, [publicationLicenses, license]);

  useEffect(() => {
    if (template === '' && templates.data && templates.data.items.length > 0) {
      setTemplate(templates.data.items[0]?.id ?? '');
    }
  }, [templates.data, template]);

  const create = useMutation({
    mutationFn: () =>
      createGame({
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim(),
        licenseSpdx: license,
        template,
      }),
    onSuccess: (created) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ownGames });
      navigate(`/studio/${created.game.id}`);
    },
    onError: (caught) => setError(describeError(caught)),
  });

  if (authPending) {
    return (
      <Page>
        <p className="muted">Taking you to sign in…</p>
      </Page>
    );
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Page className="create">
      <PageHeader title="Studio" subtitle="Start a new game or open an existing project." />

      <section className="panel">
        <h2 className="panel__title">New game</h2>
        <form className="stack form" onSubmit={onSubmit}>
          <label className="field" htmlFor="create-title">
            <span className="field__label">Title</span>
            <input
              id="create-title"
              className="input"
              value={title}
              maxLength={60}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="field" htmlFor="create-slug">
            <span className="field__label">URL slug</span>
            <input
              id="create-slug"
              className="input"
              value={slug}
              maxLength={40}
              required
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            <span className="field__hint">Lowercase letters, numbers and dashes.</span>
          </label>

          <label className="field" htmlFor="create-description">
            <span className="field__label">Description</span>
            <textarea
              id="create-description"
              className="textarea"
              value={description}
              maxLength={280}
              rows={3}
              required
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <label className="field" htmlFor="create-template">
            <span className="field__label">Template</span>
            <select
              id="create-template"
              className="select"
              value={template}
              required
              onChange={(event) => setTemplate(event.target.value)}
            >
              {templates.isPending ? <option value="">Loading…</option> : null}
              {(templates.data?.items ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} — {entry.description}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="create-license">
            <span className="field__label">Licence</span>
            <select
              id="create-license"
              className="select"
              value={license}
              required
              onChange={(event) => setLicense(event.target.value)}
            >
              {licenses.isPending ? <option value="">Loading…</option> : null}
              {publicationLicenses.map((entry) => (
                <option key={entry.spdx} value={entry.spdx}>
                  {entry.name} ({entry.spdx})
                </option>
              ))}
            </select>
            <span className="field__hint">
              This licence decides who may remix your game and under which terms.
            </span>
          </label>

          {error ? (
            <p className="form__error" role="alert">
              {error}
            </p>
          ) : null}
          {fieldIssues(create.error).length > 0 ? (
            <ul className="form__issues">
              {fieldIssues(create.error).map((issue) => (
                <li key={`${issue.path}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          ) : null}

          <div className="row">
            <Button
              variant="primary"
              type="submit"
              busy={create.isPending}
              disabled={templates.isPending || publicationLicenses.length === 0}
            >
              Create project
            </Button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2 className="panel__title">Your projects</h2>
        {games.isPending ? <LoadingScreen label="Loading projects" /> : null}
        {games.isError ? <ErrorState error={games.error} onRetry={() => void games.refetch()} /> : null}
        {games.isSuccess && games.data.items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Create your first game from a template above."
          />
        ) : null}
        {games.data && games.data.items.length > 0 ? (
          <ul className="list">
            {games.data.items.map((game) => (
              <li key={game.id} className="list__row list__row--game">
                <Avatar url={game.creator.avatarUrl} name={game.title} size="sm" />
                <div className="list__text">
                  <Link className="strong" to={`/studio/${game.id}`}>
                    {game.title}
                  </Link>
                  <p className="muted small">
                    <span className="badge">{game.status}</span>{' '}
                    {game.status === 'published'
                      ? `${formatCount(game.stats.plays)} plays`
                      : `updated ${formatRelativeTime(game.createdAt)}`}
                  </p>
                </div>
                {game.status === 'published' ? (
                  <Link className="btn btn--ghost" to={`/games/${game.id}`}>
                    View
                  </Link>
                ) : null}
                <Link className="btn btn--secondary" to={`/studio/${game.id}`}>
                  Open
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </Page>
  );
}