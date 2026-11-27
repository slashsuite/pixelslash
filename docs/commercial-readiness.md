# Commercial readiness

What the hosted review app (pixelslash.dev) still lacks before a first paying customer, read from the
code and config at commit `a1758162` on 2026-11-27. It has three parts: where the hosted product
still depends on the maintainer's own machines and accounts, what a paying customer expects and
whether it is here, and where the cost measurements are kept. It ends with an ordered critical path and
the decisions that only the maintainer can make.

Prices and cost figures are not in this file. Pricing stays private until the pricing page ships;
the measurements, the price lists and the proposal are in PS-780.

## 1. Dependencies on the maintainer's machines and accounts

"Customer-facing" means a paying customer would notice it failing. "Dev only" means it slows our
own work but no customer sees it.

| # | Dependency | Where it is | Who notices | Hosted replacement |
| --- | --- | --- | --- | --- |
| 1 | The Storybook bundle renderer runs only on a server on the maintainer's home network. Production has `RENDER_URL` empty, so a bundle upload to pixelslash.dev is refused with 409. | `apps/web/wrangler.jsonc` (production `RENDER_URL`), `apps/web/src/api/render.ts:71-72`, `apps/web/deploy/ssh/render-worker.ts`, `apps/web/deploy/ssh/pixelslash-render.service`, `docs/storybook-bundle-render.md:3,55,116` | Customer-facing | A container host that runs Chromium on demand (Cloudflare Containers, Fly Machines or Cloud Run) |
| 2 | The CI docs tell customers to pull the capture image from a personal registry namespace, while `image.yml` publishes it under the org. | `docs/ci/pin-versions.md:30,31,35,45,60`, `docs/ci/github-actions.md:55,118`, `docs/ci/gitlab.md:57`, `docs/ci/jenkins.md:57`, `docs/ci/circleci.md:57`, `docs/ci/any-ci.md:59`; `.github/workflows/image.yml:4,20` | Customer-facing | No new service: point the docs at the org image |
| 3 | Production deploys run by hand from the maintainer's shell; CI only dry-runs them. | `apps/web/README.md:446-500`, `.github/workflows/ci.yml:226-233` | Customer-facing (a fix waits on one person) | A deploy workflow on a protected GitHub environment |
| 4 | The Cloudflare account that holds the Worker, D1, R2, the queue and the pixelslash.dev zone is a personal account. | `apps/web/wrangler.jsonc:118` (route), the production bindings in the same file | Customer-facing (billing, access, bus factor) | A Cloudflare account owned by the business, the resources moved or recreated there |
| 5 | The GitHub App "PixelSlash Review" may be owned by a personal account and set to private. | `apps/web/github-app/manifest.json:5-6`, `apps/web/github-app/README.md:65-73,94-95` | Customer-facing (a private app cannot be installed on a customer org) | The app registered under the org and made public |
| 6 | Which Sentry account the DSN points at is not recorded in the repo. | `apps/web/wrangler.jsonc:67-69`, `packages/cli/src/sentry.ts` | Customer-facing when an error goes unseen | A Sentry organisation owned by the business |
| 7 | The storage size alert posts to `PIXELSLASH_ALERT_WEBHOOK_URL`, a secret; the repo does not record whether production sets it, or where it goes. | `apps/web/src/lib/size-alert.ts:6`, `apps/web/README.md:241-246`, `apps/web/wrangler.jsonc:101-102` | Customer-facing (the database fills with no warning) | A webhook to a monitored channel |
| 8 | The security and conduct contact is an address on another of the maintainer's domains. | `SECURITY.md:7`, `CODE_OF_CONDUCT.md:39` | Customer-facing | An address on the product's own domain |
| 9 | The docs site the app links to, slashslash.build, is built from another repo and reads files from this one by path. | `AGENTS.md` ("Files another site reads by path"), `apps/web/src/server/moved.ts` | Customer-facing | Already hosted; its ownership moves with the Cloudflare account |
| 10 | The self-host on the maintainer's home network: release, update and watchdog scripts. | `apps/web/deploy/ssh/release.sh`, `update.sh`, `watchdog.sh`, `apps/web/README.md:547-600` | Dev only, once the renderer moves (row 1) | Retire it as a production path, or keep it as a staging host |
| 11 | The `visual` job uploads our dogfood shots to pixelslash.dev. | `.github/workflows/ci.yml:281-330` | Dev only | None: it is our own usage of the product |
| 12 | The `ui-review` workflow uses a model key whose owner the repo does not record, and a reusable workflow pinned to `@main`. | `.github/workflows/ui-review.yml:34,47` | Dev only | An org-owned key, and the workflow pinned to a commit |
| 13 | `SITE_IMAGES_TOKEN` is a personal access token. | `.github/workflows/site-images.yml:6-11,65` | Dev only | A GitHub App installation token |
| 14 | The moon remote cache is served from a domain of the maintainer's. | `.moon/workspace.yml:28-34`, `.github/workflows/ci.yml:43,49,163,166,244,247` | Dev only | A cache server on R2, or a hosted cache |
| 15 | The Argos bench VM. | `ops/argos-bench/`, `bench/src/argos.ts` | Dev only (`--refresh-argos` only) | None needed |
| 16 | The `apps/web/perf` tools run on the maintainer's desktop. | `apps/web/perf/` | Dev only | None needed |
| 17 | npm publishing uses OIDC, but the first publish of a new package needs a token and the maintainer's second factor. | `.github/workflows/release.yml:7-16,140,165` | Dev only | An npm org with a second owner |

Checked and not a dependency:

- The design-system judge runs on the customer's own machine, from their PATH
  (`packages/engine/src/judge.ts:4-7,38-46`).
- The AI explain and summary calls use the model each project or org configures: the customer
  brings the endpoint and pays for the tokens (`apps/web/src/ai/model.ts:13`,
  `projectModelFor`, `apps/web/src/db/models.ts:54`).
- The CLI has no default server; it uploads only where it is told (`packages/cli/src/remote.ts:45-53`).
- No CI job runs on a runner of our own; `scripts/check-workflows.ts` refuses one.

## 2. What a paying customer needs

| Need | State | Evidence |
| --- | --- | --- |
| Billing | Missing | No payment code anywhere; the only match for "stripe" is a colour helper (`apps/web/src/components/build-mix.tsx:48`). The capability matrix says "no plan, billing or quota" (`docs/capabilities/data.json:714`). |
| Plan limits | Partial | `usageCounts()` (`apps/web/src/db/usage.ts:11-33`) counts shots for the whole deployment, and nothing outside tests calls it. No per-org cap on projects, builds or shots (`createOrg`, `apps/web/src/db/orgs.ts:24`; `createProject`, `:262`). Retention is configurable but empty in production (`apps/web/wrangler.jsonc`). |
| Self-serve sign-up | Present | GitHub and Google sign-in (`apps/web/src/routes/index.tsx:23-27`, `apps/web/src/auth/sign-in-github.ts:68-77`), new org and project (`apps/web/src/server/fns.ts:90,98`), upload tokens per project, org and person (`fns.ts:157`, `org-token-fns.ts:8`, `apps/web/src/server/account.ts:25`), and an onboarding page for an empty org (`apps/web/src/components/org-empty.tsx:4-34`). |
| Legal pages (terms, privacy, data processing) | Missing | No route serves one, and `apps/site` holds only assets. The nearest text is `docs/help/faq.md:5-17`. The old `/pricing` and `/security` paths redirect to slashslash.build (`apps/web/README.md:542-545`). |
| Support | Partial | `SECURITY.md:5-12` and `docs/help/` cover the CLI. The app has no help or contact link (`apps/web/src/components/shell.tsx:90`). |
| Status and uptime | Partial | A smoke suite checks a deploy when someone runs it (`apps/web/smoke/web.smoke.ts:31-58`); nothing runs it on a schedule. No status page, no uptime monitor, no public health endpoint. The operator health page `/_admin` exists but no admin is set in production (`apps/web/wrangler.jsonc:181`). A storage alert fires at 70% of the database cap, to a webhook the repo cannot show is set (row 7 above). |
| Backups | Missing | No export or restore runbook, and no use of D1 point-in-time restore is documented. Retention deletes are permanent (`apps/web/README.md:234`). |
| Abuse limits | Partial | Per-token API and sign-in rate limits on Cloudflare (`API_RATE_LIMIT`, `SIGNIN_RATE_LIMIT` in `apps/web/wrangler.jsonc`); a self-host has none (`SECURITY.md:90-92`). Size caps on a PNG, a metrics file, a Storybook bundle and a brief (`apps/web/src/api/snapshot-form.ts:22,36,67-68`, `apps/web/src/api/render.ts:36`, `apps/web/src/api/validate-brief.ts:9-10`). Model endpoints on private addresses are refused (`apps/web/src/ai/model-host.ts`). No cap on shots per build, builds per day or storage per org. |
| Account and org deletion, data export | Missing | No delete path for an org or an account. The only export is the diff overrides and ignore boxes (`apps/web/src/db/override-export.ts:56`). |
| Members and roles | Present | Invites exist (`apps/web/src/db/invites.ts`). A member is an owner or a member (`MEMBER_ROLES`, `apps/web/src/db/schema.ts`); only an owner removes a member, changes a role, issues or revokes an org token and sets the org's model (`requireOwner`, `apps/web/src/db/members.ts`), and an org always keeps an owner. |
| Single sign-on | Missing | Only GitHub and Google. `apps/web/SELF-HOST.md:29` suggests Cloudflare Access for a self-host. |
| Audit log | Partial | Only diff overrides and ignore boxes keep a history of who changed what (`apps/web/src/db/schema-overrides.ts:35-66`); a build records who reviewed it, and a flag who set it. |

## 3. Cost

Our cost per shot and per AI-reviewed shot was measured from real usage, production's analytics and
the token counts each AI review stores (`apps/web/src/ai/usage.ts`). The measurements, every cost
figure and the price lists are private: they are in PS-780.

One limit is not a price and belongs here: D1 caps a database at 10 GB, so retention (already in the
code, empty in production) or a database per tenant is needed before a large customer, not after.

## 4. Critical path

In order. Each item is a draft ticket for the maintainer to open or drop; none is opened.

1. **Move the product to accounts the business owns.** A Cloudflare account for the Worker, D1, R2,
   the queue and the zone; the GitHub App under the org and public; Sentry; the contact address on
   the product's domain. (Rows 4, 5, 6, 8.)
2. **Point the CI docs at the org's capture image.** A docs change, no new service. (Row 2.)
3. **Deploy from CI.** A deploy workflow on a protected environment, so a fix ships without the
   maintainer's shell. (Row 3.)
4. **Backups and restore.** Turn on and document D1 point-in-time restore, a scheduled export of D1
   to R2, and a tested restore. (Section 2, Backups.)
5. **Monitoring.** A scheduled smoke against pixelslash.dev, an uptime check, a status page, and a
   destination for the storage alert. (Section 2, Status; row 7.)
6. **Legal pages.** Terms, privacy policy and a data processing addendum, linked from the app and
   the site. They must match invariant 4 in `AGENTS.md` (what leaves the customer's machine).
7. **Plans and limits in the app.** A plan on each org; usage counted per org and per month;
   caps on shots, changed shots and storage enforced at upload with a clear error; retention per
   plan.
8. **Billing.** Checkout, a customer portal, and the webhook that sets an org's plan, through the
   payment provider chosen below.
9. **Support.** A help and contact link in the app, and a stated response time per plan.
10. **Org deletion and data export.** Delete an org and its blobs; export its builds and decisions.
11. **The hosted renderer.** Storybook bundle uploads on pixelslash.dev, on a container host.
    (Row 1.) Needed before Storybook customers; the CLI capture works without it.
12. **A hosted AI review**, only if the AI add-on is sold: a model key the business pays for, a
    per-org meter and cap on AI-reviewed shots, and the customer's consent recorded.
13. **Roles and member removal.** An owner role that alone can bill, delete and remove members.
14. **Dev-only moves.** The site images token, the `ui-review` key and pin, the moon cache, the
    npm org. (Rows 12, 13, 14, 17.)

Single sign-on and a fuller audit log are for a business tier later; they are not on the path to
the first customer.

## 5. Decisions for the maintainer

These are the maintainer's to make. Each has a recommendation in PS-780, because a pricing plan is
commercial and this repo is public.

1. What are the tiers called?
2. What does a plan include: how many changed shots, and is anything else metered?
3. What are the rate limits and caps per plan: shots per build, builds per day, retention?
4. Is a hosted AI review sold as an add-on, and how is it priced against bring-your-own model?
5. Which payment provider: a merchant of record that handles sales tax and VAT, or a plain payment
   processor?
