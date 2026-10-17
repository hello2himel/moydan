/**
 * Sign in.
 *
 * On success the viewer is returned to wherever they came from. `next` comes
 * from the query string, so it is treated as untrusted input and only accepted
 * when it is a path on this origin (see `safeNextPath`).
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { describeError, fieldIssues } from '../api/client.ts';
import { login } from '../api/session.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { safeNextPath } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';

export function LoginScreen(): ReactNode {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setSession, user } = useSession();
  const next = safeNextPath(params.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => login({ email: email.trim(), password }),
    onSuccess: (session) => {
      setError(null);
      setSession(session);
      navigate(next, { replace: true });
    },
    onError: (caught) => setError(describeError(caught)),
  });

  if (user) {
    return (
      <Page className="auth">
        <EmptyAuth title="You are already signed in" next={next} />
      </Page>
    );
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit.mutate();
  };

  return (
    <Page className="auth">
      <PageHeader title="Sign in" subtitle="Play, save and share games on Moydan." />
      <form className="stack form" onSubmit={onSubmit}>
        <label className="field" htmlFor="login-email">
          <span className="field__label">Email</span>
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field" htmlFor="login-password">
          <span className="field__label">Password</span>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
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

        <Button variant="primary" type="submit" block busy={submit.isPending}>
          Sign in
        </Button>

        <p className="muted small">
          No account yet? <Link to={`/signup?next=${encodeURIComponent(next)}`}>Create one</Link>.
        </p>
      </form>
    </Page>
  );
}

function EmptyAuth({ title, next }: { title: string; next: string }): ReactNode {
  return (
    <div className="stack">
      <h1 className="page__title">{title}</h1>
      <Link className="btn btn--primary" to={next}>
        Continue
      </Link>
      <Link className="btn btn--ghost" to="/settings">
        Open settings
      </Link>
    </div>
  );
}