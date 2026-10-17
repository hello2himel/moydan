/**
 * @moydan/core - contracts shared by the API, the build worker, the game
 * runtime, the creator CLI and the web application.
 *
 * This entry point is browser-safe (no `node:` imports) because the sandboxed
 * game runtime imports the very same schemas that validate its messages.
 */

export * from './schema.ts';
export * from './ids.ts';
export * from './errors.ts';
export * from './json.ts';
export * from './limits.ts';
export * from './paths.ts';
export * from './media.ts';
export * from './license.ts';
export * from './manifest.ts';
export * from './bridge.ts';
export * from './cursor.ts';
export * from './dto.ts';
export * from './version.ts';
