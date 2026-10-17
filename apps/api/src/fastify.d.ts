import type { AuthenticatedUser } from './services/identity.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved account for this request, if any. */
    user: AuthenticatedUser | null;
    /** Raw session token (cookie or bearer), used for revocation and CSRF. */
    sessionToken: string | null;
    /** True when authentication came from the HttpOnly session cookie. */
    authViaCookie: boolean;
    /** True when the request carried a valid CSRF token for its cookie session. */
    csrfValid: boolean;
  }
}
