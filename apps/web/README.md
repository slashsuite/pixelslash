# apps/web: the PixelSlash review app

TanStack Start on Cloudflare Workers, D1 via Drizzle, R2 for the shots, GitHub sign-in. CI uploads
builds with `pixelslash upload`; people review them here.

To run your own: [`SELF-HOST.md`](SELF-HOST.md), from an empty Cloudflare account (or a box on your LAN) to a first upload.

## Self-host in 5 minutes

One Docker image runs the app and the diff worker, with real GitHub sign-in. Everything is kept in one
volume: the database (D1, a SQLite file), the shots (R2, files) and two generated secrets. You need
Docker with Compose and a GitHub account. There is no Cloudflare account and nothing is pulled from a
registry: the image is built from this checkout.

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps). Set its homepage
   to the URL people will open, e.g. `http://localhost:3000`, and its callback URL to that URL plus
   `/auth/github/callback`.
2. From the repo root:

   ```bash
   cd docker/self-host
   cp .env.example .env        # fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
   docker compose up -d        # builds pixelslash-self-host:local, then serves on :3000
   ```

   `BUILD_COMMIT=$(git rev-parse HEAD) docker compose up -d --build` puts the commit in the page's
   `build-commit` meta; without it the meta says `unknown`, since the image has no `.git`.

   Behind a proxy that ends TLS (Caddy, nginx, a tunnel), set `PIXELSLASH_PUBLIC_URL` in `.env` to the
   `https://` URL people open: the GitHub callback and the session cookie's `Secure` flag follow it. To
   keep sign-in to your team, set `PIXELSLASH_ALLOWED_GITHUB_LOGINS` to their GitHub logins,
   comma-separated; anyone else is refused.

3. Open the URL, sign in with GitHub, and create an org, a project and a token. Then upload from CI
   or a shell with `PIXELSLASH_TOKEN=<token> pixelslash upload --server <URL> --branch main`.

What it does (`deploy/docker/start.ts`, `docker/self-host/`):

- The app is the production build on Miniflare, as on [the LAN box](#run-it-on-the-proxmox-server), through
  the same `deploy/ssh/serve.ts` options. Its `Db` and `orgBlobs` are the Cloudflare ones, backed by
  files under `/data/state/v3`, so the code is the hosted app's.
- On every start it applies any pending `drizzle/` migration before it listens. It records each one
  in wrangler's `d1_migrations` table, so `wrangler d1 migrations apply DB --local --persist-to
  <volume>/state` agrees with it.
- New projects diff on the server (`DEFAULT_DIFF_LOCATION=server`), in the same process: one
  container, one process. A shot over `DIFF_LIMIT_MPX` (24.5 Mpx unless `.env` sets it) ends its build
  `errored`, naming the size.
- `IMAGE_SIGNING_SECRET` and `MODEL_KEY_SECRET` are generated into `/data/secrets` on the first start,
  unless `.env` sets them. A restart keeps them, and with them the signed image URLs and the sealed
  model keys.
- Any other name in [SELF-HOST.md's Variables table](SELF-HOST.md#variables) can go in `.env`. A
  production build still refuses a GitHub other than github.com.
- Nothing is fetched from Cloudflare at start (`cf: false`).

`docker compose down` keeps the volume. `docker compose down -v` deletes every org, build and shot.
To update, `git pull` and then `docker compose up -d --build`.

The same image is proven by `bunx moon run web:test-e2e-docker` (or `bun run test:e2e:docker` in
`apps/web`). It needs Docker, so it is not part of `test:e2e`; CI's `self-host` job runs it when the app,
the engine or the Dockerfile changes. Each test passes on its own:

- The e2e build signs in against the GitHub stand-in, makes an org, a project and a token, and takes
  two CLI uploads, which the server diffs.
- It then restarts the container and checks that the builds, the session, the stored PNG and a new
  diff against the stored baseline all survived.
- Behind an HTTPS proxy, with `PIXELSLASH_PUBLIC_URL` set to it, sign-in uses the public callback and
  the session cookie is `Secure`; a login not on `PIXELSLASH_ALLOWED_GITHUB_LOGINS` is refused.
- The production build is checked to send `/auth/github` to github.com with the configured client id.
- The runtime image installs only Miniflare (`docker/self-host/package.json`): the Worker in `dist` is
  bundled.

## Secrets

A deployment sets these with `wrangler secret put <NAME>` (or in `.dev.vars` locally; the names are
in `.dev.vars.example`). Never in git.

| Secret | What it is |
| --- | --- |
| `GITHUB_CLIENT_SECRET` | The GitHub OAuth app's secret, for sign-in. |
| `GOOGLE_CLIENT_SECRET` | Optional (PS-274): the Google OAuth client's secret. With `GOOGLE_CLIENT_ID` (a var in `wrangler.jsonc`), the sign-in page shows "Sign in with Google"; with either unset there is no button and `/auth/google` is a 404. The client is a Google Cloud "OAuth client ID" of type Web application, with the redirect URI `https://<host>/auth/google/callback` (and `http://localhost:3000/auth/google/callback` for `vite dev`). |
| `IMAGE_SIGNING_SECRET` | Signs the short-lived image URLs. |
| `MODEL_KEY_SECRET` | Base64 of 32 random bytes (`openssl rand -base64 32`). Seals each project's model API key at rest with AES-256-GCM (stored as `v1:<iv>:<ciphertext>`). Unset, saving a model key fails with "MODEL_KEY_SECRET is not set" and a stored key is not read, so builds are reviewed as plain pixels. A key saved before this existed is plain text until the project's model settings are next saved. Changing the secret makes the keys sealed under the old one unreadable: enter each key again. |

The `e2e` env in `wrangler.jsonc` carries fixed test values for these; they are not secrets. `env.production` lists none of them: [Deploy to Cloudflare](#deploy-to-cloudflare-pixelslashdev) sets each with `wrangler secret put`.

## Hardening for a deployment strangers sign in to (PS-250)

On by default; `SECURITY.md` says why each exists.

| Setting | Where | Meaning |
| --- | --- | --- |
| `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS` | `wrangler.jsonc` vars (`1` under `env.e2e`) | Empty (the default): a project's or org's model base URL on loopback, RFC 1918, link-local, CGNAT, their IPv6 forms, or a `.local`/`.internal`/single-label name is refused at save and before each call, after resolving the name (`src/ai/model-host.ts`). `1` lets them through, for a self-host running its own model. Never set it on a deployment strangers can sign in to. |
| `GITHUB_OAUTH_BASE`, `GITHUB_API_BASE` | `wrangler.jsonc` vars | A production build refuses to start unless they are `https://github.com` and `https://api.github.com` (`src/auth/stub-guard.ts`). Only `vite dev` and the `CLOUDFLARE_ENV=e2e` build may point at the GitHub stand-in. |
| `GOOGLE_OAUTH_BASE` | `wrangler.jsonc` vars | Empty, Google's own endpoints. A production build refuses to start when it is set; only the Playwright run points it at the stand-in, which answers as a Google account too. |
| `API_RATE_LIMIT`, `SIGNIN_RATE_LIMIT` | `wrangler.jsonc` `ratelimits` | Cloudflare rate-limit bindings: `/api/v1/*` per token (a refused token per client IP), 3000 a minute; `/auth/github`, `/auth/google` and their callbacks per client IP, 30 a minute. Over the limit is a 429. Not under `env.e2e`, so the e2e build and the LAN CT run with the no-op seam in `src/server/rate-limit.ts` and are never limited. |

## Error reporting to Sentry (PS-227)

Optional, and off until a DSN is set. With no `SENTRY_DSN` the Worker is not wrapped, the browser is
never told a DSN (so the reporter's chunk is never fetched) and no request goes out for it.

| Var | Where | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | `.dev.vars` / `wrangler secret put` / the CT's `.dev.vars.e2e` | The Sentry DSN. Server and browser both use it (a DSN is public by design: it can only send events). |
| `SENTRY_RELEASE` | `wrangler.jsonc` vars; `update.sh` | The deployed sha. `update.sh` stamps it on the CT; the e2e build leaves it empty, so the health page says it is not stamped (the Playwright run sets `e2e`). |
| `SENTRY_ENVIRONMENT` | `wrangler.jsonc` vars; `update.sh` | `lan` on the CT, `e2e` under the e2e runs, `dev` otherwise. |

**What is reported.** On the server (`@sentry/cloudflare`): an error the Worker lets out, an `/api/v1`
failure that becomes a 5xx (failed uploads and finalizes), and a failed shot or build diff. In the browser (`@sentry/react`): an uncaught error and an
error that reaches a route's error component. Server-function errors are turned into a response by
TanStack Start before the Worker's wrapper sees them, so they are not reported on the server: one
that breaks a page reaches the browser's error component and is reported there. Tracing is off
(`tracesSampleRate` 0), there is no session replay, no profiling and no breadcrumbs.

**Why `@sentry/cloudflare`.** It is the SDK for the runtime (workerd, here under Miniflare), and
Sentry's TanStack Start docs use it with `withSentry` on Workers. `@sentry/tanstackstart-react` is
in beta and its server setup does not run on Cloudflare. All three SDKs are 11.9.0, MIT.

**Privacy.** Every event passes `scrubEvent` (`packages/engine/src/sentry-scrub.ts`, shared with the
CLI): bodies, cookies, query strings, auth headers, tokens and image data are dropped, and the user
and breadcrumbs are removed. `src/server/sentry.test.ts` and `e2e/sentry.spec.ts` assert it against a
local fake ingest.

**Deploy.** The CT keeps the DSN in `apps/web/.dev.vars.e2e` as `SENTRY_DSN=…`. `release.sh` can
also carry it: with `PIXELSLASH_SENTRY_DSN` set, it goes into the tarball as a mode 600
`.sentry-dsn` (never on a command line, never printed), and `update.sh` saves it into the CT's
`.dev.vars.e2e` and deletes the carried file. `update.sh` then stamps the release's own
`SENTRY_RELEASE=<sha>` and `SENTRY_ENVIRONMENT=lan` into its `.dev.vars` (only when a DSN is set).

**To switch it on (one time):**

1. Create a project in sentry.io (platform: Cloudflare Workers or JavaScript) and copy its DSN.
2. Keep it in a secret store; set the variables any way you like.
3. Deploy with it: `PIXELSLASH_SENTRY_DSN=<dsn> apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"`
   (the same command as the deploy above). Or put `SENTRY_DSN=<dsn>` in the CT's
   `apps/web/.dev.vars.e2e` and deploy the current sha again.
4. For the CLI, set `PIXELSLASH_SENTRY_DSN` where it runs (CI secrets); see "Error reporting" in [`docs/cli.md`](../../docs/cli.md).

## Operator health (`/_admin`, PS-330)

A read-only page for the people who run the deployment: builds by status, the oldest in flight, every
build stuck past `STALE_PROCESSING_MS`, the last 24 hours and 7 days (outcomes, errored builds grouped by
the first words of their error, p50 / p95 / p99 of wall time and each step, and the newest builds'
shots, compares and compare times, cache hits counted apart and timed nowhere; and, over the
whole window, shots per build and time per shot as p50 / p95 / p99 with their `n`, the server's
compares only: a CI build's times sit in `builds.timings` and reading them would read every build of
the window), the release commit, the newest
migration the database reports against the ones the code carries, and row counts. Set
`PIXELSLASH_ADMIN_LOGINS=login1,login2` (GitHub logins, case-insensitive). The page is a 404 for
everyone else, signed out or not, and when the variable is unset; nothing links to it. The LAN stub build lists nobody (every visitor there signs in as `e2e-octocat`), so set `PIXELSLASH_ADMIN_LOGINS` in its `.dev.vars` to open the page. A figure that
cannot be read (R2's total, failed summary calls) says "unavailable" and why instead of a 0.

## Rows written per build

Cloudflare bills D1 by rows written, and each index entry a statement writes counts as a row. `src/db/rows-written.test.ts`
(part of `web:test`) counts D1's own `meta.rows_written` on a local D1 for a fixed fixture: one project, the server diff,
100 shots uploaded and finalised in three builds. (a) is a first main build (every shot new, auto-accepted); (b) a second
main build with 50 shots unchanged, 40 changed and 10 new (so 10 removed markers); (c) a branch build off (a) with the same
mix, which is also measured against main. The test prints the numbers and fails when a build writes more than the last
measured count.

| Build | Before | Each write sets only what moves | And no `build_id` index | Saved |
| --- | ---: | ---: | ---: | ---: |
| (a) first main build | 1,008 | 808 | 708 | 30% |
| (b) second main build | 1,078 | 878 | 768 | 29% |
| (c) branch build | 1,068 | 868 | 758 | 29% |

- **Each write sets only what moves.** A diff run's write to a shot sets only the fields whose value differs from the row
  (`SnapshotWrites`), so a column left as it was, and the index on it, is not written, and a shot whose result is what it
  was sends no statement. The resolved options, which used to be a statement of their own, go in the shot's result
  statement. This took a shot's follow-up writes from 3 rows to 1.
- **No `build_id` index.** It was the left prefix of the shots' unique index, which serves every lookup by build, so a
  shot's insert writes 5 rows, not 6 (migration 0037).
- **A re-run of a build** writes no shot that was already accepted or whose result stands.
- **Images are stored once per org.** A PNG is keyed by its sha256 under the org (`images/<sha256>.png`), and is written
  only when the org does not hold it yet, from any of its projects. The fixture has two distinct images, so (a) and (b)
  store one each and (c) none, where each build used to store 100 PNGs of its own. Shots stored before keep their key
  under the build's folder, which still reads.
- **Tokens** (not in these numbers, which go through no request): a token's `last_used_at` is written at most once in 5
  minutes, not on every request, so "last used" on the settings pages is true to within 5 minutes.

## Retention (PS-239)

Off unless you set it. There are two windows, each a whole number of days above 0 (anything else is off),
and each off when unset:

- `PIXELSLASH_RETENTION_DAYS=30` expires PR builds: a build older than that window, on a branch that is
  not the project's default branch.
- `PIXELSLASH_RETENTION_MAIN_DAYS=365` expires default-branch builds older than that window, with two
  that always stay: **each project's newest default-branch build**, and **any build that holds the current
  accepted shot of a test** (for each test, the newest accepted shot on the default branch: what a new
  build's baseline would be). Unset, no default-branch build is ever deleted.

An expired build is deleted with its blobs (R2, or the self-host's bucket) and its rows. Its blobs are those in its own
folder (`builds/<id>/`): overlays, CI masks, metrics, and the PNGs of shots stored before images went by hash. An image
stored by hash (`images/<sha256>.png`) is the org's, shared by every build that sent those bytes, and the build sweep leaves it
(the orphan sweep below takes it once nothing names it).
A build a surviving build still points at as its
baseline (`baselineKey`, `mainBaselineKey`, `baselineSnapshotId`, `carriedFrom`, and a removed marker's
`image_key` / `baseline_key`) is kept, followed through the builds that are kept, so a chain only goes once
nothing live reaches it. A default-branch build kept that way keeps the PR builds it points at, but not the
default-branch build before it: each one diffed against the one before, so following that chain would keep the
whole history. Flaky shot evidence of a deleted build goes too; the flaky shot itself stays. Usage
counts drop with the builds. With the PR window on, a PR build's page says "expires in N days"; a
default-branch build shows no date, since it may be one that stays.

**Orphaned images** are swept on the same schedule, whatever the windows: an `images/<sha256>.png` that no
shot names any more (as its image, baseline or main baseline) can never be read again, and it is what fills a
self-host's disk once builds are deleted. One put less than a day ago is left alone, since an upload puts the
image before it writes the shot, and the names are read again just before each delete.

- **Dry run first.** The Worker's hourly cron (`triggers.crons` in `wrangler.jsonc`) runs the build sweep only
  with a window set, and both sweeps only log `retention dry run: would delete ...` and `orphaned images dry
  run: would delete ...` until `PIXELSLASH_RETENTION_DELETE=true` is also set. Each sweep takes the oldest 100
  builds and the first 1000 orphaned images, so a backlog clears over several runs.
- **From the command line, for a self-host**, which fires no cron (reads the Miniflare state on disk, a dry run unless
  `--apply`):

  ```bash
  bun deploy/retention.ts                              # list the orphaned images only; deletes nothing
  bun deploy/retention.ts --days 30                    # and the PR builds past 30 days, with their bytes
  bun deploy/retention.ts --days 30 --main-days 365    # and the default-branch builds past a year
  bun deploy/retention.ts --days 30 --limit 100        # the oldest 100 builds only
  bun deploy/retention.ts --days 30 --apply            # delete what it lists
  ```

  The listing has three parts, each on its own: main builds, branch builds and orphaned images, each with
  its count and bytes and what was kept. `--days` defaults to `PIXELSLASH_RETENTION_DAYS` and `--main-days`
  to `PIXELSLASH_RETENTION_MAIN_DAYS`; a window with neither stays off. `--persist-to` is the
  state directory (`.../state/v3`), by default `$PIXELSLASH_DATA_DIR/state/v3` or
  `.wrangler/state/v3`. Stop the server before `--apply`: a build uploaded while the sweep runs can
  point at a baseline the sweep has just chosen to delete, or skip the put of an image the sweep is about to
  delete, which no lock prevents.
- Deletion is permanent; read a dry-run listing before turning it on. Enabling it on a server with real
  data is the operator's decision.

### The database size alert

D1 stops taking writes at 10 GB. The hourly cron reads the database's size and, past 70% of that
(over 7 GB), logs `database size alert: 7.1 GB, 71% of the 10 GB cap; ...` on every run, and /_admin
marks the size. With `PIXELSLASH_ALERT_WEBHOOK_URL` set (a secret: `wrangler secret put`, or
`.dev.vars`), it also POSTs `{text, bytes, capBytes, share}` as JSON to that URL at most once a UTC day
per database; a day is marked as sent (`ops/size-alert/<day>` in the bucket) only after the POST succeeds, so a
failed one is tried again next hour. It only tells: nothing is deleted or moved when it fires. Clear space with
the sweeps above, or plan a move.

### Disk on the LAN self-host

`release.sh` asks the CT how much is free under `/home/pixelslash` before it builds anything, and refuses
under 1 GiB with the free space it found; nothing is built or sent. A release unpacks and installs beside the
serving one, and a full disk fails the app's own writes too. `update.sh` then removes what the CT holds for
nothing: the old checkout's `node_modules` (each release installs its own) and Miniflare's local trace store
(`.wrangler/state/v3/observability`). The deploy's D1 calls (`wrangler d1 --local`) wrote it; they now run with
`X_LOCAL_OBSERVABILITY=false`, so it does not grow back. `serve.ts` and `deploy/retention.ts` call Miniflare's
API, which keeps no trace store unless asked.

### Recomputing stored verdicts

A build's status is written when its run ends and again on each review decision, by the verdict rule
of that day (`src/db/verdict.ts`). A build finished under an older rule keeps the status it was given:
one from before a new shot waited for review can read `passed` with a new shot still undecided. For a
self-host, `deploy/recompute-verdicts.ts` lists every finished build (`passed`, `changes` or `failed`)
whose stored status differs from what its shots add up to now, and writes the new one only with
`--apply`:

```bash
bun deploy/recompute-verdicts.ts             # list build id, old status -> new; writes nothing
bun deploy/recompute-verdicts.ts --apply     # write them
```

It only changes `builds.status`; it adds and deletes nothing. A `processing` or `errored` build is
left alone, and each write is fenced on the status it read, so a decision made meanwhile wins. A
second run lists nothing. `--persist-to` is as for `retention.ts`.

### Abandoned builds (PS-324)

Always on, with no setting. A build still `uploading` or `processing` whose last activity is older than
6 hours is ended at `errored` with the reason `no activity for 6 hours: the uploader or its run went away;
send the build again`, so a build whose uploader went away stops counting as in flight. Last activity is the
latest of the build's creation, its `processingStartedAt` and its newest shot's upload. Only `status` and
`error` are written: nothing is deleted and no time is recorded, so an ended build is never in the timing
numbers. Sending finalise again resumes a server-diff build, as for any `errored` build; a CI-diff project's gets the
409 that build recovery gives, and a build that never finalised is completed only by sending it again. The hourly cron runs the sweep for
every project; a self-host fires no cron, so there a project is swept only when it next creates a build.

## The GitHub commit status (PS-23)

Optional. A project connected to a GitHub repo (project settings → GitHub repo) gets a
**PixelSlash** commit status on each build's commit: `pending` while the build is diffed and while
changes await review (titled with what waits, "3 changes to review"), `success` once every change is
accepted or nothing changed, `failure` when a shot is rejected or the build errored. Each state
change is a new status on the commit and GitHub shows the latest. Its **Details** link opens the
build page in one click, which is why it is a status and not a check run: a check run's Details
opens GitHub's own check page. A status has no body, so it carries only the one-line title and the
link; the counts and the waiting shots are in the PR comment (below) and on the build page. A
waiting change is pending, not failed, so it never reads as red CI; a branch protection rule that
requires `PixelSlash` therefore blocks the merge until the changes are reviewed. When several
projects of one org are connected to the same repo (compared ignoring case), each project's status
is named `PixelSlash / <project name>` instead, so they can be told apart on the commit. Connecting
a second project renames the first one's status from its next sync, so a branch protection rule
that requires `PixelSlash` must name the new ones, and a status already posted under the old name
stays on its commit. A build of a pull request also keeps one comment on the PR, edited in place
on each build (below).

It is posted by the GitHub App when one is configured: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (a
secret) and `PIXELSLASH_PUBLIC_URL` for the link. Without both App vars, a token can post it
instead (below); with neither, nothing calls GitHub. `GITHUB_APP_API_BASE` (PS-281) is the App's
own API base; empty, the App uses `GITHUB_API_BASE`. The LAN self-host sets it to
`https://api.github.com` (`release.sh` carries it with the App id) while sign-in stays on the stub.
Registering the App, its permissions and deploying its key:
[`github-app/README.md`](github-app/README.md).

**Moving from the check run.** The App used to post a check run instead. It now needs
`statuses: write`: the owner grants **Commit statuses: Read and write** in the App's settings and
each installation accepts the request GitHub sends; until then the status calls get a 403, which is
logged and not reported. A branch protection rule that requires `PixelSlash` keeps working by name;
if the rule was tied to the check run's app, pick `PixelSlash` from the list again. A build that
still has a check run from before gets it completed once as `neutral` ("Moved to the PixelSlash
commit status") on its next sync; a failed completion is logged and not tried again, and a build
that is never synced again keeps its old run until GitHub marks it stale.

### The pull request comment (PS-82)

A PR gets one comment from PixelSlash for all of an org's projects connected to its repo, made by the
first build that names it (`prNumber`) and edited in place by every later build of any of them. Each
edit rebuilds the whole body from each project's newest build on the PR's newest commit with a
verdict (one still uploading or diffing does not move it): an overall title
(`39 changes to review in 2 of 16 projects`), then a section per project with changes or an error
(the model's summary or "Summary skipped", the counts, the three to five most changed shots as
links, and the build page link), then one line naming the projects with no visual changes. A repo
with one commenting project shows its section with no heading. Two projects' builds syncing at once
cannot drop a section: each sync reads the PR again after its edit and edits again when the body has
moved on. The comment is keyed by org, repo (ignoring case) and PR number; comments that separate
projects made on a PR before it was shared stay on GitHub as they were, and the oldest is the one
kept and edited. Text and links only; no shot goes to GitHub. It is sent
with the same client as the commit status (the App, or the token), only to the project's connected repo,
and only when the project's "Comment on pull requests" setting (on by default) is on. A failed
comment call is logged and never changes a build's verdict. The App needs `pull_requests: write`
(`github-app/README.md`).

### Without the App: a commit status with a token (PS-235)

A self-host that has not registered the App can post the same **commit status**, context
`PixelSlash`, with a fine-grained personal access token. The states, the title and the link are the
App's; only the credential differs. When both are configured the App posts it and the token is not used.

- **Token scope.** Create a fine-grained token (GitHub → Settings → Developer settings → Personal
  access tokens), resource owner = the account or org that owns the repos, repositories = only the
  ones whose projects you will connect, repository permissions **Commit statuses: Read and write** and, for the pull request
  comment, **Pull requests: Read and write** (GitHub adds the read-only Metadata permission itself).
  Nothing else.
- **Where the secret lives.** `GITHUB_STATUS_TOKEN`, a secret and never a var: `wrangler secret put
  GITHUB_STATUS_TOKEN` on Cloudflare, `.dev.vars` for `vite dev`, and the CT's `.dev.vars.e2e` on the
  LAN self-host (`release.sh` does not carry it; a release keeps the lines it did not write). The
  Docker self-host reads it from the container's environment.
  `PIXELSLASH_PUBLIC_URL` sets the link, as above.
- **Precedence.** The App is used when it is configured; the token only when it is not. With
  neither, nothing calls GitHub. Connect each project to its repo as for the App (project settings
  → GitHub repo).

## Run it locally as a project's server

A local server is a real PixelSlash server: a CLI pointed at it uploads, the server diffs, and the
build page is reviewed in a browser. Nothing leaves the machine and no Cloudflare account is used:
D1 and R2 are miniflare's, kept in `apps/web/.wrangler/state` (gitignored) across restarts.

Sign-in uses the `e2e` environment in `wrangler.jsonc` and the GitHub stand-in the e2e suite runs
(`e2e/github-stub.ts`): every visitor signs in as `e2e-octocat`. That is fine for one person on
their own machine and nothing more.

From `apps/web`, after `bun install` at the repo root:

```bash
# 1. Migrate the local D1 (once, and again after a pull that adds a migration).
bunx wrangler d1 migrations apply DB --local --env e2e

# 2. The GitHub stand-in, on :4174. Leave it running.
bun e2e/github-stub.ts &

# 3. Serve the app with the e2e vars on :3000.
CLOUDFLARE_ENV=e2e bun run dev -- --host 127.0.0.1 --strictPort
```

This is the dev server, so changes to the app reload without a rebuild. The server diff runs under
it as it does in a build; to serve the production build instead, `CLOUDFLARE_ENV=e2e bun run build`
then `HOST=127.0.0.1 bun deploy/ssh/serve.ts` (the LAN self-host's server, below; `PORT` moves it off :3000).
`bunx vite preview --host 127.0.0.1 --port 3000 --strictPort` still serves the same build.

`bunx moon run web:test-e2e` (and `bun run test:e2e:dev`) does not use :3000 or :4174: `e2e/ports.ts` picks two
free ports per run, so two runs from two worktrees can go at once. Set `PIXELSLASH_E2E_PORT` and
`PIXELSLASH_E2E_STUB_PORT` to pin them. Each run builds and keeps its D1 under its own worktree's
`.wrangler/e2e`, and turns the Workers debugger port off (it probes from 9229 and two runs at once
both get it).

The suite signs in once: the `setup` project (`e2e/signed-in.setup.ts`) clicks "Sign in with GitHub"
and saves the session to `.wrangler/e2e/signed-in.json`, and every spec starts signed in from it.
Only that file, `sign-in.spec.ts` and `google-sign-in.spec.ts` click the button; a spec about visitors
opts out with `test.use({ storageState: SIGNED_OUT })`. Specs import `test`, `expect` and `open` from
`e2e/fixtures.ts`. Its `provision({ org, project })` fixture writes an org (its name suffixed so it is
unique per test and per repeat), the stub user's membership, a project and a CI token straight into
the run's D1, and returns their ids, names and the token. Making those three by clicking is proved once,
in `orgs.spec.ts`. Every navigation goes through `open(page, path)`, which waits for the hydration
marker; the Docker self-host spec, whose D1 is inside the container, still provisions by clicking
(`deploy/docker/ui-provision.ts`).

Then, in a browser at `http://127.0.0.1:3000` (use one host throughout: the session cookie is per
host, and the OAuth callback is built from the host you came in on):

1. **Sign in with GitHub.** The stand-in signs you straight in.
2. **Create the org and the project**, e.g. both named `hackcove`.
3. **Issue a CI token** in the project's Settings. It is shown once. Save it to a file outside every
   repo, readable only by you:

   ```bash
   mkdir -p ~/.config/pixelslash
   install -m 600 /dev/null ~/.config/pixelslash/hackcove-local.token
   $EDITOR ~/.config/pixelslash/hackcove-local.token   # paste the psci_… token
   ```

Upload to it from the project's checkout. The CLI reads the commit, branch and merge-base from the
directory it runs in, so run it there by path (not `bun run pixelslash`, which runs in this repo):

```bash
PIXELSLASH_SERVER=http://127.0.0.1:3000 \
  bun ~/dev/pixelslash/packages/cli/src/index.ts upload <snapshot-dir> \
  --token-path ~/.config/pixelslash/hackcove-local.token
```

Every `main` build is accepted without review. A branch build diffs each shot against the newest
accepted one at the nearest of its merge-base and its ancestor commits (up to 200), so `main` needs a build at the
merge-base or any of those ancestors before a branch is reviewed, or every shot on it reads "new".

In hackcove, `bunx nx run storybook:visual-upload` does both: it uploads `origin/main`'s capture as
`main` (once per main commit and server), then the branch's. It refuses a branch that is not based
on `origin/main`'s tip, a dirty tree and `main` itself.

```bash
PIXELSLASH_DIR=~/dev/pixelslash \
PIXELSLASH_SERVER=http://127.0.0.1:3000 \
PIXELSLASH_TOKEN_PATH=~/.config/pixelslash/hackcove-local.token \
  bunx nx run storybook:visual-upload
```

To start over, stop the server and remove `.wrangler/state`.

## Deploy to Cloudflare (pixelslash.dev)

The hosted app (PS-277) is `env.production` in `wrangler.jsonc`: the Worker `pixelslash-web-production` on the
custom domain `pixelslash.dev`, D1 `pixelslash` (WEUR), R2 `pixelslash-blobs` and the queue
`pixelslash-explain`, all in the maintainer's account. It is a named env, built with
`CLOUDFLARE_ENV=production`, so the top level keeps its placeholder D1 id and no route: `vite dev`, the
unnamed build, the e2e build and the LAN CT read the same config as before. The Worker's name is
the top level's plus the env, so forgetting `CLOUDFLARE_ENV=production` publishes a different Worker
(`pixelslash-web`) and never overwrites the live one. (For your own account, use
[`SELF-HOST.md`](SELF-HOST.md).) It is still a production build to the stub guard: it refuses to start
pointed at anything but github.com.

### From CI: the deploy workflow

Production deploys run from `.github/workflows/deploy.yml`. Every push to `main` starts it: it waits for that
commit's CI jobs `changes`, `gate`, `web` and `example`, and once
they pass the `deploy` job, named after the sha, asks for approval in the `production` environment. `visual`
and `self-host` do not count: `visual` uploads to pixelslash.dev itself, so a broken production would block
its own fix. The run's summary names the commit and its subject. After one click (the run's page, **Review
deployments**) it runs the steps below in order: the production build, the D1 migrations, `wrangler deploy`
with `SENTRY_RELEASE`, `scripts/check-commit.ts` and `web:smoke`.

While it waits on CI, a push's run stops with no deploy as soon as `main` moves past its commit (the newer
push's run deploys), fails when no CI run for the commit has appeared after 10 minutes (CI disabled, say), and
fails after five GitHub API errors in a row. A push's deploy whose commit is no longer `main`'s tip by the
time it is approved fails without deploying.

One deploy runs at a time (the `production` concurrency group) and a running one is never cancelled. GitHub
keeps one running and one pending job per group, and a newer job cancels the pending one. Its docs do not say
whether a job waiting for approval counts as running or pending, so expect either: a deploy left waiting may
hold back the ones behind it (approve or reject it), and a newer deploy may cancel one that is waiting. That
includes a manual rollback: a newer push can cancel a rollback still waiting for approval, without a word. If
a rollback shows cancelled, run it again.

To deploy (or roll back to) a given commit on `main`, run it by hand with that sha. It must be the head of a
push to `main` (every squash merge is), and it still needs that push's CI jobs above passed and the same approval:

```bash
gh workflow run deploy.yml -f sha=<sha on main>    # -f sha=main for the tip
```

The `production` environment is set up once. Only `main` may deploy to it, the repo owner is its required
reviewer, and it alone holds the three secrets (`<reviewer-user-id>` is `gh api users/<login> --jq .id`):

```bash
gh api -X PUT repos/slashsuite/pixelslash/environments/production --input - <<'EOF'
{"reviewers":[{"type":"User","id":<reviewer-user-id>}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF
gh api -X POST repos/slashsuite/pixelslash/environments/production/deployment-branch-policies -f name=main -f type=branch
printf '%s' "$CLOUDFLARE_API_TOKEN"  | gh secret set CLOUDFLARE_API_TOKEN  --env production
printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --env production
printf '%s' "$SMOKE_TOKEN"           | gh secret set SMOKE_TOKEN           --env production   # the smoke account's token, below
```

The Cloudflare token is the scoped deploy token described next; never paste a token on the command line.
The environment has `can_admins_bypass` on (GitHub's default): a repo admin can deploy without the
reviewer's approval. That is the owner's call; the setup above leaves it as it is.

### By hand: the fallback

When the workflow cannot run (GitHub down, a broken runner), deploy from a clean checkout at the commit.

Deploy with an API token, not `wrangler login`, so the credentials are scoped and the commands are repeatable.
Create the token in your Cloudflare dashboard under **My Profile → API Tokens → Create Token** (a custom
token), with these permissions:

- **Account** · Workers Scripts: Edit (publish the Worker)
- **Account** · D1: Edit (apply the migrations)
- **Account** · Queues: Edit (bind `pixelslash-explain`)
- **Account** · Account Settings: Read
- **Zone** · Workers Routes: Edit and DNS: Edit on the zone that holds your custom domain (the deploy
  creates that hostname's record; see below)

Scope it to the one account and, for the zone rows, to that one zone. Then set both variables in the shell
you deploy from. The account ID is on the right-hand side of any zone's Overview page in the dashboard:

```bash
export CLOUDFLARE_API_TOKEN='<the token you just created>'
export CLOUDFLARE_ACCOUNT_ID='<your account ID>'
```

R2 bucket admin (creating or deleting `pixelslash-blobs`) is a separate job and needs a token with
**Account** · Workers R2 Storage: Edit. The deploy only binds the bucket, so keep that token out of the deploy shell.
From `apps/web`:

```bash
CLOUDFLARE_ENV=production bun run build                          # writes dist/ for env.production
bunx wrangler d1 migrations apply pixelslash --remote --env production
CLOUDFLARE_ENV=production bunx wrangler deploy --var SENTRY_RELEASE:"$(git rev-parse --short HEAD)"
bun ../../scripts/check-commit.ts https://pixelslash.dev/ "$(git rev-parse HEAD)"
SMOKE_BASE_URL=https://pixelslash.dev SMOKE_TOKEN_FILE=<file> bunx moon run web:smoke
```

The check-commit line proves the deploy is live: every page carries `<meta name="build-commit">`, the commit it
was built from (`build-commit.ts`), and the check fetches the page until it names this one (up to two
minutes, past the edge's lag), exiting 1 with the sha it saw if it never does.

The last line is the deployment's smoke (`smoke/web.smoke.ts`): the sign-in page serves, an unknown
path is a 404, and the smoke account's token signs in (`/api/v1/me`) and sees its org's project
(`/api/v1/projects`). It only reads, so a run adds no row. The account is a synthetic org
(`is_smoke = 1`, out of every count) made once per deployment, and again to rotate its token:

```bash
bun smoke/account.ts token > "$TMPDIR/smoke-token"          # keep it in your secret store, not the repo
SMOKE_TOKEN_FILE="$TMPDIR/smoke-token" bun smoke/account.ts sql > "$TMPDIR/smoke.sql"   # the hash only
bunx wrangler d1 execute pixelslash --remote --env production --file "$TMPDIR/smoke.sql"
```

A self-host applies the same SQL to its own D1 (`wrangler d1 execute pixelslash --local` where the
app runs) and passes its own token.

Build first: `wrangler deploy` ships what `dist/` holds, and a build made without
`CLOUDFLARE_ENV=production` is the top level's (placeholder D1 id, no route, no custom domain).
Apply migrations before the deploy that needs them; the migration step is the only one that changes
the database. `wrangler deploy --dry-run --outdir "$TMPDIR/ps-web-dry"` after the build prints the
bindings (the D1 id, the bucket, the queue, the vars) and exits without deploying; the route is in
`dist/server/wrangler.json`.

Wrangler warns that `IMAGE_SIGNING_SECRET` and `SENTRY_DSN` exist at the top level but not in
`env.production.vars`. That is on purpose: a var and a secret of one name clash, and an empty var
would shadow the secret, so `env.production` lists no secret at all. Set each once, from `apps/web`:

```bash
openssl rand -base64 32 | bunx wrangler secret put IMAGE_SIGNING_SECRET --env production
openssl rand -base64 32 | bunx wrangler secret put MODEL_KEY_SECRET --env production
bunx wrangler secret put SENTRY_DSN --env production            # optional: off while unset
bunx wrangler secret put GITHUB_CLIENT_SECRET --env production  # with GITHUB_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET --env production  # with GOOGLE_CLIENT_ID
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --env production # with GITHUB_APP_ID
```

`IMAGE_SIGNING_SECRET` is required (without it every signed image URL fails); `MODEL_KEY_SECRET` is
base64 of 32 bytes and, once projects have sealed keys, must not change (see [Secrets](#secrets)).
`GITHUB_CLIENT_ID` and `GOOGLE_CLIENT_ID` are vars, set in `env.production.vars` (both are public OAuth
client ids; the secrets above are the other half). `GITHUB_APP_ID` is a var too: `5528217`, the App "PixelSlash Review"
(PS-234, slug `pixelslash-review`), whose key is the `GITHUB_APP_PRIVATE_KEY` secret. While either half of a sign-in is empty it is off (no button, `/auth/<provider>` a 404).

**Do not make a DNS record for `pixelslash.dev` by hand** (not a CNAME, not an
A record, not in the dashboard). `custom_domain: true` makes Cloudflare create the record and the
certificate during `wrangler deploy`; a record that already exists makes that deploy fail ("hostname
already has DNS record"), and deleting it is a step on a live zone. The routes name only that one
hostname, so a deploy never touches any other record.

**pixelslash.dev is the only host.** The app used to live on `app.pixelslash.dev`, and the apex was the
docs site, whose pages now live on slashslash.build. The old app host has no route and no DNS record
any more. Sign-in calls back to pixelslash.dev only, so the old host's callback URLs in the GitHub and
Google OAuth settings are unused, and are still to be removed there by hand. The app's entry still answers the old docs site's paths
(`src/server/moved.ts`) before any route runs: `/docs`, `/docs/<slug>`, `/security`, `/self-host`,
`/how-it-works`, `/compare`, `/pricing`, `/search-index.json` and `/sitemap.xml` 301 to their
slashslash.build address, the query kept.

## Backups and restore

Production's database, D1 `pixelslash` (`env.production`), has two backups: D1's own point-in-time
restore (Time Travel) and a daily export to R2. Neither covers the R2 blobs (`pixelslash-blobs`, the shot
PNGs); a restored database points at the blobs as they are now.

### Time Travel: back to a moment in the last 30 days

Time Travel is always on for D1; nothing turns it on, and it keeps 30 days on a paid account (7 on the free
plan). Read the current bookmark (it only reads):

```bash
bunx wrangler d1 time-travel info pixelslash --env production
bunx wrangler d1 time-travel info pixelslash --env production --timestamp 2026-11-27T21:00:00Z   # the bookmark at a time
```

A restore **overwrites the live database in place**, so everything written after that moment is gone,
and it is the maintainer's call, never a routine step. Note the current bookmark first (the restore prints
it too): restoring to it undoes the restore.

```bash
bunx wrangler d1 time-travel restore pixelslash --env production --timestamp 2026-11-27T21:00:00Z
bunx wrangler d1 time-travel restore pixelslash --env production --bookmark <bookmark>
```

### The daily export

`.github/workflows/backup.yml` runs at 03:41 UTC every day, and from **Run workflow** on its Actions page.
It runs `wrangler d1 export pixelslash --remote --env production`, gzips the dump and puts it in the
private R2 bucket `pixelslash-backups` as `d1/pixelslash/<YYYY-MM-DD>T<HHMMSS>Z.sql.gz` (the UTC time it
was taken), then reads the object back and fails unless R2 lists it at the size it sent. wrangler's output
from the export goes to a file, never the job's log: it prints a presigned link to the whole dump, and the
repo's Actions logs are public. The bucket's
lifecycle rule `expire-30d` deletes a dump after 30 days. D1 answers no other query while an export runs, which is why it runs at night.

The job runs in the GitHub environment `backups`, which only `main` may deploy to and which alone holds its
three secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_TOKEN` (D1, for the export) and
`CLOUDFLARE_R2_TOKEN` (R2 write on the bucket). No pull request can read them.

### Restore from a dump

A dump is never imported into `pixelslash` itself: it goes into a **new** database, which a deploy then
points `env.production`'s `DB` binding at. The export as written does not import into D1: it writes each
table's schema and rows together, in creation order, so a table that references one created later fails
its foreign key, and some `builds` rows are over D1's 100 KB statement limit. `scripts/restore-test.ts
prepare` rewrites it into an order D1 takes (every table first, parents' rows before their children's, a
long row inserted short and appended back in pieces); it needs no credentials and changes no data.

```bash
bunx wrangler r2 object get pixelslash-backups/d1/pixelslash/<key>.sql.gz --file dump.sql.gz --remote
gunzip dump.sql.gz
bun ../../scripts/restore-test.ts prepare dump.sql restore.sql
bunx wrangler d1 create pixelslash-restored --location weur
bunx wrangler d1 execute pixelslash-restored --remote --file restore.sql
```

### The restore test

`bun scripts/restore-test.ts` (from the repo root) proves the newest dump restores. It downloads it, prepares
it as above, imports it into a new scratch database `pixelslash-restore-test`, checks that every table holds
as many rows as the dump inserts into it, and deletes the scratch database, pass or fail. A row too long
for one D1 statement goes in as an INSERT and appends, so for each column that happened in it also checks
the column's total length against the dump's. It prints table names and numbers only, never a row, and
exits 0 when every check matches. Pass a key to test an older dump.
It reads the same three names as the workflow's secrets from the environment, and runs wrangler in an empty
directory with no config, so the scratch database is the only one it can name. Run it after a migration
that adds a table or a foreign key, and at least once a quarter.

## Run it on the Proxmox server

The same local server, on a Proxmox host instead of your machine, so the dashboard is up without
anything running here. It is **LAN only**: sign-in is still the GitHub stand-in, so anyone who can
reach the address signs in as `e2e-octocat` and sees every org. No port forward, no tunnel, no
public DNS. Real GitHub sign-in is a later ticket.

| | |
| --- | --- |
| Dashboard | `http://<ct-address>:3000` |
| Stand-in | `http://<ct-address>:4174` (the browser is sent there to sign in) |
| Container | CT `$CT` `pixelslash` on the Proxmox host `$SSH_HOST`: Debian 13, unprivileged, 4 vCPU, 8 GB, 10 GB on `local-lvm`, starts on boot. The address is static in the CT config, below the router's DHCP pool. |
| Releases | `/home/pixelslash/releases/<sha>/`, user `pixelslash`, one per deploy, built on the machine that deploys; `releases/current` is the one serving. The last 3 are kept. Bun is in `~pixelslash/.bun`, Node 24 (for wrangler) in `/usr/local`. |
| Old checkout | `/home/pixelslash/pixelslash`, the git checkout the CT served from and built in before PS-225. Nothing runs from it now; it holds the state and the secrets below. |
| State | D1 and R2 in the old checkout's `apps/web/.wrangler/state` on the CT's disk; every release's `apps/web/.wrangler/state` links to it, so it is kept across restarts, deploys and rollbacks. |
| Units | `pixelslash-stub` (`bun e2e/github-stub.ts`) and `pixelslash-web` (`bun deploy/ssh/serve.ts`: the production build on Miniflare, no vite), from `deploy/ssh/`, in `releases/current/apps/web`. Both restart on failure and start on boot. The server diff runs in `pixelslash-web` (below). `pixelslash-watchdog.timer` restarts `pixelslash-web` when it is active and silent (below). |

`deploy/ssh/serve.ts` calls Miniflare's API on the build (`dist/server` is the Worker, `dist/client` the
assets): the D1 and R2 in `.wrangler/state/v3` that `vite preview` kept, the `wrangler.json` vars with
`.dev.vars` over them, the explain queue. It listens on `0.0.0.0:3000`; `HOST` and `PORT` move it (the
Rust front door of PS-217 will set `127.0.0.1` and `3001`). It does not migrate or build: the deploy does.

The build is the `e2e` environment's with three values replaced. `apps/web/.dev.vars.e2e` on the CT
(mode 600, gitignored, never in git) sets `GITHUB_OAUTH_BASE=http://<ct-address>:4174`, so the
browser on another machine is sent to the stand-in at the CT's address rather than its own
`localhost`, a random `IMAGE_SIGNING_SECRET`, and the deployment's `MODEL_KEY_SECRET` (without it
the CT would seal keys under the `e2e` env's fixed test value). It lives in the old checkout and never
leaves the CT: the build runs on the deploying machine, which ships no `.dev.vars`, and the deploy copies the
CT's file into the release's `dist/server/.dev.vars` (mode 600), where `serve.ts` reads it. The `e2e`
env in `wrangler.jsonc`, and so the tests, are unchanged.

**Deploy (PS-225): the CT never builds.** A build beside the running workerd did not fit in the
CT's memory, so the build runs on the deploying machine and the CT gets the result. From a clean checkout of
the commit (main, after the merge):

```bash
PIXELSLASH_LAN_SSH=root@$SSH_HOST PIXELSLASH_LAN_CT=$CT PIXELSLASH_LAN_SSH_KEY=~/.ssh/<key> \
  apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"
```

`release.sh` refuses a sha that is not `HEAD` or a tree that is not clean, runs
`CLOUDFLARE_ENV=e2e bun run build`, packs the commit's tracked files (without `bench/`) and
`dist` into one tarball, sends it over ssh to the Proxmox host and in with `pct push`, and runs that
release's own `deploy/ssh/update.sh` in the CT. The host, the CT and the key come only from those
variables (`PIXELSLASH_LAN_SSH_KEY` is optional); nothing is hard-coded. It is not run automatically.
After the switch, with `PIXELSLASH_PUBLIC_URL` set, it runs `scripts/check-commit.ts` on that URL and
fails unless the page's `build-commit` meta names the sha; unset, it prints that command for you to run.
With `SMOKE_TOKEN_FILE` (or `SMOKE_TOKEN`) set as well, it then runs the smoke against that URL (see
[Deploy to Cloudflare](#deploy-to-cloudflare-pixelslashdev)), with the CT's own smoke account's token.

On the CT, `update.sh` unpacks the release into `releases/<sha>` beside the one serving, installs it
(`bun install --frozen-lockfile --production`) and runs the D1 migrations (additive only), then
points `current` at it and restarts the units. **The downtime is that restart only.** A release that
does not come up on :3000 goes back to the previous one by itself and is deleted; the script's header
and comments have the details. A sha still kept on the CT (the last 3) is switched to without
unpacking it again, so deploying the current sha applies a changed `.dev.vars.e2e`, and deploying
an older one from a clean checkout of it is the rollback by hand. Every deploy also retires the old
opencode helper from a CT that still runs it (its unit, switch, key and binary, and the org model
rows that point at it); on a CT without it this does nothing. An org explains through
its own model endpoint, set in the project's or org's settings.
wrangler is a runtime dependency of `apps/web` so the production install has it for the migrations.

**A deploy does not run under a live build (PS-228).** The restart kills the Worker mid-diff and the
migration can hold the D1 file's write lock, so a build being diffed at that moment ended `errored`
(a deploy during an upload did exactly that). Before it changes anything, `update.sh` asks the
serving release's D1 for builds that are `processing` and began within the last 15 minutes. Any
makes it exit 1 with the build ids and `nothing changed`; run it again once they end. A build
`processing` for longer is an orphan (the run died with its Worker; 7a698500 was one) and never
blocks. If the D1 cannot be read the deploy stops too, since not knowing is not a go-ahead. To
deploy anyway: `PIXELSLASH_DEPLOY_FORCE=1 apps/web/deploy/ssh/release.sh …` (`release.sh` carries it
into the CT). The first release on a CT has no serving D1 to ask and skips the check.

The Worker also rides out a short lock itself: `database()` (`src/server/env.ts`) wraps the D1
binding in `retryBusy` (`src/db/busy.ts`), which runs a statement again on `SQLITE_BUSY` / `database
is locked` after 25, 50, 100 and 200 ms (five tries, about 375 ms) before the error stands. A busy
statement did not run, so a repeat is safe. A lock held longer still ends the build `errored`, and
the build's `error` names the SQLite cause, not only drizzle's `Failed query`. The CLI treats an
`errored` build at the end of `upload` as an upload failure (exit 1, `UPLOAD FAILED: build <id>
errored on the server: <reason> (<build page>)`), so CI no longer passes a build nobody diffed.

**workerd's memory (PS-155).** A day of `/workerd-rss.log` samples (every 10 min, 2026-10-23 to 25) shows workerd at 127-140 MB idle
and stepping to 1.5-1.8 GB (peak 1.82 GB) within one 10-minute sample of an upload burst (the snapshot PUTs and `finalize`),
then holding there for hours until the unit restarts, which brings it back to 130 MB. It does not grow without bound, but it
does not give the memory back, and with `vite preview` (~0.5 GB) beside it the peak was more than the CT's 2 GiB: that was the
two OOM kills of 2026-10-25. `pixelslash-web` has run `deploy/ssh/serve.ts` since PS-220 instead, which takes about 450 MB
out of the unit at idle and after a burst (`perf/README.md`, desktop A/B). `pixelslash-web.service` carries `MemoryMax=2500M`
and `OOMPolicy=stop` ("Memory limits and the watchdog", below); every deploy installs the release's unit, so the cap survives
an update.

Logs: `pct exec $CT -- journalctl -u pixelslash-web -f`. Point a project's upload at it with
`PIXELSLASH_SERVER=http://<ct-address>:3000` and a token issued in its Settings on the CT. A token
works only on the server that issued it, so keep one token file per server (the local one and the
CT's are different tokens).

The diff runs inline in the finalise request with a 25 s budget (`DIFF_BUDGET_MS`), which stands in
for a Worker's CPU limit. On the CT's 2 vCPU a build of hackcove's 145 shots measures about 126 and
then stops at the budget: the build reads `errored` and names how many shots are left. A finalise
sent again resumes (it keeps what was measured and diffs the rest), and `pixelslash upload` sends it
again by itself while the count falls, so the build ends with all 145 measured and its real verdict.

### The server diff and its pixel limit

The server diff is the engine's `diff.wasm`, the CLI's diff (PS-210; there is no pngjs diff and no
switch), run in workerd in the finalise request, here as on Cloudflare and in Docker: one process.
The shots never leave `pixelslash-web` (invariant 4).

**A band at a time (PS-464, `diffPngsBanded`).** workerd answers every request on one thread, and a
whole diff of a 1280x16800 pair holds it for about 4 s (the pixel loop 2.7 s, the regions 1 s). Run
in one piece, that left `GET /` unanswered for over 10 s on 30 of 72 probes while one uploader sent
seven such shots, and for up to 35 s with three. So the server runs the pixel loop in bands of 8 tile
rows (512 px) and lets every ready request run between bands and between the diff's other steps.
The result is the one-piece diff's, overlay included: a pixel's test reads only the two shots,
never another pixel's result (the engine's corpus tests hold this on every bench pair, at one tile
row a band). One diff runs at a time (`src/diff/call-gate.ts`): each holds a wasm instance as large
as its shots, so two at once would double that memory and halve each one's share of the thread. The
regions pass is still one piece, so a page can wait about a second behind it.

**The pixel limit (`DIFF_LIMIT_MPX`, `src/diff/limit.ts`).** Memory follows the pixels: a diff adds
about 30 MB per Mpx on top of everything the app already holds, so the self-host admits a pair only
up to a size, by the box both PNGs fit in, read from their headers before anything is decoded. A
pair over it is not diffed: the shot keeps the reason in its `diffError`, and the build ends
`errored` naming it, `too large for a server diff on this server: 1280x20000 = 25.6 Mpx, limit 24.5
Mpx`. A re-run cannot help it, so it is not reported to Sentry. The limit is set in
`wrangler.jsonc`'s `env.e2e` vars (the CT build and the e2e runs) and by the Docker entrypoint, both
24.5 Mpx (1280x19140): the top of the range the old diff process allowed, and well inside
`pixelslash-web`'s 4000M by the measurement below.
Cloudflare never sets it: unset admits every shot, and the Worker's own limits and the diff ceiling
above apply. A value that is not a positive number fails every API call naming the var.

### Memory limits and the watchdog

On 2026-11-05 a tall upload left `pixelslash-web` and the separate diff process of the day in D
state over their `MemoryHigh`, with swap full: port 3000 accepted connections and answered nothing,
nothing was killed, and systemd read `active` with `NRestarts=0`. Held locally to those limits and
fed 1280x16800 diffs, the diff process wedged the same way and stayed wedged past 270 s (PS-323). So:

- **No `MemoryHigh` and no swap.** Over `MemoryMax` the kernel kills the process, the unit fails,
  and `Restart=` brings it back. The same overload with no High was killed within seconds.
- **One unit holds it all.** Every server diff runs in `pixelslash-web`, so its `MemoryMax` is
  4000M: the 2500M it had, the 1000M of the diff process it replaced and the 500M of the retired
  opencode helper. The bundle renderer has its own 4000M beside it, so the two fit the CT's 8 GB; the stub is small. The Proxmox host is
  overcommitted, so the limit is a ceiling, not a reservation.
- **The limit rests on these numbers** (PS-464), measured locally with `perf/web-burst.ts` on one
  `systemd-run --user` unit shaped like the CT's (`MemoryMax=4000M`, `MemorySwapMax=0`, no
  `MemoryHigh`, `OOMPolicy=stop`), on synthetic busy PNGs with every pixel changed, three uploaders
  at once, each a baseline and two branch builds of 7 shots:

| Shots | Peak (cgroup / anon) | Settled 30 s after (cgroup / anon) | OOM kills, restarts | `GET /` over 10 s | Slowest `GET /` | Burst |
| --- | --- | --- | --- | --- | --- | --- |
| 1280x16800 (21.5 Mpx) | 1506 / 1097 MiB | 1425 / 1087 MiB | 0, 0 | 0 of 267 | 7.6 s | 238 s |
| 1280x19140 (24.5 Mpx, the limit) | 1707 / 1254 MiB | 1537 / 1167 MiB | 0, 0 | 0 of 258 | 6.8 s | 229 s |

  The unit idles at 184 MiB. The cgroup figure counts page cache from the local R2 files, which the
  kernel reclaims at the Max; anon is what workerd holds. The live bursts of ob 1887 and PS-155
  reached 1.6 to 1.8 GB without a diff in the unit. Added to the diff's anon at the limit (about
  1.1 GB above idle) that is about 2.9 GB, under 4000M; that is a sum, not a run of both at once,
  and if it is ever wrong the kernel kills the unit at the Max and it restarts. Before the
  banded diff the same 1280x16800 run peaked at 1636 MiB but missed 108 of 218 probes, for up to
  35 s, and the old two-unit setup missed none at 775 MiB plus 801 MiB for the diff process, in
  108 s: three uploaders of tall shots at once now take about twice as long, and the app answers
  throughout. One uploader at a time (seven 1280x16800 shots, two branch builds) took 69 s against
  63 s unbanded, with no probe missed and the slowest 3.4 s.

- **The watchdog.** `pixelslash-watchdog.timer` runs `/usr/local/sbin/pixelslash-watchdog` every 30 s, as
  root: `update.sh` copies `deploy/ssh/watchdog.sh` there, because `pixelslash` owns the releases. It
  asks `GET /` on 3000, with 10 s to answer, and restarts the unit when it is active and has not
  answered 4 passes in a row: `journalctl -u pixelslash-watchdog`. Any HTTP answer counts as alive,
  and a unit that is not active is left to `Restart=`. A deploy stops the timer for its restarts. It
  needs `curl` on the CT; `update.sh` stops before changing anything without it. `watchdog.test.ts`
  proves its decisions on a stub; `perf/wedge-check.ts` runs it against a really wedged web unit
  (`perf/README.md`).
- **Retiring the old diff unit.** A CT deployed before this ran a separate diff unit beside the web unit.
  Every deploy stops and disables it and removes its unit file (`retire_diff` in `update.sh`); a CT
  without it is left as it is.

Docker (`deploy/docker/start.ts`) has the same pixel limit, but sets no cgroup limits and has no
watchdog.

`vite preview` sends each request to workerd on a connection of its own (`freshConnectionPerRequest`
in `vite.config.ts`, ob 1876). On the CT workerd closes its connection about 50 ms after it answers a
long finalise, and the next finalise, sent at once by the CLI, was dispatched on the socket
miniflare's undici pool had kept: `read ECONNRESET`, so a 500 `fetch failed` in the journal and a
retry from the CLI for a request that never ran. Miniflare sets `reset: false` on every request it
sends, so a `Connection: close` header cannot ask for this; the plugin sets `reset: true` on that
pool. Preview only; the Cloudflare deploy does not run it.
`deploy/ssh/serve.ts` (the LAN unit since PS-220) has no such hop: workerd listens on the port, and
a client reaches it directly, so there is no pool socket to reset and the plugin is not on its path
(it stays for `vite preview` on a development machine). A client whose keep-alive socket workerd closes right
after a long answer can still see a reset; the CLI retries a network error for 30 s (1, 2, 4, 8 and 15 s), and a
finalize is resumable. Whether the CT's workerd does that is checked by the CT run in `perf/README.md`.

### The bundle renderer (opt-in)

`pixelslash upload --bundle DIR` sends a static Storybook build instead of shots, and the server
renders it (`docs/storybook-bundle-render.md`). On the CT that is `pixelslash-render`
(`deploy/ssh/render-worker.ts`): a loopback listener on `127.0.0.1:3100` that the web unit hands each
bundle build to, and a queue that renders two builds at once with the engine's `renderBundle`, the
CLI's capture code, then uploads the shots and finalises with a token that reaches only that build's
render paths. It holds no secret of its own and talks only to `127.0.0.1:3000`.

A build's shots are taken in parallel: as many at once as the unit has CPUs (at most ten), or `RENDER_CONCURRENCY` in
`pixelslash-render.service` for another count (a plan's own `concurrency` may only ask for fewer). The unit
sets two, since it runs two builds (below). On the CT (4 cores, 8 GB), 82 uislash shots (Forms/Input and the
Overview gallery sections, one theme, desktop and phone) took 95 s one at a time on the old 2 cores,
87 s one at a time on 4, 52 s two at a time, 40 s four at a time and 40 s eight at a time. The host has
4 cores in all, so more pages than that add only memory.

It renders two builds at once (`RENDER_BUILDS=2` in the unit; unset, one), each with its own
browser and that many shots, in the order they came. A uislash pull request is a dozen builds, one
per group: a build spends part of its time on its plan, its bundle, a browser and its slowest
stories, and the other one fills those gaps. The twelve builds of one such pull request, captured on
4 reserved cores (the CT has four) and 4 GB, took 148 and 156 s one build at a time, 95 and 109 s two
at a time, 89 s three at a time, and 150 s one at a time with eight shots each. Two is the setting: a
third adds little and its own browser's memory under the same limit.

**Memory.** Each worker keeps one preview page and switches stories on it, which is about twice as
fast as a fresh page per shot but holds every story it has switched to, so a build's memory grows
with its pages, not its shots. The pages are closed once the build's shots are taken; the upload's
re-captures shoot on fresh pages. The CT figures are `memory.peak` of the unit, the local ones of a
`systemd-run --user` scope with no swap on 4 pinned cores, for the 238 shots of uislash's Overview
(7 themes, desktop and phone), every shot re-captured as the upload would for a changed one:

| Run | Builds × shots at once | Peak | Wall |
| --- | --- | --- | --- |
| CT, before | 1 × 4 | 2.85 GB | 61 s |
| CT, before | 2 × 4 | killed at 3000M | |
| Local, pages kept | 1 × 4 | 2.06 GB | 61 s |
| Local, pages closed | 1 × 4 | 1.82 GB | 61 s |
| Local, pages closed | 2 × 4 | 3.29 GB | 120 s |
| Local, pages closed | 2 × 2 | 2.69 GB | 142 s |
| Local, a fresh page per shot | 2 × 4 | 1.32 GB | 75 s (no re-capture) |

The CT ran 0.8 GB above the local figure for one build (2.85 against 2.06 GB: the renderer's own
process, about 0.8 GB while it renders, and the upload). That offset was measured on one build, not
two, so two builds of two shots each are estimated at about 3.5 GB (2.69 plus 0.8; 3.7 GB, about 3520 MiB, if the offset grows to 1 GB with the second build) under
`MemoryMax=4000M` (MiB); read the unit's `MemoryPeak` after a burst to check it. With the web unit's
4000M the two limits take 8000 of the CT's 8192 MiB: they are ceilings, not reservations, and the web
unit peaks near 1.3 GB.

Two shots per build costs nothing when two builds run. Eleven builds, one per uislash story group (one
theme, desktop and phone, 1554 shots, capture only), on 4 reserved CPUs, two rounds each: one build of
four shots at a time took 75 and 77 s, two builds of two shots 58 and 58 s, two builds of four 58 and
57 s. A build that runs alone is slower at two shots (the Overview build above: about 35 s against 22
to 26 s locally, capture only).

The renderer is one process, so a kill (its memory limit) stops both builds. Each is then started
again on its own, so after that first kill a kill counts only against the build that caused it.

It is off until the CT's `.dev.vars.e2e` names it. To turn it on, add

```text
RENDER_URL=http://127.0.0.1:3100/jobs
```

and deploy the current sha again (`release.sh`, above). `update.sh` then creates the system user
`pixelslash-render`, installs the release's Playwright Chromium headless shell (with its system
packages) into `/var/lib/pixelslash-render/browsers`, installs `pixelslash-render.service` and
restarts it after the web unit. If that install fails, the deploy still serves the release, says so,
and leaves the renderer out until the next deploy. Without `RENDER_URL` a deploy installs none of it, retires a unit a
previous deploy left, and the API answers a bundle build `409`, so the CLI says to capture on the
client. A renderer that does not take a job (down, or 50 builds queued) makes the CLI's finalise a
`502`.

A newer head of a pull request cancels the old head's renders: the API ends the old head's bundle
builds `errored` (superseded) and sends the renderer `DELETE /jobs/<id>` for each, which drops a
queued job or stops one mid-render (`docs/storybook-bundle-render.md`, section 4). The renderer logs
`dropped from the queue` or `stopping` for each, without the token.

A restart drops no build. The renderer keeps its queue, and the builds it is rendering, in
`/var/lib/pixelslash-render/queue.json` (mode 600: it holds each build's render token), and a new
renderer renders them again, in order. A stop (a deploy, `systemctl restart`) lets the builds being
rendered finish, starts no other, then exits; it has up to 20 minutes (`TimeoutStopSec`). A deploy
queues the renderer's restart (`systemctl restart --no-block`) rather than waiting on it, so it ends
while those builds finish.
A build the renderer dies under (a crash, its memory limit, a stop that ran out of time) is started
again on the next start; one it has died under three times ends `errored`,
`render failed: the renderer stopped 3 times while rendering this build ...`, so a CLI waiting on
it fails rather than waiting for the abandoned sweep.

The bundle is a pull request's own code, so the unit is fenced: its own user with no login, no
access to the app's state or `.dev.vars.e2e`, loopback only (`IPAddressAllow=localhost`), a read-only
system, a private `/tmp` for each job's bundle and shots, Chromium's sandbox left on, and
`MemoryMax=4000M` beside the web unit's 4000M. Logs: `journalctl -u pixelslash-render -f`, one line
per build (`render <id>: <n> shots in <s>` or `failed in <s>: <reason>`), one at a start that took
up builds left by the last renderer (`resumed <n> build(s) ...`), never the token.

The renderer's Chromium is the release's Playwright build, not the pinned capture image, so its
shots carry another environment fingerprint than client-captured baselines. A project that switches
from client capture switches its default branch first: that build's shots are accepted and become
the baselines. A branch's bundle build before then ends `errored`, naming both environments in
full, since its shots were compared with nothing (`src/diff/measured.ts`). Docker and Cloudflare
have no renderer: `RENDER_URL` stays empty there.
