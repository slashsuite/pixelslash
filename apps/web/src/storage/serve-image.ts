import { METRICS_SUFFIX } from "@slashsuite/pixelslash-engine/metrics-entry";
import type { BlobStore } from "./blobs";
import { verifySignedImagePath } from "./signed";

const notFound = () => new Response("not found", { status: 404 });

/**
 * The `/images/<key>?exp=…&sig=…` route's answer: one PNG (or a layout metrics file,
 * `.metrics.json`) from the private bucket behind a short-lived signature. Every failure is the
 * same 404: a missing object, a tampered key and an expired signature are indistinguishable, so
 * the route never confirms what the bucket holds.
 */
export async function serveSignedImage(
  url: URL,
  deps: { secret: string; store: Pick<BlobStore, "get">; now?: number },
): Promise<Response> {
  // The key is the path after `/images/`; a URL-encoded key is decoded the same way a router
  // param would be.
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/images\//, ""));
  } catch {
    return notFound();
  }
  const ok = await verifySignedImagePath({
    key,
    expires: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
    secret: deps.secret,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (!ok) return notFound();
  const body = await deps.store.get(key);
  if (!body) return notFound();
  return new Response(body, {
    headers: {
      "content-type": key.endsWith(METRICS_SUFFIX) ? "application/json" : "image/png",
      // The signature is short-lived; the browser may reuse the bytes for its duration.
      "cache-control": "private, max-age=300",
    },
  });
}
