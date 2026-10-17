/**
 * Security headers for the game content origin.
 *
 * ---------------------------------------------------------------------------
 * TRUST BOUNDARY
 * ---------------------------------------------------------------------------
 * Everything served from this origin is *untrusted creator code*: the artifact
 * bundle, its assets and its host document. Any script that can run here runs
 * with the ambient authority of this origin, so:
 *
 *   1. This origin MUST NOT share a host with the application origin. If it
 *      did, a published game could read the application's DOM and its cookies
 *      and the session boundary would be gone. `assertBoundary` in `config.ts`
 *      refuses to boot in that configuration, and the CSP below pins every
 *      fetchable resource to `'self'` so a game cannot even reach the API.
 *   2. This origin sets NO cookies. There is no session, no CSRF token and no
 *      "remember me" here; an `onSend` hook strips any `set-cookie` that a
 *      dependency might add, so nothing can quietly create one.
 *   3. This origin is not an API origin. It never sends
 *      `access-control-allow-*`, answers preflight requests with 405, and only
 *      ever performs unauthenticated `GET`/`HEAD` reads from object storage.
 *      The application cannot read a response from this origin with
 *      credentials, which is why the game host talks to games through
 *      `postMessage` rather than `fetch`.
 *   4. The CSP forbids inline and remote script (`script-src 'self'`), so the
 *      artifact document can only execute module scripts served from here -
 *      `/sdk/moydan-sdk.js` and its own `game.js`. `worker-src`/`child-src` are
 *      `'none'`: a game cannot fork background scripts, and `base-uri`/`form-action`
 *      are `'none'` so injected markup cannot repoint the document.
 *   5. `frame-ancestors` is the *only* framing control we set. `X-Frame-Options`
 *      is deliberately absent: this origin exists to be embedded by the
 *      application, and CSP `frame-ancestors` already restricts which origins
 *      may do it.
 *
 * ---------------------------------------------------------------------------
 * CSP AND THE HOST DOCUMENT
 * ---------------------------------------------------------------------------
 * The generated `index.html` depends on exactly these directives:
 *   - no inline script and no external origin (both blocked), so it loads
 *     `/sdk/moydan-sdk.js` and `./game.js` as module scripts;
 *   - `style-src 'self' 'unsafe-inline'` allows the document's own inline
 *     `<style>` and a same-origin `game.css` emitted by the build;
 *   - `img-src`/`media-src`/`font-src` allow data: and blob: so games can build
 *     textures and audio at runtime without fetching anything off-origin;
 *   - `connect-src 'self'` keeps a game from calling the API or a third party.
 */

import type { OriginConfig } from './config.ts';

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Build the header set applied to every response.
 *
 * They are applied globally (including 404s and errors) so a failure path can
 * never accidentally serve a document without the sandbox policy.
 */
export function securityHeaders(config: OriginConfig): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(config),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), usb=(), payment=(), interest-cohort=()',
    // Artifacts are embedded by the application origin and may be fronted by a
    // CDN on another host, so CORP must allow cross-origin reads of these bytes.
    'cross-origin-resource-policy': 'cross-origin',
    // No window.opener relationship with the application: a game must not be
    // able to reach back through `window.opener`.
    'cross-origin-opener-policy': 'same-origin',
  };
}

/**
 * The Content-Security-Policy for game content.
 *
 * `default-src 'none'` means anything not listed is refused, so this policy
 * fails closed when a new resource type is introduced by a future engine.
 */
export function contentSecurityPolicy(config: OriginConfig): string {
  const ancestors = config.frameAncestors.length > 0 ? config.frameAncestors.join(' ') : config.appOrigin;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'none'",
    "child-src 'none'",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers for the creator SDK module: immutable, same content type, always. */
export function sdkHeaders(): Record<string, string> {
  return {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': IMMUTABLE_CACHE_CONTROL,
  };
}

/**
 * Headers for a served artifact file.
 *
 * The cache lifetime differs by route: a published release URL contains the
 * release id and the release is immutable, so it is cached for a year; a
 * preview URL contains a token and must be re-checked, so it is cached only
 * briefly and revalidated. `x-moydan-content-sha256` exposes the digest that
 * produced the ETag so a client (or an operator) can verify what it received.
 */
export function artifactHeaders(input: {
  contentType: string;
  etag: string;
  cacheControl: string;
  sha256?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': input.contentType,
    'cache-control': input.cacheControl,
    etag: input.etag,
    'accept-ranges': 'bytes',
  };
  if (input.sha256) headers['x-moydan-content-sha256'] = input.sha256;
  return headers;
}

/** Published releases are immutable; previews are capability URLs. */
export function releaseCacheControl(preview: boolean, previewMaxAgeSeconds: number): string {
  return preview ? `public, max-age=${Math.max(0, previewMaxAgeSeconds)}, must-revalidate` : IMMUTABLE_CACHE_CONTROL;
}
