/**
 * Create an account.
 *
 * The handle becomes the public profile URL (`/@handle`), so its availability
 * is checked against the API while typing instead of failing after submit. The
 * password rules come from the API's own validation, so they are only stated
 * here as a hint, never enforced twice.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { describeError, fieldIssues } from '../api/client.ts';
import { getHandleAvailability, register } from '../api/session.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { safeNextPath } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';

export function SignupScreen(): ReactNode {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setSession } = useSession();
  const next = safeNextPath(params.get('next'));

  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const availability = useQuery({
    queryKey: ['handle', handle],
    queryFn: ({ signal }) => getHandleAvailability(handle, signal),
    enabled: handle.trim().length >= 3,
    staleTime: 30_000,
  });

  useEffect(() => {
    setError(null);
  }, [email, handle, displayName, password]);

  const submit = useMutation({
    mutationFn: () =>
      register({
        email: email.trim(),
        password,
        handle: handle.trim().toLowerCase(),
        displayName: displayName.trim(),
      }),
    onSuccess: (session) => {
      setSession(session);
      navigate(next, { replace: true });
    },
    onError: (caught) => setError(describeError(caught)),
  });

  const handleTaken = availability.data ? !availability.data.available : false;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (handleTaken) return;
    submit.mutate();
  };

  return (
    <Page className="auth">
      <PageHeader title="Create your account" subtitle="Publish games, remix other people's, and keep your saves." />
      <form className="stack form" onSubmit={onSubmit}>
        <label className="field" htmlFor="signup-email">
          <span className="field__label">Email</span>
          <input
            id="signup-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field" htmlFor="signup-handle">
          <span className="field__label">Handle</span>
          <input
            id="signup-handle"
            className="input"
            required
            minLength={3}
            maxLength={20}
            pattern="[a-z0-9][a-z0-9-]*"
            autoComplete="username"
            value={handle}
            onChange={(event) => setHandle(event.target.value.toLowerCase())}
          />
          <span className="field__hint">Lowercase letters, numbers and dashes. This is your profile URL.</span>
          {availability.isFetching ? <span className="field__hint muted">Checking availability…</span> : null}
          {handleTaken ? (
            <span className="field__hint field__hint--error" role="alert">
              @{handle} is taken. Try @{availability.data?.suggestion}.
            </span>
          ) : null}
        </label>

        <label className="field" htmlFor="signup-name">
          <span className="field__label">Display name</span>
          <input
            id="signup-name"
            className="input"
            required
            maxLength={40}
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <label className="field" htmlFor="signup-password">
          <span className="field__label">Password</span>
          <input
            id="signup-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <span className="field__hint">At least 10 characters.</span>
        </label>

        {error ? (
          <p className="form__error" role="alert">
            {error}
          </p>
        ) : null}

        {fieldIssues(submit.error).length > 0 ? (
          <ul className="form__issues">
            {fieldIssues(submit.error).map((issue) => (
              <li key={`${issue.path}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}

        <Button variant="primary" type="submit" block busy={submit.isPending} disabled={handleTaken}>
          Create account
        </Button>

        <p className="muted small">
          Already have an account?{' '}
          <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>.
        </p>
      </form>
    </Page>
  );
}