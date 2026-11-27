// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { buildView } from "#/db/review";
import { context, FINGERPRINT, sha, upload, type Shot } from "#/diff/test-builds";
import { must } from "#/test/must";
import { shot } from "#/diff/test-shots";
import { keyValues } from "#/test/key-values";
import { render, screen } from "#/test/render";
import { snapshotView } from "#/test/snapshot-view";
import { SidePanel } from "./snapshot-side-panel";

// happy-dom's URL cannot find the engine's diff.wasm; the diff runs here (`#/test/diff-module`).
vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));

/** The "Captured in" panel of a shot's review page, for a web shot and for a native one. */

const png = shot({ width: 120, height: 240 });

const android: Shot = {
  name: "login",
  png,
  renderer: { platform: "android", browser: "Pixel 8 API 35" },
  fingerprint: { ...FINGERPRINT, platform: "android", device: "Pixel 8 API 35", scale: "3" },
};

/** Uploads `shotSpec` to main, opens its review panel's Details, and returns what they list. */
async function capturedIn(shotSpec: Shot, platform: string) {
  const ctx = await context();
  const build = await upload(ctx, { branch: "main", commit: sha(1), shots: [shotSpec] });
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  const snapshot = must(
    view.snapshots.find((s) => s.platform === platform),
    `a ${platform} shot`,
  );
  const { user } = await render(
    <SidePanel
      projectId={ctx.projectId}
      buildId={build.id}
      snapshot={snapshot}
      options={{}}
      reviewable
      status={build.status}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByRole("heading", { name: "Captured in" })).toBeTruthy();
  return keyValues();
}

describe("Captured in", () => {
  test("a native shot names its platform, its device and the scale, and no browser", async () => {
    const facts = await capturedIn(android, "android");
    expect(facts).toMatchObject({ Platform: "android", Device: "Pixel 8 API 35", Scale: "3×" });
    expect(facts).not.toHaveProperty("Browser");
  });

  test("a web shot names its browser and has no device or scale", async () => {
    const facts = await capturedIn({ png }, "linux");
    expect(facts).toMatchObject({ Platform: "linux", Browser: "chromium" });
    expect(facts).not.toHaveProperty("Device");
    expect(facts).not.toHaveProperty("Scale");
  });
});

const approvedEarlier = (mainChangedSince: boolean) =>
  render(
    <SidePanel
      projectId="p1"
      buildId="b1"
      snapshot={snapshotView({
        diffStatus: "unchanged",
        reviewState: "accepted",
        approvedEarlier: {
          snapshotId: "s0",
          buildId: "b0",
          commitSha: "61f0c17000000000000000000000000000000000",
          reviewedBy: "ada",
          reviewedAt: new Date(0),
          defaultBranch: "main",
          mainChangedSince,
        },
      })}
      options={{}}
      reviewable
      status="passed"
    />,
  );

describe("Approved earlier", () => {
  test("says main has changed since that approval when it has", async () => {
    await approvedEarlier(true);
    expect(screen.getByRole("heading", { name: "Approved earlier" })).toBeTruthy();
    expect(
      screen.getByText(
        /main has changed since that approval, so it was given against an older main/,
      ),
    ).toBeTruthy();
  });

  test("says nothing about main moving when it has not", async () => {
    await approvedEarlier(false);
    expect(screen.getByText(/this shot still differs from main\./)).toBeTruthy();
    expect(screen.queryByText(/has changed since that approval/)).toBeNull();
  });
});
