# Testing: the four layers

PixelSlash tests at four layers (PS-15). Each layer answers one question, and a behaviour is proved at
the lowest layer that can prove it. A test at a higher layer is there only for what the lower ones
cannot see.

| Layer | Question | Runs against | Where | Command |
| --- | --- | --- | --- | --- |
| **Smoke** | Does the deployed thing start and do its one job? | the deployed web app | `apps/web/smoke` | `SMOKE_BASE_URL=... bunx moon run web:smoke` |
| **E2E** | Does a user's happy path work through the real UI or CLI? | a real browser on a local build, local D1, GitHub stubbed | `apps/web/e2e` | `bunx moon run web:test-e2e` |
| **Integration** | Do the parts agree with each other and with the store? | real SQLite (D1's engine), real files, real HTTP on loopback, a real child process, a local build of the web app on a local D1 | `*/test`, `apps/web/src/{db,api,diff,github,storage,server}`, the DOM tests in `apps/web/src/components`, `apps/web/local-build`, `packages/cli/built` | `bunx moon run <project>:test`, `bunx moon run web:test-local-build`, `bunx moon run cli:test-built` |
| **Unit** | Is this function right on the cases that are easy to get wrong? | one module, no I/O | the rest of `*/test` and `apps/web/src/{lib,auth,ai}` | `bunx moon run <project>:test` |

Integration and unit share a runner (Vitest under Bun) and the `test` target, so the split between them
is by what a test touches, not by a folder. The two integration suites outside `test` are the web app's
local build and the CLI's built artifact (below), because each builds first.

A check of a local build on local data is integration, whatever its folder is called (Jacobus,
2026-11-15). Smoke is for the deployed build only: the web app's is `web:smoke`, run after each deploy. A unit test is added only for a gap: logic with branches the
layers above do not reach.

## Which layer a test belongs to

A test's layer is set by what it proves, not by the tool it was written with:

- **E2E** proves a journey a user takes through the real UI: one test per feature, its stages named with
  `test.step`, its elements found by role and accessible name (a `data-testid` only where no role
  fits). An edge case of that journey (an empty state, a refusal, a count, a second variant of the same
  form) is not a journey and goes down a layer.
- **Integration** proves the parts agree: a component rendered in happy-dom with its server functions
  bound to a temp store (`src/test/render.tsx`), a query on real SQLite, the API over a real `Db`, a
  local build over HTTP, the built CLI as a child process.
- **Unit** proves one function on the cases that are easy to get wrong.
- **How a page looks** is the visual job's (`ci.yml`, the dogfood shots), not an e2e assertion on a
  class or a pixel. **Whether a page fits a phone** is the page loop's (`e2e/pages.spec.ts`): every page,
  on the phone project, has no horizontal scroll. A spec does not repeat either.

An e2e test that stays has a reason a lower layer cannot meet: the HTTP hop to a server function, a
browser's own geometry (the slider's handle), a cookie across a reload, or a security check that
replays a real request from another org's session.

Real-browser tests run on Chromium only; Firefox and WebKit are never used in testing, at any layer,
local or CI. Every Playwright config's projects are Chromium devices: the web app's are `Desktop Chrome`
and `iPhone 15` with `browserName: "chromium"`. A phone
project on an iPhone device always sets `browserName: "chromium"`.

The web app's config (`apps/web/playwright.config.ts`) has the standard values: one worker (one local
D1), no retry, `forbidOnly` in CI, the `list` reporter locally and `github` with `html` in CI (CI uploads
the report and `test-results` when a run fails), a trace kept on failure, and the server bound to
`127.0.0.1`. Its `phone` project
runs `pages.spec.ts` alone; every other spec runs on `desktop`.

## The CLI's built artifact

This suite runs the **released shape**, not the source: it imports nothing from `src/`. A failure means
the artifact is broken, not that one function is. It was called the CLI smoke; it runs a local build on
this machine, so by the rule above it is integration, and its task and folder say so.

- **`cli`** (`packages/cli/built/cli.built.test.ts`, 4 tests, about 2 s). `moon run cli:test-built` builds
  `packages/cli/dist/index.js` and runs it as a child process, as the npm package runs: a PNG pair with
  100 changed pixels (stdout, manifest, overlay, report), an identical pair, a pair of static pages
  captured in a real browser from a loopback server, and a page that is down (exit 1, no report). The
  child's environment has every `PIXELSLASH_*` variable removed, so no token, server or error sink can
  reach it from the shell.

## The web app's local build

`apps/web/local-build` (3 files, 10 tests, about 25 s with the build). `moon run web:test-local-build`
builds the app once (`local-build/server.ts`, the Vitest `globalSetup`), applies the migrations to a
**fresh local D1** in `apps/web/.wrangler/local-build`, serves it with `vite preview` on a free port, and
runs the files one at a time against it. It runs in CI's `web` job, after the e2e. It is integration: a
local build on local data, no browser.

- `web.local-build.test.ts`: the sign-in page serves and a bad token is refused; a synthetic org's main
  and branch builds upload over `/api/v1`, the branch build reads back `changes` with a `changed`
  shot, and a real org's build is a 404 to it; the usage counts (below); a rerun of the seed.
- `upload.local-build.test.ts`: the real CLI from source. `upload` lands its rows and R2 objects under the
  token's org, the server's diff of a second upload, another org's token and a finalised build refused, a
  revoked token refused; `import` then `upload` of loose PNGs; a project set to diff in CI stores what the
  CLI measured; layout metrics files upload and the API read serves them.
- `stub-refusal.local-build.test.ts`: a stranger's production build (no `CLOUDFLARE_ENV`) refuses to
  start pointed at the GitHub stand-in, and starts pointed at GitHub with no Google sign-in. It builds
  its own copy and runs it in Miniflare; it does not use the server.

Each test owns its data: `seed()` (`local-build/harness.ts`) makes a user, an org, its member, a project
and a CI token with ids unique to the test, synthetic unless asked for a real org. Store writes a test
needs (a revoke, a diff location) go through the app's own store functions, not SQL.

The CLI's built suite, the local build and both e2e suites are cached like any other test: a pass replays only while every input is
the same (the whole repo minus build and test output, `bun.lock` for the Playwright build, and the env vars
each `moon.yml` lists), and a failure is never cached. A change the run could see re-runs it.

### The isolation rule, and the test that proves it

Jacobus's rule (2026-10-19): a run against a synthetic org leaves nothing a real user or a real number
can see. It governs any synthetic org: the local build's today, the deployment smoke's today.

1. **Synthetic, and excluded from every count.** A synthetic org is an `orgs` row with `is_smoke = 1`. Every
   reader that produces a number goes through `real()` (`src/db/synthetic.ts`): `usageCounts`, the
   timings stats and the other dashboards.
2. **Idempotent.** The server starts on a state directory that is deleted first. A seed with a fixed id
   deletes that org and user before it writes them, so a re-run adds no row that survives (the local
   build's rerun test proves it).
3. **No real outbound side effects.** The build is the `CLOUDFLARE_ENV=e2e` build with every URL it can
   call (GitHub, Google, Sentry) pointed at a closed loopback port or emptied, so the
   diff runs in-process and the run reaches no host but this machine.
4. **Credentials.** Every seed issues its own random CI token; only its SHA-256 is stored. No token is in
   the repo or read from the environment.
5. **A test proves it.** The local build's usage test reads `usageCounts` before and after its own org's
   two uploads and asserts no change. The control flips `is_smoke` to 0 and asserts the counts moved by
   exactly those two builds and two shots, so the first assertion cannot pass merely because nothing
   was counted; flipping it back restores the first reading. The counts are deltas, so the test holds on a
   D1 other tests have written to.

### The deployment smoke

`web:smoke` (`apps/web/smoke/web.smoke.ts`, 3 tests) runs after every deploy against `SMOKE_BASE_URL`:
pixelslash.dev, and the self-host through `release.sh`. The sign-in page serves, an unknown path is a 404,
and the smoke account's token signs in and sees its org. It follows the rule above:

1. The account is one synthetic org (`smoke-org`, `is_smoke = 1`), its user, one project and one personal
   token, all with fixed ids (`src/db/smoke-account.ts`). Applying its SQL again adds no row and replaces
   the token (`smoke-account.test.ts` proves both).
2. The smoke only reads: it uploads nothing, so it leaves no build or blob for retention to clean up. The
   token's `last_used_at` is its one write.
3. The token is a secret of whoever deploys, passed as `SMOKE_TOKEN` or `SMOKE_TOKEN_FILE`; the database
   holds only its SHA-256. A run with no token fails rather than skipping the sign-in check.

## Inventory

Every test file belongs to a layer. About 215 files cannot be listed one by one here, so the inventory is
by group; a group is one layer unless a row says otherwise. Counts are from the run recorded under
"Before and after".

| Group | Files | Layer | Notes |
| --- | --- | --- | --- |
| `packages/cli/built` | 1 | integration | the bundled CLI as a child process; was `packages/cli/smoke` |
| `apps/web/local-build` | 3 | integration | the local build over HTTP and the real CLI, each test on its own org (above). Moved out of e2e: `stub-refusal.spec.ts` (no page), `upload.spec.ts` (the page only provisioned, revoked and set the diff location) and the CLI and API half of `layout-metrics.spec.ts` |
| `apps/web/e2e` | 23 specs and the sign-in setup, 30 tests with it (`playwright test --list`: 28 on `desktop`, one of them `rss-burst.spec.ts`'s skipped measurement, 1 on `phone`, the setup; 28 files and 55 tests, counted the same way, before the cuts in "E2E specs cut to journeys") | e2e | one journey per feature, in a real browser, its stages in `test.step`. Every spec starts signed in from one `setup` project and builds its org, project and CI token with `provision` (`e2e/fixtures.ts`), a write to the D1; `orgs.spec.ts` is the one test that makes them by clicking, and `admin.spec.ts` (the operator health page: a 404 for the signed out and for an unlisted login, the page for a listed one) is the one that reads the whole D1. `pages.spec.ts` is the page loop, on the phone project only: every page opens with no horizontal scroll. `rss-burst.spec.ts` is a memory check and is outside the gate |
| `packages/cli/test` | 30 | integration | the `pixelslash` commands run in-process or as a child, against a fake server and real temp dirs. The `*-support.ts` files are helpers |
| `packages/engine/test` | 50 | integration + unit | store, upload, capture (real Chromium), report and DS judge are integration; `diff*`, `regions`, `fingerprint`, `sentry-scrub`, `route-names`, `change-note`, `config*` are unit |
| `apps/web/src/db` | 29 | integration | every query against real SQLite with the real migrations (`test-db.ts`, `test-d1.ts`) |
| `apps/web/src/api` | 15 | integration | the `/api/v1` handler over a real `Db` and blob store, including the `ENDPOINTS` / `docs/cli.md` agreement |
| `apps/web/src/diff` | 21 | integration | `processBuild` end to end on a real `Db`: baselines, retries, resume, timings. `wasm`, `measure`, `identical-bytes` are unit |
| `apps/web/src/github`, `storage`, `server`, `preview` | 11 | integration | the GitHub client against a local stand-in, R2-shaped blobs, the connection patch |
| `apps/web/src/lib`, `auth`, `ai` | 36 | unit | pure helpers and the model client against a fake endpoint. `use-review-keys.hook.test.tsx` renders a hook in happy-dom (its `@vitest-environment` line) to type a key in the commit that shows another shot, which no pure function can reach; `use-decision.hook.test.tsx` does the same for the decide-then-move flow, with a stubbed server call |
| `apps/web/deploy` | 7 | integration | the Docker and SSH scripts, run against temp dirs |
| `packages/playwright`, `examples/playwright-node` | 2 | integration | the Playwright integration against an upload stub |
| `bench/test` | 12 | unit | the benchmark's scoring and runner; `bench:check` is the regression guard (integration: it replays the cached Argos verdicts) |

### Duplicates cut

Each cut names where the behaviour is still proved.

| Removed | Why it was a duplicate | Still proved by |
| --- | --- | --- |
| `packages/engine/test/diff.test.ts` "identical → changedPixels 0" | the same pair as the byte-equal test, one layer lower | "byte-equal PNGs are unchanged without a decode, a diff or an overlay" (which now also asserts `antialiased` is 0) |
| `packages/engine/test/diff.test.ts` "one pixel differs" | a one-pixel case of the counting the region tests and the built CLI's 100-pixel pair assert | `regions.test.ts`, the other `diffPngs` cases, and `cli.built.test.ts` (100 changed pixels, exact) |
| `apps/web/src/diff/process-recovery.test.ts` "a build the Worker ceiling stopped is resumed on retry, and the retry gives the verdict" | the resume path and the verdict-on-retry path are each tested alone | `process-resume.test.ts` (resume) and "a diff that errored is re-diffed to a real verdict" in the same file |
| `apps/web/src/api/handler.test.ts`, the `GET /api/v1/nope` 404 line | the same refusal is asserted for the other unknown path and method in the same test | the remaining assertions of "unknown paths and methods are refused" |
| `apps/web/e2e/deep-history.spec.ts` (the whole file, one test) | a browserless upload test dressed as an e2e; nothing it asserts is in the UI | `process-deep-history.test.ts` (a main build 150 commits back is the baseline, a newer one is not used, the nearest wins, past 200 ancestors the shot is new) and `packages/engine/test/upload.test.ts` (the CLI sends up to 200 first-parent ancestors) |
| `apps/web/e2e/timings.spec.ts` "with several builds the Timings tab counts them and keeps the slowest as max" | the arithmetic is the stats module's, not the tab's | `timings-stats.test.ts` ("lists every project with p50/p95 of its builds"); the tab itself was rendered by the first test in that file, which is cut too (see "E2E specs cut" below) |
| `apps/web/e2e/metrics.spec.ts` "a build older than the timings says so, and invents no zero" | it clears columns in D1 to test one rendering rule | `src/lib/run-card.test.ts` ("has no wall time, no compare time and no re-capture line", "never shows a time it did not record as 0") for the build card; `src/lib/run-metrics.test.ts` ("is absent for a shot never timed") and `src/lib/branch-metrics.test.ts` (an untimed shot is left out, not counted as 0) for the shot and branch pages |

Nothing proved before is unproved now: each row above names a surviving test that fails if the behaviour
breaks.

### E2E specs cut

Eight web specs and three tests in two others were each a data and logic check run through a browser.
Every assertion moved to the lowest layer that can prove it, or is looks only (theme, phone width). The
page wiring that a browser used to prove is now a render test: `renderToStaticMarkup` for components
with no router, and `src/test/render-routed.tsx` (a memory-history router) for components with a link.
A component that is clicked or typed into is rendered in happy-dom with Testing Library through
`src/test/render.tsx`: the app's router at a memory history around it, and, for a route, the server
functions it calls bound to a fresh `testDb()` store signed in as a seeded user (the file's header shows
the three `vi.mock` lines). A `createServerFn` does not run its validator or return its handler's result
outside the Start compiler, so each server function a route test binds is split into its validator and
a plain function of the store, the viewer and the input, which the server function wraps
(`src/server/twin-fns.ts` is the first). Such a test runs the component and the handlers, not the HTTP
hop between them, which only the e2e suite exercises.
The count goes from 34 spec files and 68 tests to 26 and 51 (`bunx playwright test --list` in `apps/web`).

| Removed | Still proved by |
| --- | --- |
| `composition.spec.ts` (2 tests) | `components/composition.test.tsx` (the overlay, the findings line, the focus), `components/shot-card.test.tsx` (the card carries the line), `api/composition.test.ts` ("the build view hands stored findings to the screens") |
| `carried-from-main.spec.ts` | `diff/process-open-vs-main.test.ts` and `process-open-vs-main-page.test.ts` (what is carried and how it is filed), `lib/summary-counts.test.ts` (the counts line), `lib/review-walk.test.ts` (the j/k walk) |
| `metrics.spec.ts` | `components/run-metrics.test.tsx` (build card, shot and branch pages), plus the unit tests already named in the table above |
| `timings.spec.ts` (4 tests) | `components/build-timings.test.tsx`, `components/org-timings.test.tsx`, `lib/timings.test.ts`, `db/timings-stats.test.ts`; theme and phone width are looks only, and the click that opens the Timings tab, its `?tab=timings` URL and the loader are walked by `orgs.spec.ts`, which gained a step for it |
| `brief.spec.ts` | `components/build-brief.test.tsx`, `components/brief-summary.test.tsx` |
| `native.spec.ts` | `diff/process-native.test.ts`, `components/snapshot-side-panel.test.tsx`, `api/native.test.ts`, `packages/cli/test/import-native.test.ts` |
| `parity.spec.ts` (3 tests) | `components/parity-view.test.tsx`, `components/twins.test.tsx`, `api/parity.test.ts`, `api/twins.test.ts` |
| `stale.spec.ts` | `components/stale.test.tsx`, `components/twins.test.tsx`, `db/stale.test.ts`, `db/stale-review.test.ts`, `api/stale.test.ts`, `diff/process-stale.test.ts`; accepting a stale shot is walked by `review.spec.ts` |
| `ai-review.spec.ts` "a build with 10 changed shots gets no summary, says why, and offers no Regenerate" and "with no model a changed shot is reviewed as plain pixels" | `components/build-summary.test.tsx`, `components/ai-notes.test.tsx`, `diff/process.test.ts` |
| `twins.spec.ts` "a build shows its twin and links to it" | `components/twins.test.tsx`, `db/twins.test.ts`, `api/twins.test.ts` |
| `twins.spec.ts` "the project settings link a twin project of the same org, and clear it" (the file is gone) | `components/twin-settings.test.tsx` (no options alone in an org; pick, save, held after the loader re-runs; None clears it, which the spec's title claimed and never tested; a refused save in the alert), with `getTwinOptions` and `saveTwinProject` running against a temp store; `db/twins-linked.test.ts` (the link rule, and `twinCandidates`). The HTTP hop to a server function is still walked by the other settings specs |

Kept, with the reason: the other two tests in `ai-review.spec.ts` (an opted-in project's model auto-passes a
noise-only shot; a project without its own model uses the org's) need the settings forms, their server
functions and the stub model pipeline together, which no render test reaches.

The two merges planned beside this cut: `admin-health-now.test.ts` is folded into `admin-health.test.ts`
(its fixtures moved to `admin-health-kit.ts` so the file stays under the 300-line lint cap).
`ai/summary-parse.test.ts` stays its own file: `summary.test.ts` is at the cap, and merging would break it.

### E2E specs cut to journeys

The web e2e was brought to journeys only: one test per feature, its stages in `test.step`, its
elements found by role. Five specs went whole, eight more shrank to their journey, and every phone
test went to the page loop (`pages.spec.ts`, the `phone` project, which opens every page and its
folded parts on an iPhone 15 viewport in Chromium and fails on horizontal scroll). How a page looks
is the visual job's. The count goes from 28 files (the specs and the sign-in setup) and 55 tests (54 and 1 skipped) to 24 files and 30 tests (29 and 1 skipped),
and the run from 178 s to 99 s (below).

| Removed or cut | Still proved by |
| --- | --- |
| `rerun.spec.ts` | `components/rerun.test.tsx` (the button re-runs an errored build's shot against a seeded store and the page reloads with its verdict), `diff/process-rerun.test.ts` (which shots a re-run measures) |
| `layout-metrics.spec.ts` | `components/metrics-panel.test.tsx` (the side panel's figures), `api/metrics.test.ts` (`loadMetrics` and the API read). The one line of `getSnapshotPage` that hands the loaded metrics to the page is not run by a test |
| `env-refused.spec.ts` | `diff/process-unmeasured.test.ts` (the refusal and its message, both environments and the way out), `components/build-error.test.tsx` (the build page prints that message in full, with the re-run the diff location allows) |
| `action-row.spec.ts` | it measured layout only: that Accept keeps its place as j walks shots of different title widths, and the review chip stays on screen. That is the visual job's (the shot review page, light and dark); the j/k walk itself is `lib/review-walk.test.ts` and `lib/use-review-keys.hook.test.tsx` |
| `compare-header.spec.ts` | the page loop (the phone's header and bar fit), `components/snapshot-viewer.test.tsx` (each pane's label names its side); the sticky labels and rail are looks, the visual job's |
| `theme.spec.ts`, all but the reload | `lib/theme.test.ts` (a remembered choice beats the system, no choice follows it, a bad cookie is ignored); the spec keeps the choice surviving a reload, rendered by the server, and that a visitor gets no theme cookie until they pick one |
| `builds-list.spec.ts`, all but the fold | `components/builds-list.test.tsx` (every field on the card and the row; a passed build with shots to review reads changes), `lib/build-folds.test.ts` (which builds fold) |
| `build-page.spec.ts`, the summary lead, the thumbnails and the phone | `components/build-summary-lead.test.tsx` (three sentences and eight links, the rest on a click), `lib/thumb-crop.test.ts` (the 16:10 crop), the page loop |
| `compare-view.spec.ts`, eight tests: five into one journey, three cut | the journey (counters, the share of changed pixels of the compared area, highlight, modes across a theme toggle, the opacity range, the folding panel, a flag); the overlay's opacity style is `components/snapshot-overlay.test.tsx`'s; a failed judge saying so and why is `ai/explain-queue.test.ts` (the failure is stored) and `components/ai-notes.test.tsx` (its text); the slider divider's look in both themes and the panes taking the width at Fit are looks, the visual job's; the phone test is the page loop's |
| `compare-base.spec.ts`, the phone test | the page loop |
| `admin.spec.ts`, four tests into one, the theme and phone loop | the journey (a 404 signed out and for an unlisted login, no link from a customer page, every group for a listed one, each window read per build and per snapshot), `db/admin-health.test.ts` and `db/admin-health-compares.test.ts` (the figures), the page loop |
| `review.spec.ts`, "a decision moves the reviewer on" and "re-deciding a shot" | `lib/use-decision.hook.test.tsx` (accept moves on, reject goes to the build page, a refused decision stays and says why), `db/after-decision.test.ts` (an accept names the next shot awaiting a decision, and reads decisions made since the page opened). A reject after an accept is a reject like any other: the hook goes to the build page, and `review.spec.ts` still rejects a shot and lands on the failed build |

Kept, with the reason: `ai-review.spec.ts`'s org fallback (no render test reaches the model-in-use
line with the org's settings behind it), `ignore-boxes.spec.ts`'s rival (it replays the owner's real
server function request from another org's session), and `slider.spec.ts`'s geometry (both shots at
one scale is a browser's layout).

### Gaps filled

- **No test ran the shipped CLI.** Everything in `packages/cli/test` imports `src/`; a broken bundle (a
  missing `diff.wasm`, a bad shebang, a dependency that did not bundle) passed the gate. `cli:test-built`
  is that test.
- **No test ran the production build of the web app without a browser.** `web:test-local-build` does,
  and is the first test to state the isolation rule above as an assertion.

### Considered and left

- The `api` and `db` groups overlap in places (a rule asserted at the query and again at the endpoint).
  They are cheap, run in milliseconds, and fail in different places; they were not cut.

## Before and after

Measured on the desktop, `--skip-nx-cache`, the same machine in the same session.

| Layer | Project | Files | Tests | Time |
| --- | --- | --- | --- | --- |
| Smoke | `cli` | 0 → 1 | 0 → 4 | n/a → 2 s (the CLI build is cached) |
| Smoke | `web` | 0 → 1 | 0 → 4 | n/a → 17 s (build, migrate, serve, drive; now the local-build integration suite) |
| E2E | `web` (Playwright, 1 worker) | 24 → 23 | 39 → 36 (38 + 1 skipped → 35 + 1 skipped) | 164 s → 154 s |
| Integration + unit | `engine` | 47 → 47 | 584 → 582 (580 pass + 2 skipped) | 20.1 s → 18.8 s |
| Integration + unit | `cli` | 29 → 29 | 214 → 214 | 31.0 s → 30.7 s |
| Integration + unit | `web` | 96 → 96 | 666 → 665 | 44.1 s → 40.1 s |
| Integration + unit | `bench` | 12 → 12 | 148 → 148 | 11.5 s → 11.3 s |

The `site` e2e (1 spec) and the `.NET` xunit project were not touched and not re-measured. Integration and
unit tests share one Vitest run per project, so they are reported together; the split in the inventory is
by group. The differences of a second or two in untouched projects (`cli`, `bench`) are the noise of the
run, so read them as "unchanged". The tests cut are 2 in `engine`, 1 in `web` and 3 e2e; the layers
gain 8 smoke tests.

That table is the four-layer cut's own record (its smoke rows are integration now: the CLI's is
`cli:test-built`, the web app's the local build). The local build is 3 files and 10 tests today.

The cut to journeys, measured as `bun scripts/moon.ts run web:test-e2e --force` (the build, then
Playwright, 1 worker), the same desktop, the same day, at a load average under 2:

| Project | Specs | Tests | Playwright | Task |
| --- | --- | --- | --- | --- |
| `web` e2e | 28 → 24 files (the specs and the setup) | 55 (54 + 1 skipped) → 30 (29 + 1 skipped: 27 desktop, 1 phone, the setup, and `rss-burst.spec.ts`'s measurement, skipped) | 3.0 min → 1.6 min | 178 s → 99 s |

## Running them

```bash
bunx moon run cli:test-built         # builds the CLI first
bunx moon run web:test-local-build   # builds the web app and starts it on a fresh local D1
bunx moon run web:test-e2e     # the happy paths in a real browser
bunx moon run <project>:test   # integration + unit
```

In CI the web e2e runs every spec once on the production build (the diff in workerd, under the LAN's pixel limit). A second run
on `vite dev` is cut to `e2e/review.spec.ts`: it keeps the dev module graph under an e2e run, and
that spec makes the server diff and reads its result. The CLI's uploads diff in
workerd too, on the production build, in the local-build step that follows.

The local build's state is `apps/web/.wrangler/local-build` (gitignored), recreated on every run; its scratch is under
`TMPDIR`, which `scripts/test-tmp-scope.ts` scopes and removes.
