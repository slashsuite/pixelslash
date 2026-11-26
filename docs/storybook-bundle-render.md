# Storybook bundle upload, rendered on the server: design

Status: **approved, built in part.** The CLI's `upload --bundle`, the API (section 2), the render token and the self-host's renderer (`apps/web/deploy/ssh/render-worker.ts`, `pixelslash-render.service`) are built. The production renderer host is not, and the renderer runs the release's Playwright Chromium rather than the pinned capture image.

## 0. Why

A Storybook visual check in a consumer repo takes 9 to 12 minutes on a GitHub runner. Measured in that repo:

- 2428 stories, rendered in Chromium on the runner's 2 lanes, take about 11.6 minutes, then the PNGs are uploaded.
- Building the Storybook takes about 10 seconds.
- The comparison already runs on the PixelSlash server.

So the cost is the render and the PNG upload on the runner. The fix is to send the static Storybook build (the bundle) to the server once, and let the server render every story in its own browsers, the same way it compares them now. The runner does one build and one upload, then waits for the result.

This note is the design. It does not change the diff engine or the review UI.

## 1. What is sent

The CLI sends the static Storybook output (the directory `build-storybook` writes, which contains `index.json` and the bundle) for one commit and one subproject. It does not send PNGs in this mode.

- Packed as one archive (tar, gzip), so one request carries it. The size is an open measurement; see section 7.
- Sent with the same build the client-capture path opens: `POST /api/v1/builds`, with a new field that says the build renders from a bundle. Commit, branch, merge base, PR number and brief are unchanged.
- Stored under the org's blob prefix, next to the shots, and kept for the same retention as the build.
- The CLI reads `index.json` locally before it sends anything. It fails early, naming the problem, when the index is missing or has no stories. The plan (which stories, globals, variants) is still resolved from `pixelslash.config`, as it is today. The bundle carries no PixelSlash config.

Nothing leaves the machine except to the server the project is configured for, as today. A bundle is code, though: see section 6 on what it may contain.

## 2. What renders it

**The renderer runs the code the CLI already has.** A render job is `pixelslash capture` against the bundle served from a loopback static server on the renderer. The story list, the globals and variants, the `pixelslash-once` and flaky tags, the settle wait, the story crop, the preview-page reuse and the fresh-page re-shot all come from the existing `storybook` path in `packages/engine`. No second renderer is written. The thing that changes is where the job runs and where its shots go.

**The renderer is the pinned capture image** (`docker/capture/Dockerfile`: fixed Bun, Playwright, Chromium and the font set). Shots it renders carry the same fingerprint a client capture in that image carries. Section 5 is the reason this matters.

**Parallelism** is the config's `concurrency`, which the renderer already honours, with the preview pool keeping pages open per worker.

## 3. Where it runs

**Decided by the maintainer: the render worker runs in the web app's container.** The earlier recommendation was a separate, unprivileged container. The reasons for it still hold, and the risks of the chosen option are below.

Risks of the chosen option:

- The browsers are heavy. The web app's container is sized for workerd and the diff worker, and it already runs close to its memory limits (see `docs/rust-upload-service.md`). Sizing has to be measured before a build.
- The bundle is untrusted code: JavaScript from a pull request, executed in Chromium. It would share a process tree, a filesystem and secrets with the web app unless the isolation below is enforced inside that container.
- Render load can slow the review app and the diff, since they share the container.

The render worker, in the web app's container, must still:

- runs as a non-root user, unprivileged container, Chromium sandbox on (no `--no-sandbox`);
- holds no long-lived secret. It receives one build-scoped job token per build, valid until that build finalises or times out;
- has an egress rule that allows only the web app's API address and nothing else (a bundle does not need the internet; a story that fetches a live URL fails, as it does on a developer machine with no network);
- keeps each bundle in a per-job directory on a scratch disk, mounted read-only for the browser, and removes it when the job ends, whatever the outcome.

Sizing is not decided. The estimate in section 7 suggests a starting point of 12 vCPU and 16 GiB, to be measured, not assumed.

Production (the hosted app) needs a renderer too. Decided by the maintainer (section 9, item 4): the render worker runs in a container beside the Cloudflare Worker, the same image as LAN, and the Worker hands it bundle jobs over HTTPS.

## 4. The job flow

Everything the renderer does goes through the existing upload API, so nothing new writes the database.

1. CLI: `POST /api/v1/builds` with `render: "bundle"`. The project's subproject must have its diff location at `server`. A `ci` project refuses bundle mode with a clear message, because the runner would have to diff, which is the work this moves away.
2. CLI: uploads the bundle archive to the build (new endpoint, `PUT /api/v1/builds/:id/bundle`), then finalises with `{ render: true }` instead of a snapshot count.
3. Server: stores the bundle, queues one render job for the build, and returns the job token to the render worker. The token is scoped to that build and to the snapshot endpoints it needs.
4. Render worker: pulls the bundle, serves it on loopback, runs the capture against it, and uploads each shot with the existing `PUT` or `batch` snapshot endpoints. It then calls finalize. The server diffs as it does for any `server` project.
5. CLI: `--wait` polls the build as it does today. The check status on the PR is the build's status, unchanged.

If the render worker fails part-way, the build ends `errored`, naming the stories that did not render, through the same path a capture failure takes today.

## 5. Fingerprint and baselines

A baseline is only comparable with a shot from the same setup. The fingerprint (`docs/concepts/fingerprints.md`) records the image, the browser build and the font hash.

- A render worker on the same pinned image digest produces the same fingerprint as a client capture on that image. Its baselines and its shots match.
- A client capture on a runner that does not use the pinned image (for example, the runner's own Chromium) will not match. **This is the main risk.** Before a consumer switches, its current baselines must be checked against a render from the worker. The check is part of the done list below.
- The first build after a switch is compared against the old client baselines. If the fingerprint differs, every shot is "a shot from a different setup", not a change. The migration must either re-accept the baseline set on the first bundle build, or keep the switch behind a check that proves the pixels match first.

## 6. Security and privacy

- **Bundle contents.** A Storybook build can contain values the app's build step baked in: an environment variable, an API base URL, a token by mistake. The archive goes to the configured server and is stored there. Decided by the maintainer: when the CLI sees an obvious secret pattern, it prints a warning naming the match and uploads anyway. The docs say plainly that the bundle is stored.
- **Untrusted code.** The renderer runs it under the restrictions in section 3. A bundle from a fork pull request is never rendered: a fork's pull request gets no token, as today.
- **Pixels.** Shots are rendered and stored on the server, which already holds them in bundle-less mode. The AI judge's rules do not change (the judge sends crops only, and only to the endpoint the project names).
- **Logs.** The renderer's logs carry story ids and error messages, not bundle contents or tokens. Sentry, if used on the renderer, gets the scrubbed error reports already defined by `scrubEvent`.

## 7. Time budget

The target is a visual job under 3 minutes wall time, measured on the consumer's PR. These are estimates from the numbers above, to be replaced by measurement:

- Build: about 10 s (measured).
- Bundle upload: depends on the compressed size (unmeasured).
- Render: 2428 stories at about 0.57 lane-seconds each (11.6 min over 2 lanes) is about 1390 lane-seconds. In 150 seconds that needs about 9 concurrent shots at today's per-shot cost. Preview-page reuse should make the real number lower.
- Diff: the existing measurement is 0.28 s per shot, one at a time, for a 1280x9500 shot (`docs/rust-upload-service.md`). Story shots are cropped and are usually smaller, so this is an upper bound. Even so, 2428 serial diffs is far too long to wait for at finalise. **Decided by the maintainer: the diff runs as each shot arrives, not at finalise.** That change is in the diff path and in the server; it is not part of this note's build, and it depends on the same decision as the Rust upload service.
- Finalise and the check status: small.

Until the diff overlaps the render, expect the wall time to be bound by the diff, not the browsers.

## 8. Compatibility

- Client capture is unchanged and stays the default. A subproject switches to bundle mode by its own setting (server) and by the consumer's `upload` config. A repo that does not switch sees no change.
- Exit codes keep their meaning (`docs/cli.md`, "Exit codes"): a new change on Branch exits 1, a run that failed exits 1 and a crash exits 7. A render failure is a run failure.
- `/api/v1` is in alpha, so the new fields and endpoints are added without a version prefix. The commit that adds them is marked with `!` only if it breaks an existing client.

## 9. Decisions and open questions

Decided by the maintainer:

1. Render worker runs in the web app's container (section 3).
2. Bundle secrets: warn and continue (section 6).
3. The diff runs as each shot arrives (section 7).

Decided by the maintainer:

4. Production renderer host: production runs the render worker in the web app's container, the same as LAN. The hosted app is a Cloudflare Worker, which cannot run Chromium, so the container is a separate host beside it that the Worker hands bundle jobs to over HTTPS. The container's host and sizing are still to be chosen and measured.

## 10. Done list for the build (after approval)

- [ ] The bundle archive is accepted, stored and expires with its build; a bundle without `index.json` is refused with a named reason.
- [ ] The renderer serves a bundle and captures it with the same code and the same pinned image as client capture.
- [ ] A consumer's PR build shows the same shots as client capture, with no false diffs against main.
- [ ] The visual job's wall time is under 3 minutes on that PR, measured.
- [ ] Client capture still works for a repo that does not switch.
- [ ] The renderer's egress and sandbox settings are checked on the worker (no route except the API, Chromium sandbox on).
