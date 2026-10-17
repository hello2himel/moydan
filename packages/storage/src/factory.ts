/**
 * Driver factory. Keeping provider choice behind a tiny interface (rather than a
 * cloud abstraction framework) is enough: two drivers cover local development
 * and every S3-compatible provider.
 */

import { FsStorageDriver } from './fs-driver.ts';
import { S3StorageDriver, type S3DriverConfig } from './s3-driver.ts';
import type { StorageDriver } from './driver.ts';

export interface StorageSelection {
  driver: 'fs' | 's3';
  fsRoot?: string;
  s3?: S3DriverConfig;
}

export function createStorageDriver(selection: StorageSelection): StorageDriver {
  if (selection.driver === 's3') {
    if (!selection.s3) throw new Error('s3 storage requires an S3 configuration');
    return new S3StorageDriver(selection.s3);
  }
  if (!selection.fsRoot) throw new Error('fs storage requires a root directory');
  return new FsStorageDriver(selection.fsRoot);
}

/** Read-only accessor used by the game content origin. */
export interface ReadOnlyStorage {
  get(key: string): ReturnType<StorageDriver['get']>;
  head(key: string): ReturnType<StorageDriver['head']>;
}
