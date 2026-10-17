/**
 * Terminal output for the CLI.
 *
 * Why: creators read this in a CI log as often as in a terminal, so the output
 * is plain text (no colour, no cursor tricks) with a stable `path: message`
 * shape for issues. Secrets are masked centrally here so no command can print
 * a session token by accident.
 */

import type { ValidationIssue } from '@moydan/core';

export const EXIT_OK = 0;
/** Something went wrong: invalid project, failed build, failed check. */
export const EXIT_FAILURE = 1;
/** The invocation itself was wrong, or the command is not available yet. */
export const EXIT_USAGE = 2;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_FAILURE) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function note(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`warning: ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`error: ${text}\n`);
}

export function heading(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function issue(validation: ValidationIssue): string {
  return `${validation.path || '$'}: ${validation.message} [${validation.code}]`;
}

export function printIssues(label: string, issues: readonly ValidationIssue[]): void {
  line(`${label} (${issues.length}):`);
  for (const entry of issues) line(`  ${issue(entry)}`);
}

/**
 * Mask a secret so logs and screenshots stay safe. Only the last four
 * characters survive, which is enough to tell two sessions apart.
 */
export function maskToken(value: string | null | undefined): string {
  if (!value) return '(none)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

export function pass(text: string): void {
  line(`  PASS  ${text}`);
}

export function failed(text: string): void {
  line(`  FAIL  ${text}`);
}

export function skipped(text: string): void {
  line(`  SKIP  ${text}`);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Fixed-width column rendering without pulling in a table library. */
export function row(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd();
}
