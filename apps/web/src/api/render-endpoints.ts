import { type Endpoint, onBuild } from "./endpoint";
import { getBundle, getRenderPlan, putBundle, renderError } from "./render";

/**
 * A bundle build's own endpoints (`docs/storybook-bundle-render.md`): the CLI sends the bundle,
 * the renderer fetches it and its plan, and reports a render that failed. Its finalise is the
 * build's finalise (`closeBuild`).
 */
export const RENDER_ENDPOINTS: readonly Endpoint[] = [
  { method: "PUT", path: "/api/v1/builds/:id/bundle", upload: true, run: onBuild(putBundle) },
  { method: "GET", path: "/api/v1/builds/:id/bundle", upload: true, run: onBuild(getBundle) },
  {
    method: "GET",
    path: "/api/v1/builds/:id/render",
    upload: true,
    run: onBuild(async (_ctx, build) => getRenderPlan(build)),
  },
  {
    method: "POST",
    path: "/api/v1/builds/:id/render-error",
    upload: true,
    run: onBuild(renderError),
  },
];
