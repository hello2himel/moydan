/**
 * Errors shared by the API, worker, CLI and tests.
 *
 * Every error carries a stable machine readable `code` so clients can react
 * without parsing prose, and an HTTP status used by the API layer. Messages are
 * safe to show to users: they never include secrets, credentials, file system
 * paths, or stack traces.
 */

export type AppErrorCode =
  | 'invalid_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'license_rejected'
  | 'remix_not_allowed'
  | 'build_failed'
  | 'repository_error'
  | 'storage_error'
  | 'internal_error'
  | 'unavailable';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  invalid_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 422,
  payload_too_large: 413,
  unsupported_media_type: 415,
  license_rejected: 422,
  remix_not_allowed: 422,
  build_failed: 422,
  repository_error: 502,
  storage_error: 502,
  internal_error: 500,
  unavailable: 503,
};

export interface AppErrorDetails {
  /** Additional structured, non-sensitive context (field errors, limits, ...). */
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: AppErrorDetails;

  constructor(code: AppErrorCode, message: string, details: AppErrorDetails = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON(): { error: { code: AppErrorCode; message: string; details: AppErrorDetails } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export const errors = {
  invalidRequest: (message: string, details?: AppErrorDetails) =>
    new AppError('invalid_request', message, details),
  validationFailed: (message: string, details?: AppErrorDetails) =>
    new AppError('validation_failed', message, details),
  unauthenticated: (message = 'Sign in to continue.') => new AppError('unauthenticated', message),
  forbidden: (message = 'You do not have permission to do that.') => new AppError('forbidden', message),
  notFound: (message = 'Not found.') => new AppError('not_found', message),
  conflict: (message: string, details?: AppErrorDetails) => new AppError('conflict', message, details),
  quotaExceeded: (message: string, details?: AppErrorDetails) => new AppError('quota_exceeded', message, details),
  payloadTooLarge: (message: string, details?: AppErrorDetails) =>
    new AppError('payload_too_large', message, details),
  unsupportedMediaType: (message: string) => new AppError('unsupported_media_type', message),
  licenseRejected: (message: string, details?: AppErrorDetails) => new AppError('license_rejected', message, details),
  remixNotAllowed: (message: string, details?: AppErrorDetails) => new AppError('remix_not_allowed', message, details),
  buildFailed: (message: string, details?: AppErrorDetails) => new AppError('build_failed', message, details),
  storageError: (message: string, details?: AppErrorDetails) => new AppError('storage_error', message, details),
  internal: (message = 'Something went wrong on our side.') => new AppError('internal_error', message),
  unavailable: (message = 'Service temporarily unavailable.') => new AppError('unavailable', message),
};
