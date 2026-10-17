/**
 * Account settings.
 *
 * Own-profile only: display name, bio, avatar URL, storage usage against the
 * platform limits (read from the API, never hard-coded) and sign out. This is
 * the page the profile "Settings" affordance points at.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { describeError } from '../api/client.ts';
import { getOwnProfile, getStorageUsage, logout, updateOwnProfile } from '../api/session.ts';
import { formatBytes, formatDate } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { useRequireAuth } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';

interface UsageRowProps {
  label: string;
  used: number;
  limit: number;
  /** Counts (games) and byte quotas do not read the same. */
  format?: (value: number) => string;
}

function UsageRow({ label, used, limit, format = formatBytes }: UsageRowProps): ReactNode {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="usage">
      <div className="usage__labels">
        <span>{label}</span>
        <span className="muted small">
          {format(used)} / {format(limit)}
        </span>
      </div>
      <div
        className="usage__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <span className="usage__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function SettingsScreen(): ReactNode {
  const { isPending: authPending } = useRequireAuth();
  const { user, setSession } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const profile = useQuery({
    queryKey: queryKeys.ownProfile,
    queryFn: ({ signal }) => getOwnProfile(signal),
    enabled: !authPending,
  });

  const usage = useQuery({
    queryKey: queryKeys.storage,
    queryFn: ({ signal }) => getStorageUsage(signal),
    enabled: !authPending,
  });

  useEffect(() => {
    if (!profile.data) return;
    setDisplayName(profile.data.displayName);
    setBio(profile.data.bio);
    setAvatarUrl(profile.data.avatarUrl ?? '');
  }, [profile.data]);

  const save = useMutation({
    mutationFn: () =>
      updateOwnProfile({
        displayName: displayName.trim(),
        bio,
        avatarUrl: avatarUrl.trim().length > 0 ? avatarUrl.trim() : null,
      }),
    onSuccess: (updated) => {
      setError(null);
      setSaved(true);
      queryClient.setQueryData(queryKeys.ownProfile, updated);
      queryClient.setQueryData(queryKeys.profile(updated.handle), updated);
      if (user) {
        setSession({
          user: { ...user, displayName: updated.displayName, avatarUrl: updated.avatarUrl },
        });
      }
    },
    onError: (caught) => {
      setSaved(false);
      setError(describeError(caught));
    },
  });

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      queryClient.clear();
      setSession({ user: null });
      navigate('/feed/foryou', { replace: true });
    },
  });

  if (authPending) {
    return (
      <Page>
        <p className="muted">Taking you to sign in…</p>
      </Page>
    );
  }

  return (
    <Page className="settings">
      <PageHeader
        title="Settings"
        subtitle={user ? `Signed in as @${user.handle} · ${user.email}` : undefined}
        actions={
          <Link className="btn btn--ghost" to={user ? `/@${user.handle}` : '/feed/foryou'}>
            {user ? 'View profile' : 'Back to the feed'}
          </Link>
        }
      />

      {profile.isPending ? <LoadingScreen label="Loading profile" /> : null}
      {profile.isError ? <ErrorState error={profile.error} onRetry={() => void profile.refetch()} /> : null}

      {profile.data ? (
        <form
          className="stack form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="settings__identity">
            <Avatar url={profile.data.avatarUrl} name={profile.data.displayName} size="md" />
            <div>
              <p className="strong">@{profile.data.handle}</p>
              <p className="muted small">Member since {formatDate(profile.data.createdAt)}</p>
            </div>
          </div>

          <label className="field" htmlFor="settings-name">
            <span className="field__label">Display name</span>
            <input
              id="settings-name"
              className="input"
              value={displayName}
              maxLength={40}
              required
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>

          <label className="field" htmlFor="settings-bio">
            <span className="field__label">Bio</span>
            <textarea
              id="settings-bio"
              className="textarea"
              value={bio}
              maxLength={300}
              rows={4}
              onChange={(event) => setBio(event.target.value)}
            />
            <span className="field__hint">Up to 300 characters. Plain text only.</span>
          </label>

          <label className="field" htmlFor="settings-avatar">
            <span className="field__label">Avatar URL</span>
            <input
              id="settings-avatar"
              className="input"
              type="url"
              value={avatarUrl}
              placeholder="https://…"
              onChange={(event) => setAvatarUrl(event.target.value)}
            />
            <span className="field__hint">Must be an https URL. Leave empty to use your initials.</span>
          </label>

          {error ? (
            <p className="form__error" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="form__ok" role="status">
              Profile saved.
            </p>
          ) : null}

          <div className="row">
            <Button variant="primary" type="submit" busy={save.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Storage</h2>
        {usage.isPending ? <LoadingScreen label="Loading usage" /> : null}
        {usage.isError ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} /> : null}
        {usage.data ? (
          <div className="stack">
            <UsageRow label="Source" used={usage.data.sourceBytes} limit={usage.data.limits.sourceBytes} />
            <UsageRow label="Releases" used={usage.data.releaseBytes} limit={usage.data.limits.releaseBytes} />
            <UsageRow
              label="Games"
              used={usage.data.gameCount}
              limit={usage.data.limits.games}
              format={(value) => String(Math.round(value))}
            />
            <p className="muted small">
              {usage.data.blobCount} stored files, {formatBytes(usage.data.previewBytes)} of preview data.
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">Account</h2>
        <Button variant="danger" busy={signOut.isPending} onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </section>
    </Page>
  );
}