import { formatBytes } from "./format";

/** The retention window's arithmetic (PS-239), shared by the sweep and the build page. */
export const DAY_MS = 86_400_000;

/**
 * `PIXELSLASH_RETENTION_DAYS` as a number of days: a whole number above zero turns retention on,
 * anything else (unset, empty, `0`, a word) leaves it off. A typo never becomes a short window.
 */
export function retentionDaysOf(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const days = Number(raw);
  return days > 0 ? days : undefined;
}

/** Whole days until a build created at `createdAt` falls out of a `days` window; 0 or less is due. */
export function daysToExpiry(createdAt: Date, days: number, now: Date): number {
  return Math.ceil((createdAt.getTime() + days * DAY_MS - now.getTime()) / DAY_MS);
}

/** `expires in 12 days` for the build page. */
export function expiryLabel(daysLeft: number): string {
  return daysLeft === 1 ? "expires in 1 day" : `expires in ${daysLeft} days`;
}

/**
 * What the build page says about a build's expiry, or null: retention is off (`days` undefined), the
 * build is on the default branch (never expires) or is past the window, where the sweep may still keep
 * it for a baseline a live build points at, so nothing is promised.
 */
export function buildExpiry(
  build: { createdAt: Date; branch: string },
  defaultBranch: string,
  days: number | undefined,
  now: Date,
): string | null {
  if (days === undefined || build.branch === defaultBranch) return null;
  const daysLeft = daysToExpiry(build.createdAt, days, now);
  return daysLeft > 0 ? expiryLabel(daysLeft) : null;
}

/** The counts of a sweep in one line, for a log and for the CLI's footer. */
export function sweepSummary(
  plan: {
    expired: { window: "branch" | "main"; blobs: { size: number }[] }[];
    keptReferenced: string[];
    keptCurrent: string[];
  },
  deleted: { buildsDeleted: number; blobsDeleted: number; bytesFreed: number } | null,
): string {
  const kept = `${plan.keptReferenced.length} kept as baselines, ${plan.keptCurrent.length} kept as current`;
  if (deleted)
    return `retention: deleted ${deleted.buildsDeleted} builds, ${deleted.blobsDeleted} blobs, ${formatBytes(deleted.bytesFreed)}; ${kept}`;
  const blobs = plan.expired.flatMap((b) => b.blobs);
  const bytes = blobs.reduce((sum, b) => sum + b.size, 0);
  const main = plan.expired.filter((b) => b.window === "main").length;
  return `retention dry run: would delete ${plan.expired.length} builds (${main} main, ${plan.expired.length - main} branch), ${blobs.length} blobs, ${formatBytes(bytes)}; ${kept}`;
}

/** The orphan sweep's counts in one line. */
export function orphanSummary(
  plan: { orphans: { size: number }[] },
  deleted: { blobsDeleted: number; bytesFreed: number } | null,
): string {
  if (deleted)
    return `orphaned images: deleted ${deleted.blobsDeleted}, ${formatBytes(deleted.bytesFreed)}`;
  const bytes = plan.orphans.reduce((sum, b) => sum + b.size, 0);
  return `orphaned images dry run: would delete ${plan.orphans.length}, ${formatBytes(bytes)}`;
}
