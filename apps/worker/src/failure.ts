/**
 * Build failure classification.
 *
 * A build can fail because the *project* is wrong (a bad import, an undeclared
 * asset, a budget overrun) or because the *toolchain* is wrong (a missing
 * vendored engine, esbuild version drift), and the creator only ever sees a
 * message and a machine readable code. Both kinds cross a process boundary
 * (the isolated build child), so the classification has to survive as plain
 * JSON instead of an exception stack.
 *
 * Everything here is transport-agnostic: the HTTP worker loop and the
 * in-process `runLocalBuild` entry point format failures exactly the same way.
 */

import { isAppError } from '@moydan/core';

export interface BuildDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface FailurePayload {
  /** Stable code stored on `build_jobs.error_code` (max 64 characters). */
  code: string;
  /** Creator-facing message (max 500 characters once persisted). */
  message: string;
  diagnostics: BuildDiagnostic[];
  /** True when the failure is caused by the infrastructure, not by the project. */
  retryable: boolean;
}

export const DEFAULT_FAILURE_CODE = 'build_failed';
const MAX_CODE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DIAGNOSTICS = 40;

export class BuildFailure extends Error {
  readonly code: string;
  readonly diagnostics: BuildDiagnostic[];
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { diagnostics?: BuildDiagnostic[]; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BuildFailure';
    this.code = code.slice(0, MAX_CODE_LENGTH);
    this.diagnostics = (options.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS);
    this.retryable = options.retryable ?? false;
  }

  toPayload(): FailurePayload {
    return {
      code: this.code,
      message: this.message.slice(0, MAX_MESSAGE_LENGTH),
      diagnostics: this.diagnostics,
      retryable: this.retryable,
    };
  }
}

/** Wrap anything thrown by a build step into the serialisable payload shape. */
export function failureFromError(error: unknown): FailurePayload {
  if (error instanceof BuildFailure) return error.toPayload();
  if (isAppError(error)) {
    return {
      code: error.code,
      message: error.message.slice(0, MAX_MESSAGE_LENGTH),
      diagnostics: diagnosticsFromDetails(error.details, error.message),
      retryable: error.code === 'storage_error' || error.code === 'unavailable' || error.code === 'repository_error',
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: DEFAULT_FAILURE_CODE,
    message: message.slice(0, MAX_MESSAGE_LENGTH) || 'The build failed for an unknown reason.',
    diagnostics: [{ code: 'build_failed', message: message.slice(0, 400) }],
    retryable: false,
  };
}

/**
 * Turn `AppError.details` into flat diagnostics. Platform errors carry either an
 * `issues` array (manifest validation) or `path`/`limitBytes` pairs (limits),
 * and both are far more useful to a creator than the one-line message.
 */
function diagnosticsFromDetails(details: Record<string, unknown>, message: string): BuildDiagnostic[] {
  const issues = details['issues'];
  if (Array.isArray(issues)) {
    const out: BuildDiagnostic[] = [];
    for (const issue of issues.slice(0, MAX_DIAGNOSTICS)) {
      if (typeof issue !== 'object' || issue === null) continue;
      const entry = issue as { code?: unknown; message?: unknown; path?: unknown };
      out.push({
        code: typeof entry.code === 'string' ? entry.code : 'invalid',
        message: typeof entry.message === 'string' ? entry.message : message,
        ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      });
    }
    if (out.length > 0) return out;
  }
  const path = typeof details['path'] === 'string' ? details['path'] : undefined;
  const limitBytes = details['limitBytes'];
  const actualBytes = details['actualBytes'];
  const tooLarge = typeof limitBytes === 'number' && typeof actualBytes === 'number' && actualBytes > limitBytes;
  return [
    {
      code: tooLarge ? 'too_large' : 'invalid',
      message: tooLarge ? `${message} (${actualBytes} > ${String(limitBytes)} bytes)` : message,
      ...(path === undefined ? {} : { path }),
    },
  ];
}

/** Parse a failure payload that crossed a process boundary. Returns null if unusable. */
export function parseFailurePayload(value: unknown): FailurePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { code?: unknown; message?: unknown; diagnostics?: unknown; retryable?: unknown };
  if (typeof record.message !== 'string' || record.message.length === 0) return null;
  const diagnostics: BuildDiagnostic[] = Array.isArray(record.diagnostics)
    ? record.diagnostics.slice(0, MAX_DIAGNOSTICS).flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const item = entry as { code?: unknown; message?: unknown; path?: unknown };
        if (typeof item.message !== 'string') return [];
        return [
          {
            code: typeof item.code === 'string' ? item.code.slice(0, 64) : DEFAULT_FAILURE_CODE,
            message: item.message.slice(0, 400),
            ...(typeof item.path === 'string' ? { path: item.path.slice(0, 200) } : {}),
          },
        ];
      })
    : [];
  return {
    code: typeof record.code === 'string' ? record.code.slice(0, MAX_CODE_LENGTH) : DEFAULT_FAILURE_CODE,
    message: record.message.slice(0, MAX_MESSAGE_LENGTH),
    diagnostics,
    retryable: record.retryable === true,
  };
}

/** Human readable log block stored on the build job and echoed to the creator. */
export function formatFailureLog(payload: FailurePayload): string {
  const lines = [`error[${payload.code}]: ${payload.message}`];
  for (const diagnostic of payload.diagnostics.slice(0, 20)) {
    lines.push(`  - ${diagnostic.path ? `${diagnostic.path}: ` : ''}${diagnostic.message}`);
  }
  if (payload.retryable) lines.push('  (the platform reported a transient failure; building again will retry)');
  return lines.join('\n');
}
