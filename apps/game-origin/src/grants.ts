/**
 * Preview grant validation.
 *
 * A preview URL carries a bearer token in its path:
 * `/preview/<releaseId>/<token>/<path>`. This origin cannot check it itself -
 * grants live in the API's database - so it asks the API, which is the only
 * component that knows whether a token is valid and unexpired.
 *
 * The check fails closed: an unreachable API, a non-200 answer or a malformed
 * body all mean "not authorised". Successful answers are cached for a few
 * seconds so one game load (document, bundle, assets) does not become a burst
 * of API calls; the window is far shorter than the grant's own lifetime.
 */

export interface PreviewGrantVerifierOptions {
  apiUrl: string;
  cacheMs?: number;
  timeoutMs?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

interface CacheEntry {
  verifiedAt: number;
  valid: boolean;
}

export class PreviewGrantVerifier {
  private apiUrl: string;
  private cacheMs: number;
  private timeoutMs: number;
  private logger: PreviewGrantVerifierOptions['logger'];
  private cache = new Map<string, CacheEntry>();

  constructor(options: PreviewGrantVerifierOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.cacheMs = options.cacheMs ?? 5_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
  }

  async verify(releaseId: string, token: string): Promise<boolean> {
    if (!isPlausibleToken(token) || !isPlausibleReleaseId(releaseId)) return false;
    const cacheKey = `${releaseId}/${token}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.verifiedAt < this.cacheMs) return cached.valid;

    let valid: boolean;
    try {
      const response = await fetch(
        `${this.apiUrl}/api/internal/preview-grants/${encodeURIComponent(releaseId)}?token=${encodeURIComponent(token)}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      valid = response.status === 200;
    } catch (error) {
      // Fail closed: an unreachable API must not hand out unpublished content.
      this.logger?.warn('preview grant check failed', {
        releaseId,
        message: error instanceof Error ? error.message : String(error),
      });
      valid = false;
    }
    this.cache.set(cacheKey, { verifiedAt: now, valid });
    if (this.cache.size > 512) this.cache.clear();
    return valid;
  }
}

function isPlausibleToken(token: string): boolean {
  return /^[0-9a-z]{16,128}$/.test(token);
}

function isPlausibleReleaseId(releaseId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(releaseId);
}
