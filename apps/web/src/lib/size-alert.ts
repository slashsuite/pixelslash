import type { Reading } from "./reading";

/**
 * The database size alert. D1 caps a database at 10 GB, and a write past the cap fails, so the
 * scheduled sweep reads the size and says so well before: past `ALERT_SHARE` of the cap it writes a
 * log line every run, and posts to the operator's webhook (`PIXELSLASH_ALERT_WEBHOOK_URL`) at most
 * once a UTC day. It only tells: nothing is deleted or moved when it fires.
 */
const DB_CAP_BYTES = 10e9;
const ALERT_SHARE = 0.7;

/** Whether `bytes` is past the alert line, `ALERT_SHARE` of the cap. */
export const overAlertLine = (bytes: number): boolean => bytes > DB_CAP_BYTES * ALERT_SHARE;

const gb = (n: number) => `${Number((n / 1e9).toFixed(1))} GB`;

/** `7.1 GB, 71% of the 10 GB cap`, for the log line, the webhook and /_admin. D1's cap is in decimal GB. */
export function shareLabel(bytes: number): string {
  return `${gb(bytes)}, ${Math.round((bytes / DB_CAP_BYTES) * 100)}% of the ${gb(DB_CAP_BYTES)} cap`;
}

/** What the webhook receives, as JSON: `text` for a chat hook, the numbers for anything else. */
export type SizeAlertBody = { text: string; bytes: number; capBytes: number; share: number };

export type SizeAlertDeps = {
  bytes: Reading<number>;
  now: Date;
  log: (line: string) => void;
  /** The webhook; absent when no URL is configured, and then the log line is the whole alert. */
  post?: (body: SizeAlertBody) => Promise<void>;
  /** Whether the day's push already went out (`day` is `YYYY-MM-DD`, UTC). */
  alreadySent: (day: string) => Promise<boolean>;
  markSent: (day: string) => Promise<void>;
};

type SizeAlertOutcome = "unknown" | "under" | "logged" | "already-sent" | "sent" | "failed";

/** Read the size and alert when it is past the line; see the module comment. */
export async function checkDatabaseSize(deps: SizeAlertDeps): Promise<SizeAlertOutcome> {
  if (!deps.bytes.ok) return "unknown";
  const bytes = deps.bytes.value;
  if (!overAlertLine(bytes)) return "under";
  const text = `database size alert: ${shareLabel(bytes)}; writes fail at the cap, so clear space or plan a move`;
  deps.log(text);
  if (!deps.post) return "logged";
  const day = deps.now.toISOString().slice(0, 10);
  if (await deps.alreadySent(day)) return "already-sent";
  try {
    await deps.post({ text, bytes, capBytes: DB_CAP_BYTES, share: bytes / DB_CAP_BYTES });
  } catch (error) {
    // Not marked, so the next run tries again the same day.
    deps.log(
      `database size alert: the webhook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
  await deps.markSent(day);
  return "sent";
}

/** The part of `fetch` the webhook uses, so a test can stand in for it. */
export type Send = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

/** The webhook as `post`: a JSON POST to `url`; a status that is not 2xx throws. */
export function webhookPost(url: string, send: Send = fetch) {
  return async (body: SizeAlertBody): Promise<void> => {
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
}
