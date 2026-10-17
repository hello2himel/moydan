/**
 * @moydan/runtime - browser-side host for sandboxed games.
 *
 * Used by the web application (a game card in the feed, a game page) and kept
 * free of application state so it can be reused by any embedding client.
 */

export * from './host.ts';
export * from './feed.ts';
