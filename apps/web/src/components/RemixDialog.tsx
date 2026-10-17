/**
 * Remix dialog.
 *
 * The editor is generated from the parent's declared `RemixParameter[]` rather
 * than hard-coded fields: the creator's manifest is the schema, so a game that
 * exposes five parameters gets five controls and a game that exposes none gets
 * a plain confirmation. Source remixes get no parameter UI at all - they copy
 * the tree into a new draft and hand the creator over to the studio.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { GameCard, RemixParameter, RemixParameterValues } from '@moydan/core';
import { describeError } from '../api/client.ts';
import {
  createRemix,
  defaultRemixValues,
  getRemixOptions,
  parseRemixModes,
  validateRemixValues,
  type RemixMode,
} from '../api/remix.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { stringList } from '../lib/coerce.ts';
import { Button } from './Button.tsx';
import { ErrorState } from './ErrorState.tsx';
import { Modal } from './Modal.tsx';
import { Skeleton } from './Skeleton.tsx';

export interface RemixDialogProps {
  game: GameCard;
  open: boolean;
  onClose: () => void;
}

function ParameterField({
  parameter,
  value,
  onChange,
}: {
  parameter: RemixParameter;
  value: number | boolean | string | undefined;
  onChange: (next: number | boolean | string) => void;
}): ReactNode {
  const id = `remix-${parameter.key}`;
  const describedBy = parameter.description ? `${id}-description` : undefined;

  if (parameter.type === 'boolean') {
    return (
      <div className="field field--inline">
        <input
          id={id}
          className="checkbox"
          type="checkbox"
          checked={value === true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label className="field__label" htmlFor={id}>
          {parameter.label}
        </label>
        {parameter.description ? (
          <p className="field__hint" id={`${id}-description`}>
            {parameter.description}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{parameter.label}</span>
      {parameter.type === 'number' ? (
        <span className="field__control">
          <input
            id={id}
            className="input"
            type="range"
            min={parameter.min}
            max={parameter.max}
            step={parameter.step ?? 1}
            value={typeof value === 'number' ? value : parameter.default}
            aria-describedby={describedBy}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <output className="field__output" htmlFor={id}>
            {typeof value === 'number' ? value : parameter.default}
          </output>
        </span>
      ) : null}
      {parameter.type === 'select' ? (
        <select
          id={id}
          className="select"
          value={typeof value === 'string' ? value : parameter.default}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          {parameter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      {parameter.type === 'color' ? (
        <span className="field__control">
          <input
            id={id}
            className="input input--color"
            type="color"
            value={typeof value === 'string' ? value : parameter.default}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
          <code className="field__output">{typeof value === 'string' ? value : parameter.default}</code>
        </span>
      ) : null}
      {parameter.description ? (
        <span className="field__hint" id={`${id}-description`}>
          {parameter.description}
        </span>
      ) : null}
    </label>
  );
}

export function RemixDialog({ game, open, onClose }: RemixDialogProps): ReactNode {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<RemixMode | null>(null);
  const [values, setValues] = useState<RemixParameterValues>({});
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const options = useQuery({
    queryKey: queryKeys.remixOptions(game.id),
    queryFn: ({ signal }) => getRemixOptions(game.id, signal),
    enabled: open,
    staleTime: 60_000,
  });

  const modes = useMemo(() => parseRemixModes(stringList(options.data?.modes)), [options.data]);
  const parameters = useMemo<RemixParameter[]>(() => {
    const declared = options.data?.parameters;
    return Array.isArray(declared) ? declared : [];
  }, [options.data]);
  const childLicenses = useMemo(() => stringList(options.data?.allowedChildLicenses), [options.data]);

  useEffect(() => {
    if (!options.data) return;
    setValues(defaultRemixValues(parameters));
    setMode(modes[0] ?? null);
  }, [options.data, parameters, modes]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setTitle('');
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () => {
      if (!mode) throw new Error('Choose how you want to remix this game.');
      const check = validateRemixValues(parameters, values);
      if (!check.ok) {
        throw new Error(check.issues.map((issue) => `${issue.key}: ${issue.message}`).join(' '));
      }
      return createRemix(game.id, {
        mode,
        title: title.trim().length > 0 ? title.trim() : undefined,
        params: mode === 'parameters' ? values : null,
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ownGames });
      onClose();
      navigate(`/studio/${created.game.id}`);
    },
    onError: (caught) => setError(describeError(caught)),
  });

  const description = `Remix “${game.title}” by @${game.creator.handle}`;

  if (options.isPending) {
    return (
      <Modal open={open} onClose={onClose} title="Remix this game" description={description}>
        <Skeleton variant="block" height="72px" />
      </Modal>
    );
  }

  if (options.isError) {
    return (
      <Modal open={open} onClose={onClose} title="Remix this game" description={description}>
        <ErrorState error={options.error} onRetry={() => void options.refetch()} />
      </Modal>
    );
  }

  const data = options.data;
  if (!data) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remix this game"
      description={description}
      wide
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={!data.allowed || !mode}
            onClick={() => create.mutate()}
          >
            {mode === 'source' ? 'Copy source & open studio' : 'Create remix'}
          </Button>
        </div>
      }
    >
      <p className="prose">
        <Link to={`/games/${game.id}`}>{game.title}</Link> is by{' '}
        <Link to={`/@${game.creator.handle}`}>@{game.creator.handle}</Link> and is published under{' '}
        <strong>{data.licenseSpdx}</strong>. Your remix is a derivative work, so the licence rules of the
        original apply to it too.
      </p>

      {!data.allowed ? (
        <p className="notice notice--warn" role="status">
          {data.reason ?? 'This game cannot be remixed.'}
        </p>
      ) : null}

      {data.allowed && childLicenses.length > 0 ? (
        <p className="muted small">Your remix must be published under: {childLicenses.join(', ')}.</p>
      ) : null}

      {modes.length > 1 ? (
        <fieldset className="fieldset">
          <legend className="field__label">How do you want to remix it?</legend>
          {modes.map((candidate) => (
            <label key={candidate} className="field--inline choice">
              <input
                type="radio"
                name="remix-mode"
                value={candidate}
                checked={mode === candidate}
                onChange={() => setMode(candidate)}
              />
              <span>
                {candidate === 'parameters' ? 'Parameter remix' : 'Source remix'}
                <span className="muted">
                  {candidate === 'parameters'
                    ? ' — play the original code with different declared values.'
                    : ' — copy the source into a new project and change it.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {mode === 'parameters' ? (
        parameters.length > 0 ? (
          <div className="stack">
            {parameters.map((parameter) => (
              <ParameterField
                key={parameter.key}
                parameter={parameter}
                value={values[parameter.key]}
                onChange={(next) => setValues((previous) => ({ ...previous, [parameter.key]: next }))}
              />
            ))}
          </div>
        ) : (
          <p className="muted">This game declares no remix parameters. Try a source remix instead.</p>
        )
      ) : null}

      {mode === 'source' ? (
        <p className="prose">
          You will get a copy of the whole project in your studio. Files are shared with the original until you
          edit them, and you keep publishing under a licence the original allows.
        </p>
      ) : null}

      <label className="field" htmlFor="remix-title">
        <span className="field__label">Name your version (optional)</span>
        <input
          id="remix-title"
          className="input"
          value={title}
          maxLength={60}
          placeholder={`${game.title} remix`}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}