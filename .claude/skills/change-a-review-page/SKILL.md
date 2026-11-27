---
name: change-a-review-page
description: Add or change a page of the PixelSlash review app (apps/web, TanStack Start on Cloudflare Workers with D1) and prove it in a browser test. Use when building or editing a project, build, shot or flakes page, a route under apps/web/src/routes, or an e2e spec for one.
---

# Change a review-app page

The review app is `apps/web`: TanStack Start on Cloudflare Workers, D1 through Drizzle, R2 for
images, GitHub sign-in. These are the traps that cost time; the gate in `AGENTS.md` is the rest.

## Routes

- File routes live in `apps/web/src/routes/`. A page that sits under a parent's path but must
  not render inside the parent's layout takes a trailing underscore on the parent segment:
  `$projectId.builds.$buildId_.snapshots.$snapshotId.tsx`, `$buildId_.parity.tsx`. Without
  it the page nests inside the build page.
- The route tree is generated; it is not formatted and not edited by hand.

## Data and images

- Every query goes through `src/db/*` and takes a `Db`, never D1. Every blob goes through
  `orgBlobs` (`src/storage/blobs.ts`). A Docker self-host swaps both, so a page that reads
  D1 or R2 directly breaks it.
- A page never links an image by its storage key. It gets a signed URL from
  `src/server/image-urls.ts`, which signs `orgs/<orgId>/<key>` (rows hold keys inside the
  org's prefix) with `src/storage/signed.ts`: an HMAC over `<expires>:<key>`, five minutes
  for a shot, six hours for a baseline. `routes/images/$.ts` serves it with
  `serveSignedImage`. Do not add a second way to serve an image.
- Dates and numbers go through `src/lib/format.ts` (UTC, `en-US`), so the server render and
  the browser agree and the tests do not depend on the machine's zone or locale.

## Hydration

- A control that only works once React has hydrated reads `useHydrated`
  (`src/lib/use-hydrated.ts`) and stays disabled until then.
- The `Page` frame (`src/components/ui.tsx`) sets `data-hydrated="true"` once hydrated.
  A test that clicks waits for it; it never sleeps.

## Tests

Prove a behaviour at the lowest layer that can (`docs/testing.md`): a DOM or integration test
for an edge case, the Playwright suite for a journey.

- `apps/web/e2e/fixtures.ts` has `open(page, path, { hydrated })`, `expectHydrated`, and a
  `provision` fixture that writes an org, a project and a CI token straight into the local
  D1. Seed through it, not through a hand-run `wrangler d1 execute`.
- `playwright.config.ts` runs one worker; the suite shares one local D1.
- Chromium only.
- Run `bunx moon run web:test-e2e`, and the review spec against `vite dev` as `AGENTS.md` says.

## Lint limits

oxlint denies warnings: complexity 10, max depth 3, max params 4, 300 lines a file and 80 a
function (tests and e2e are exempt from the length limits). Split a page into components
and `src/lib` helpers early rather than fighting the limits at the end.

## Before the PR

Run the web gate in `AGENTS.md` (build, e2e, the review spec on `vite dev`, both
`wrangler deploy --dry-run` builds). A pull request that changes the web app also gets the
`visual` job's dogfood shots; look at them before you ask for a merge.
