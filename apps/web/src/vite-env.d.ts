/// <reference types="vite/client" />

/**
 * Ambient types for the web application.
 *
 * `vite/client` is the only supported way to read deployment configuration such
 * as `VITE_API_BASE`. This file narrows the two variables the app actually
 * uses so a typo is a type error rather than `undefined` at runtime.
 */

interface ImportMetaEnv {
  /** Base URL of the Moydan API. Empty string means "same origin as the app". */
  readonly VITE_API_BASE?: string;
  /** Origin serving sandboxed game content; only used to resolve relative entry URLs. */
  readonly VITE_GAME_ORIGIN?: string;
}