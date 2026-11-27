---
name: diagnose-a-flaky-shot
description: Decide whether a changed region in a PixelSlash run is a real change or a capture flake, and fix the flake at its cause. Use when a shot changed but nobody touched it, when a build shows a flaky badge, when two captures of the same page disagree, or when asked to diagnose or fix a flaky shot.
---

# Diagnose a flaky shot

A shot is flaky when the same page, captured again, gives different pixels. That says
nothing about whether a change is wanted; it says the captures disagree. Find out which it is
before you touch a threshold.

## 1. Read what the diff already called it

Each region has a kind, and the report and the shot page show it:

- `change`: pixels that really differ. Real until proven otherwise.
- `shift`: the content moved a fraction of a pixel, all alike (a sub-pixel phase). Not a change.
- `moved`: a block moved by whole pixels with its content intact. What is left red beside it
  (the strip it vacated) is the real change.
- `noise`: low-amplitude speckle below the floors.

If only `shift`, `moved` or `noise` regions are left, the shot is not changed and there is
nothing to fix. If a shot was uploaded with `--upload`, its changed shots were already
captured again (`--flake-retries`, default 2): a shot whose re-captures agreed is a real
change; one whose re-captures disagreed is badged flaky, with its runs side by side.

## 2. Reproduce it on this machine

```sh
pixelslash flakes                 # the project's open flaky shots, with their ids
pixelslash flake <id> --runs 10   # capture that shot locally, diff each run against run 1
```

`baseUrl` must already be up (no dev server is started, except the config's own `start`
command). Each run's regions are named `real change`, `sub-pixel shift`, `moved block`,
`noise` or `size change`, and the run ends `stable` or `unstable: X of N-1 runs differed`.

- Stable here but flaky in CI: the difference is the machine (fonts, image, load). Compare
  the capture image and font set before changing the page.
- Unstable here: you have a reproduction. Look at the regions in the run's `report.html` and
  find what in the page draws there.

## 3. Fix the cause, most specific first

`pixelslash flake` prints the suggestions in this order; take the first that fits.

1. **Media.** A `<video>` or `<audio>` renders unreliably. Capture warns with its box
   (`warning: <video> at x,y WxH on <route> ...`); add that rect to the route's `ignore`, or
   `data-pixelslash-ignore` on the element in a story.
2. **A page size that moves.** Content that loads late and pushes the page longer. Make the
   page reserve its space, or wait for the content with an action.
3. **Stabilisation the config turned off.** `stabilise` freezes animations, the caret, the
   clock (`clock`) and page timers (`timers`) by default. Turn back on what was turned off.
   A page that needs a delayed timer to render takes an `advance` action, not `timers: false`.
4. **A region that always changes** (live data, an ad, a map): an `ignore` area for it, in
   CSS px, on that route or variant. Use `masks` only for content that must not leave the
   machine.
5. **Last:** `"flaky": "skip"` on the route (or the `pixelslash-flaky-skip` tag on a
   story), so its changes stop blocking builds. It hides the shot from review; say why.

`pixelslash flake <id> --suggest` prints each config change as the line it would set;
`--write` writes the one you pick (JSON configs only).

## 4. Prove the fix holds

Run `pixelslash flake <id> --runs 10` again and get `stable`. Then resolve it with
`pixelslash flake <id> --resolve --note "<the cause>"`: it reproduces the shot once more and
resolves it on the server only when every run was the same. Do not raise `threshold`,
`minChangedPixels` or `--flake-retries` to make a flake go away: that hides real changes
on every shot it applies to.
