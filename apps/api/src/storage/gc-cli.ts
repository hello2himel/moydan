#!/usr/bin/env node
/**
 * `npm run gc` - mark-and-sweep unused blobs.
 *
 * Usage: node src/storage/gc-cli.ts [--dry-run] [--grace=3600] [--limit=1000]
 */

import { createStorageDriver } from '@moydan/storage';
import { loadConfig } from '../config.ts';
import { Db } from '../db/client.ts';
import { createLogger } from '../lib/logger.ts';
import { blobReferenceSummary, collectGarbage, describeGcReport } from './gc.ts';

const config = loadConfig();
const logger = createLogger({ name: 'gc' });
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const graceArg = args.find((arg) => arg.startsWith('--grace='));
const limitArg = args.find((arg) => arg.startsWith('--limit='));

const driver = createStorageDriver(
  config.storage.driver === 'fs'
    ? { driver: 'fs', fsRoot: config.storage.root }
    : { driver: 's3', s3: config.storage.s3 },
);
const db = new Db(config.databaseFile);
try {
  const before = blobReferenceSummary(db);
  logger.info('gc.start', { dryRun, references: before });
  const report = await collectGarbage(
    { db, driver },
    {
      dryRun,
      graceSeconds: graceArg ? Number(graceArg.split('=')[1]) : 3600,
      limit: limitArg ? Number(limitArg.split('=')[1]) : 1000,
    },
  );
  logger.info('gc.done', { ...report });
  console.log(describeGcReport(report));
} finally {
  db.close();
}
