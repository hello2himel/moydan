#!/usr/bin/env node
/**
 * HTTP server bootstrap.
 *
 * The server owns exactly three long-lived resources: the SQLite handle, the
 * object-storage driver and the Fastify instance. Everything else is injected
 * into `buildApp`, so a test can build the identical app against a temporary
 * database and storage root.
 *
 * Configuration is validated before a single connection is opened: a
 * production deployment with the development session secret, a shared game
 * origin or filesystem storage must fail at boot rather than serve traffic.
 */

import { createStorageDriver } from '@moydan/storage';
import { assertConfigSafety, loadConfig } from './config.ts';
import { Db } from './db/client.ts';
import { createLogger } from './lib/logger.ts';
import { BlobStore } from './storage/blobs.ts';
import { buildApp } from './app.ts';

/** Long enough for in-flight requests, short enough for a deploy to wait. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig({ allowUnsafe: false });
  assertConfigSafety(config);

  const logger = createLogger({ name: 'api' });
  const db = new Db(config.databaseFile);
  const driver = createStorageDriver(
    config.storage.driver === 'fs'
      ? { driver: 'fs', fsRoot: config.storage.root }
      : { driver: 's3', s3: config.storage.s3 },
  );
  const blobs = new BlobStore(db, driver);

  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp({ config, db, blobs, logger });
  } catch (error) {
    db.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal });
    const forced = setTimeout(() => {
      logger.error('server.shutdown.timeout', { signal });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    // The guard must not hold the event loop open on a clean shutdown.
    forced.unref();
    try {
      await app.close();
      db.close();
      logger.info('server.shutdown.done', { signal });
    } catch (error) {
      logger.error('server.shutdown.failed', { signal, message: (error as Error).message });
      exitCode = 1;
    } finally {
      clearTimeout(forced);
    }
    process.exit(exitCode);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  // A rejected promise is a bug, not a request failure: log it loudly and keep
  // serving rather than letting Node terminate the process silently.
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 6).join('\n') : null,
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { message: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') });
    void shutdown('uncaughtException', 1);
  });

  await app.listen({ port: config.apiPort, host: config.host });
  logger.info('server.listening', {
    host: config.host,
    port: config.apiPort,
    environment: config.nodeEnv,
    appOrigin: config.appOrigin,
    gameOrigin: config.gameOrigin,
    storageDriver: config.storage.driver,
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ name: 'api' });
  logger.error('server.start_failed', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});