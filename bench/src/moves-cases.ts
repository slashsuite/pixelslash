/**
 * The moved-block pairs (`bun bench/src/generate.ts --set moves`): a gap that grows, on a full page
 * and in a fixed viewport, and a header item pushed sideways. Each is `real` with the move it holds;
 * `moves.ts` checks that the engine reports that move as a `moved` region and paints only what the
 * block left behind.
 */
import type { CaseDef } from "./case-kit.ts";

const gap = (name: string, fullPage: boolean): CaseDef => ({
  name,
  label: "real",
  kind: "moved",
  page: "dashboard",
  fullPage,
  base: {},
  // 16 px to 20 px: the activity card and everything below it move down 4 px.
  head: { css: "#activity { margin-top: 20px; }" },
  box: ["#activity"],
  move: { dx: 0, dy: 4 },
});

export const MOVE_CASES: CaseDef[] = [
  gap("moved-gap-4px-fullpage", true),
  gap("moved-gap-4px", false),
  {
    name: "moved-header-right-12px",
    label: "real",
    kind: "moved",
    page: "dashboard",
    base: {},
    // The logo and the nav after it move right 12 px; the avatar stays at the right edge.
    head: { css: "#logo { margin-left: 12px; }" },
    box: ["#logo", "nav"],
    move: { dx: 12, dy: 0 },
  },
];
