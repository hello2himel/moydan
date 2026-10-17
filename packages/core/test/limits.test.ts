/**
 * Every platform limit is data, so it can be configured, surfaced in validation
 * errors and asserted. `limitsFromEnv` must never let a typo disable a limit.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  formatBytes,
  LIMIT_KEYS,
  limitEnvName,
  limitsFromEnv,
  type Limits,
} from '@moydan/core';

describe('DEFAULT_LIMITS', () => {
  it('defines every declared limit', () => {
    expect(LIMIT_KEYS).toEqual(Object.keys(DEFAULT_LIMITS));
  });

  it('only contains positive integers', () => {
    for (const key of LIMIT_KEYS) {
      const value = DEFAULT_LIMITS[key];
      expect(Number.isInteger(value), `${key} must be an integer`).toBe(true);
      expect(value, `${key} must be positive`).toBeGreaterThan(0);
    }
  });
});

describe('limitEnvName', () => {
  it('derives the SCREAMING_SNAKE_CASE variable name', () => {
    expect(limitEnvName('maxFileBytes')).toBe('QUOTA_MAX_FILE_BYTES');
    expect(limitEnvName('maxCommentsPerMinute')).toBe('QUOTA_MAX_COMMENTS_PER_MINUTE');
    expect(limitEnvName('buildJobLeaseSeconds')).toBe('QUOTA_BUILD_JOB_LEASE_SECONDS');
  });
});

describe('limitsFromEnv', () => {
  it('returns the documented defaults for an empty environment', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
  });

  it('accepts a historical alias for a limit', () => {
    const limits = limitsFromEnv({ MAX_FILE_BYTES: '1024' });
    expect(limits.maxFileBytes).toBe(1024);
    expect(limits.maxProjectFiles).toBe(DEFAULT_LIMITS.maxProjectFiles);
  });

  it('accepts the generated variable name', () => {
    const limits = limitsFromEnv({ QUOTA_MAX_COMMENTS_PER_MINUTE: '3' });
    expect(limits.maxCommentsPerMinute).toBe(3);
  });

  it('consults the historical alias before the generated name', () => {
    // The alias is the documented variable for the limits that have one, so it
    // wins when a deployment sets both by accident.
    expect(limitsFromEnv({ MAX_FILE_BYTES: '1024', QUOTA_MAX_FILE_BYTES: '2048' }).maxFileBytes).toBe(1024);
  });

  it('ignores an empty value rather than resetting the limit to zero', () => {
    expect(limitsFromEnv({ MAX_FILE_BYTES: '' }).maxFileBytes).toBe(DEFAULT_LIMITS.maxFileBytes);
  });

  it('falls back to the default for a value that is not a positive integer', () => {
    for (const value of ['0', '-1', 'abc', '1.5', 'NaN', 'Infinity', ' ', '1 2']) {
      expect(limitsFromEnv({ MAX_FILE_BYTES: value }).maxFileBytes, `value ${JSON.stringify(value)}`).toBe(
        DEFAULT_LIMITS.maxFileBytes,
      );
    }
  });

  it('ignores an unknown variable entirely', () => {
    const limits = limitsFromEnv({ QUOTA_NOT_A_LIMIT: '5' });
    expect(limits).toEqual(DEFAULT_LIMITS);
  });

  it('overrides only what the base object does not define', () => {
    const base: Limits = { ...DEFAULT_LIMITS, maxGamesPerUser: 3 };
    const limits = limitsFromEnv({ MAX_BUILD_JOBS_PER_DAY: '7' }, base);
    expect(limits.maxGamesPerUser).toBe(3);
    expect(limits.maxBuildJobsPerDay).toBe(7);
  });

  it('does not mutate the base object', () => {
    const base: Limits = { ...DEFAULT_LIMITS };
    limitsFromEnv({ MAX_FILE_BYTES: '999' }, base);
    expect(base.maxFileBytes).toBe(DEFAULT_LIMITS.maxFileBytes);
  });
});

describe('formatBytes', () => {
  it('renders each magnitude with the unit a human expects', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GiB');
  });

  it('refuses to invent a size for nonsense input', () => {
    expect(formatBytes(-1)).toBe('unknown size');
    expect(formatBytes(Number.NaN)).toBe('unknown size');
  });
});