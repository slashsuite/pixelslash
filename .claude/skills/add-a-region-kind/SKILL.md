---
name: add-a-region-kind
description: Add a new region kind to the PixelSlash diff (beside change, noise, shift and moved) without making any shot or bench score worse. Use when a class of changed pixels should get its own label, when a diff calls something a change that is not one, or when asked to add a diff label or classifier.
---

# Add a region kind

The diff labels every region it finds with a `RegionKind` (`packages/engine/src/regions.ts`):
`change`, `noise`, `shift` or `moved`. Only `change` (and `moved`, through the floors) makes a
shot changed. A new kind takes pixels away from `change`, so the risk is always the same: a
real edit gets relabelled and stops being reported. The work is to prove it does not.

The template is the `moved` kind (commit `1931cbd`, "report blocks that moved intact as a moved
region"). Read its diff before you start: it touches every place a kind has to go.

## 1. Write the rule first

Put the rule at the top of the new module, as `shift.ts` and `moved.ts` do: a numbered list
of conditions that must ALL hold, each constant named and explained, and the rule's known
edge stated plainly. If you cannot write the rule down, you cannot defend it in review.

- The rule must leave a real edit alone. Name the edit that looks most like your kind (a 1px
  spacing change against a sub-pixel shift; a copied icon against a moved one) and say which
  condition rejects it.
- Give it an off switch when a project may want the old behaviour, the way `maxShift: 0`
  turns shift labelling off.

## 2. Hook it into `measure()`

The pipeline is `measure()` in `packages/engine/src/measured.ts`, all in TypeScript after
the WASM pixel loop: `findRegions` (blobs into regions), `labelRegions` (`labelShifts`,
skipped when the sizes differ), `findMoves`, then `clearsFloors`. Relabel only `change`
regions and keep the order; a region another pass already labelled keeps its label. Do not
move the rule into Rust: `engines/wasm` does only the hot loops (decode, the pixel loop,
blobs, the overlay). If a pass rewrites the field or the overlay (as `findMoves` does),
`bun run wasm:check` still has to pass, since it rebuilds the committed `diff.wasm`.

## 3. Wire the kind everywhere it is read

`rg -n '"moved"'` across `packages`, `apps/web/src` and `bench` lists the places. At the
time of writing they are:

- Engine: `regions.ts` (`RegionKind`), `summary.ts`, `report.ts`, `report-crop.ts`,
  `change-note.ts`, `flake.ts` (which kinds make a re-capture differ), `flake-repro.ts`
  (`CAUSE_WORDS` and the cause order), `diff-wasm.ts`.
- Web: `src/db/diff-json.ts` (`RegionKind`), `src/api/validate.ts` (`REGION_KINDS`, and
  `DIFF_KINDS` for an option), `ci-result.ts`, `api/read.ts`, `ai/explain.ts`,
  `ai/summary.ts`, `github/pr-comment.ts`, the snapshot overlay, frame (its colour), side
  panel and shot card, `lib/region-counts.ts`, `lib/viewer-bases.tsx`,
  `lib/branch-review.ts`, `db/open-shots.ts`.
- An option: `diff-options.ts` (`RULES`, the default, the label), the CLI's `DIFF_FLAGS` and
  usage text in `packages/cli/src/args.ts`, `apps/web/src/components/diff-options-list.tsx`,
  and the diff keys in `docs/cli.md`.

A new kind changes what `/api/v1` returns, so the commit subject carries `!`
(`feat(engine)!: ...`).

## 4. Prove it does not regress

Each step is a test or a number, not a judgement:

1. Unit tests in `packages/engine/test/` for each condition of the rule: one shot pair it
   relabels, and one near miss per condition that stays `change`. Build the pairs in code;
   do not commit new PNGs for a unit test.
2. A bench guard. Add a small generated corpus for the kind (as `bench/moves` is for
   `moved`) that `bench:check` runs, so the label cannot silently stop working.
3. The main and held-out corpora: `bun run bench -- --no-argos` while you iterate, then
   `bun run bench` and `bun run bench:check`. No score may get worse. Tune the constants on
   the main corpus only; the held-out set (`bench/src/generate.ts --set holdout`) is what
   tells you the tuning did not overfit. If a score moves on purpose, commit a new
   `bench/results/<date>.json` in the same change.
4. A real run, looked at: `bun run pixelslash -- --live-png main.png --local-png branch.png
   --out .pixelslash` on a pair that shows the kind, then open `report.html` and check the
   region box, its colour and its words.
5. The full gate from `AGENTS.md`, and the web gate because `apps/web` changed.

## 5. Say it in the docs

In the same change: the "How the diff works" sections of `docs/cli.md`, `FACTS.md` (and
its "Checked against" line), `FEATURES.md`, `bench/README.md` for the new guard, and our
row in `docs/capabilities/data.json` with `python3 docs/capabilities/build.py` re-run.
