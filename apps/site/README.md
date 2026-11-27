# apps/site

Not a project: the files slashslash.build/pixelslash reads from this repo by path, at a pinned commit.
The docs site that used to live here is gone; its pages are on slashslash.build, and pixelslash.dev
answers its old paths with a 301 (`apps/web/src/server/moved.ts`).

- `public/hero/main.png`, `public/hero/branch.png` and `src/content/hero.json`: the homepage demo, shot
  by `scripts/site-images/hero.ts` from `scripts/site-images/page.html`.
- `public/report.png` and `src/content/report.json`: the review app's compare view, shot by
  `scripts/site-images/report.ts`.
- `public/docs-images/*.png`: the screenshots the docs under `docs/` link to.
- `public/favicon.svg` and `public/fonts/`: the icon and the Inter font with its licence.

`.github/workflows/site-images.yml` reruns `scripts/site-images/site-images.ts` on `main` and opens a pull
request when a hero or report image really changed. Do not move, rename or delete a file here: that
breaks the other site's next update.
