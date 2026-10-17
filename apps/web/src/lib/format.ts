/**
 * Display formatting helpers.
 *
 * Kept deliberately dumb: everything here turns a value from the API into
 * something a person can read. No component should be doing `new Date(...)
 * .toLocaleString()` inline.
 */

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB'];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

export function formatCount(count: number | null | undefined): string {
  const value = count ?? 0;
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(iso: string | null | undefined): string {
  const date = parseIso(iso);
  if (!date) return '-';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  const date = parseIso(iso);
  if (!date) return '-';
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function initials(name: string | null | undefined): string {
  const source = (name ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase() || '?';
}

/** Shorten a digest for display without losing its recognisable prefix. */
export function shortHash(hash: string | null | undefined, keep = 8): string {
  if (!hash) return '-';
  return hash.length <= keep + 2 ? hash : `${hash.slice(0, keep)}…${hash.slice(-4)}`;
}