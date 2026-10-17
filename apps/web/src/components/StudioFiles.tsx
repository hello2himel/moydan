/**
 * Project files panel for the studio.
 *
 * Editing happens in the browser against raw bytes: the API is the only thing
 * that decides whether a path is acceptable, what role it plays and how big it
 * may be. Nothing here writes HTML into the page - the editor is a `<textarea>`
 * showing the bytes the API returned.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TEXT_CONTENT_TYPES, contentTypeForPath, type DraftState, type ProjectFile } from '@moydan/core';
import { describeError } from '../api/client.ts';
import {
  deleteDraftFile,
  exportDraftArchive,
  getDraftFile,
  importDraftArchive,
  putDraftFile,
  renameDraftFile,
} from '../api/projects.ts';
import { formatBytes, formatRelativeTime } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { Button } from './Button.tsx';
import { EmptyState } from './EmptyState.tsx';
import { ErrorState } from './ErrorState.tsx';
import { Skeleton } from './Skeleton.tsx';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function isTextFile(file: ProjectFile): boolean {
  return TEXT_CONTENT_TYPES.has(file.contentType) || file.role === 'source' || file.role === 'document';
}

export interface StudioFilesProps {
  gameId: string;
  draft: DraftState;
  /** Bumped by the caller after a validation run. */
  disabled?: boolean;
}

export function StudioFiles({ gameId, draft, disabled = false }: StudioFilesProps): ReactNode {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.draft(gameId) });
  }, [queryClient, gameId]);

  const files = draft.files;
  const active = useMemo(() => files.find((file) => file.path === selected) ?? null, [files, selected]);

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => renameDraftFile(gameId, from, to),
    onSuccess: (result) => {
      setSelected(result.to);
      setRenaming(null);
      refresh();
    },
    onError: (error) => setNotice(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (path: string) => deleteDraftFile(gameId, path),
    onSuccess: () => {
      if (selected === confirmDelete) setSelected(null);
      setConfirmDelete(null);
      refresh();
    },
    onError: (error) => setNotice(describeError(error)),
  });

  const importer = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      return importDraftArchive(gameId, new Uint8Array(buffer));
    },
    onSuccess: (result) => {
      setNotice(`Imported ${result.imported} file(s), skipped ${result.skipped}, ${formatBytes(result.totalBytes)}.`);
      refresh();
    },
    onError: (error) => setNotice(describeError(error)),
  });

  const download = useCallback(async () => {
    try {
      const response = await exportDraftArchive(gameId);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${gameId}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(describeError(error));
    }
  }, [gameId]);

  return (
    <section className="studio-files">
      <header className="studio-files__head">
        <h2 className="panel__title">Files</h2>
        <div className="row">
          <label className={disabled ? 'btn btn--ghost btn--disabled' : 'btn btn--ghost'}>
            Import zip
            <input
              className="visually-hidden"
              type="file"
              accept=".zip,application/zip"
              disabled={disabled || importer.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importer.mutate(file);
                event.target.value = '';
              }}
            />
          </label>
          <Button variant="ghost" onClick={() => void download()}>
            Export zip
          </Button>
        </div>
      </header>

      <p className="muted small">
        {files.length} files &middot; {formatBytes(draft.usage.sourceBytes)} of source. Project format{' '}
        {draft.manifest ? '' : 'manifest missing'}.
      </p>

      {notice ? (
        <p className="form__note" role="status">
          {notice}
        </p>
      ) : null}

      <div className="studio-files__body">
        <ul className="filetree">
          {files.length === 0 ? (
            <li className="muted">No files yet.</li>
          ) : null}
          {files.map((file) => (
            <li key={file.path}>
              {renaming === file.path ? (
                <form
                  className="filetree__rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const to = renameTarget.trim();
                    if (to.length > 0 && to !== file.path) rename.mutate({ from: file.path, to });
                    else setRenaming(null);
                  }}
                >
                  <input
                    className="input"
                    value={renameTarget}
                    autoFocus
                    onChange={(event) => setRenameTarget(event.target.value)}
                  />
                  <Button variant="primary" type="submit" busy={rename.isPending}>
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className={selected === file.path ? 'filetree__row filetree__row--on' : 'filetree__row'}>
                  <button type="button" className="filetree__name" onClick={() => setSelected(file.path)}>
                    {file.path}
                  </button>
                  <span className="muted small">{formatBytes(file.size)}</span>
                  {isTextFile(file) ? (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => {
                        setRenaming(file.path);
                        setRenameTarget(file.path);
                      }}
                    >
                      Rename
                    </button>
                  ) : null}
                  {confirmDelete === file.path ? (
                    <span className="row">
                      <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(file.path)}>
                        Delete
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <button type="button" className="linkbtn" onClick={() => setConfirmDelete(file.path)}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="studio-files__editor">
          {active ? <FileEditor key={active.path} gameId={gameId} file={active} onSaved={refresh} /> : (
            <EmptyState title="No file selected" description="Pick a file on the left to read or edit it." />
          )}
        </div>
      </div>
    </section>
  );
}

function FileEditor({
  gameId,
  file,
  onSaved,
}: {
  gameId: string;
  file: ProjectFile;
  onSaved: () => void;
}): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentType = file.contentType || contentTypeForPath(file.path);

  const content = useQuery({
    queryKey: queryKeys.draftFile(gameId, file.path),
    queryFn: ({ signal }) => getDraftFile(gameId, file.path, signal),
    enabled: file.size >= 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!content.data) return;
    setText(decoder.decode(content.data));
    setDirty(false);
    setError(null);
  }, [content.data, file.path]);

  const save = useMutation({
    mutationFn: (value: string) => putDraftFile(gameId, file.path, encoder.encode(value)),
    onSuccess: () => {
      setDirty(false);
      setError(null);
      onSaved();
      void content.refetch();
    },
    onError: (caught) => setError(describeError(caught)),
  });

  if (content.isPending) {
    return (
      <div className="stack">
        <Skeleton variant="line" width="40%" />
        <Skeleton variant="block" height="240px" />
      </div>
    );
  }

  if (content.isError) {
    return <ErrorState error={content.error} onRetry={() => void content.refetch()} />;
  }

  if (!isTextFile(file)) {
    return (
      <div className="stack">
        <p className="strong">{file.path}</p>
        <p className="muted small">
          {contentType} &middot; {formatBytes(file.size)} &middot; updated {formatRelativeTime(file.updatedAt)}
        </p>
        <p className="muted">Binary files cannot be edited here. They are uploaded with a zip import.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="studio-files__editor-head">
        <p className="strong">{file.path}</p>
        <p className="muted small">
          {formatBytes(file.size)} &middot; updated {formatRelativeTime(file.updatedAt)} &middot;{' '}
          <code title={file.sha256}>{file.sha256.slice(0, 12)}</code>
        </p>
      </div>
      <textarea
        className="textarea textarea--code"
        value={text ?? ''}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setDirty(true);
        }}
      />
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" busy={save.isPending} disabled={!dirty} onClick={() => save.mutate(text ?? '')}>
          Save file
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            onClick={() => {
              setText(decoder.decode(content.data ?? new Uint8Array()));
              setDirty(false);
            }}
          >
            Revert
          </Button>
        ) : null}
      </div>
    </div>
  );
}