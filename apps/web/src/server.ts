import handler from "@tanstack/react-start/server-entry";
import { type ExplainDelivery, consumeExplain } from "#/ai/explain-queue";
import {
  blobStore,
  checkRunDeps,
  database,
  modelFetch,
  modelKeySecret,
  alertWebhookUrl,
  databaseBytes,
  retentionDays,
  retentionDelete,
  retentionMainDays,
  startRefusal,
  sweepStore,
} from "#/server/env";
import { movedTo } from "#/server/moved";
import { withOptionalSentry } from "#/server/sentry";
import { sweepAbandoned } from "#/db/abandoned";
import { sweepOrphans } from "#/db/orphans";
import { sweepRetention } from "#/db/retention";
import { orphanSummary, sweepSummary } from "#/lib/retention";
import { checkDatabaseSize, webhookPost } from "#/lib/size-alert";
import { syncEnded } from "#/api/abandoned";
import { warn } from "#/lib/log";
import { orgBlobs, orgSweepBlobs } from "#/storage/blobs";

// A production build pointed at the GitHub stand-in does not start (PS-250): the throw fails the
// Worker's load, so `wrangler deploy` and the self-host's start stop with this message.
const refused = startRefusal();
if (refused) throw new Error(refused);

/** Builds one scheduled sweep takes, oldest first, so a first run on a long history stays short. */
const SWEEP_BATCH = 100;

/** Orphaned images one scheduled sweep takes. */
const ORPHAN_BATCH = 1000;

/** The size alert's daily marker, outside every org's `orgs/<id>/` prefix. */
const sizeAlertKey = (day: string) => `ops/size-alert/${day}`;

/**
 * The Worker's entry: TanStack Start's `fetch`, after the 301s of addresses that moved (`movedTo`:
 * the old docs site's paths), the explain queue's consumer (ob 1875), which
 * explains each finalised build's changed shots with the project's model off the request, and the
 * hourly sweep: abandoned builds end `errored` first (PS-324, always on), then the database size alert, which only tells, then the retention sweep (PS-239), which does nothing
 * until `PIXELSLASH_RETENTION_DAYS` or `PIXELSLASH_RETENTION_MAIN_DAYS` is set, then the orphaned
 * images, and both only log what they would delete until `PIXELSLASH_RETENTION_DELETE` is `true`. All report their errors to Sentry when `SENTRY_DSN` is set (PS-227) and run unwrapped when it is not.
 */
export default withOptionalSentry({
  fetch: (request) => {
    const to = movedTo(new URL(request.url), request.method);
    if (to) return Response.redirect(to, 301);
    return handler.fetch(request);
  },
  async scheduled(): Promise<void> {
    // Before the retention early return: ending abandoned builds needs no retention window.
    const db = database();
    const ended = await sweepAbandoned(db, { now: new Date(), limit: SWEEP_BATCH });
    if (ended.length > 0) {
      warn(`ended ${ended.length} abandoned build(s): ${ended.join(", ")}`);
      await syncEnded(checkRunDeps(db), ended);
    }
    const store = sweepStore();
    // Before the sweeps, so one that throws (or runs out of time on a big database) cannot silence it.
    const url = alertWebhookUrl();
    await checkDatabaseSize({
      bytes: await databaseBytes(),
      now: new Date(),
      log: warn,
      ...(url && { post: webhookPost(url) }),
      alreadySent: (day) => store.has(sizeAlertKey(day)),
      markSent: (day) => store.put(sizeAlertKey(day), new ArrayBuffer(0), "text/plain"),
    });
    const storeFor = (orgId: string) => orgSweepBlobs(store, orgId);
    const days = retentionDays();
    const mainDays = retentionMainDays();
    if (days !== undefined || mainDays !== undefined) {
      const { plan, result } = await sweepRetention(db, storeFor, {
        days,
        mainDays,
        now: new Date(),
        limit: SWEEP_BATCH,
        dryRun: !retentionDelete(),
      });
      warn(sweepSummary(plan, result));
    }
    const orphans = await sweepOrphans(db, storeFor, {
      now: new Date(),
      limit: ORPHAN_BATCH,
      dryRun: !retentionDelete(),
    });
    if (orphans.plan.orphans.length > 0) warn(orphanSummary(orphans.plan, orphans.result));
  },
  async queue(batch: { messages: readonly ExplainDelivery[] }): Promise<void> {
    const store = blobStore();
    const blobs = (orgId: string) => orgBlobs(store, orgId);
    const db = database();
    await consumeExplain(
      {
        db,
        blobs,
        modelKeySecret: modelKeySecret(),
        modelFetch: modelFetch(),
        checkRuns: checkRunDeps(db),
      },
      batch.messages,
    );
  },
});
