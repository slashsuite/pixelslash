import { createFileRoute } from "@tanstack/react-router";
import { blobStore, imageSigningSecret } from "#/server/env";
import { serveSignedImage } from "#/storage/serve-image";

/** Serves one blob behind a short-lived signature (`serveSignedImage`). */
export const Route = createFileRoute("/images/$")({
  server: {
    handlers: {
      GET: ({ request }) =>
        serveSignedImage(new URL(request.url), {
          secret: imageSigningSecret(),
          store: blobStore(),
        }),
    },
  },
});
