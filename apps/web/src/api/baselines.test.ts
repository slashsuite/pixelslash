import { createHash } from "node:crypto";
import type { BaselinePick } from "@slashsuite/pixelslash-engine/ci-diff";
import { describe, expect, test } from "vitest";
import { createProject, diffLocationOf } from "#/db/orgs";
import { builds } from "#/db/schema";
import { KEY, META, branch, ciProject, noDiff, run } from "#/diff/test-ci";
import { sha } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { serveSignedImage } from "#/storage/serve-image";
import { call, idOf, setup } from "./test-support";

/** `POST /api/v1/builds/:id/baselines` and its preview, and where a new project diffs (ob 1727). */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

describe("the baselines endpoints", () => {
  test("the preview creates nothing and picks what the build would", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const before = await held.db.select().from(builds);
    const preview = await call(
      deps,
      "POST /api/v1/baselines",
      held.acme.token,
      JSON.stringify({
        commitSha: sha(2),
        branch: "feat/x",
        mergeBaseSha: sha(1),
        keys: [{ ...KEY, theme: "light" }],
      }),
    );
    expect(preview.status).toBe(200);
    const body: { diff_location: string; baselines: BaselinePick[]; removed: unknown[] } =
      await preview.json();
    expect(body.diff_location).toBe("ci");
    expect(body.removed).toEqual([]);
    expect(await held.db.select().from(builds)).toEqual(before);

    const built = await run(held, held.acme.token, branch(2, red), deps);
    expect(body.baselines[0]?.baseline?.id).toBe(built.pick.baseline?.id);
    expect(body.baselines[0]?.baseline?.fingerprint).toEqual(META.fingerprint);
    // The pick carries the baseline PNG's hash, so a CLI with the same bytes need not fetch it.
    expect(body.baselines[0]?.baseline?.sha256).toBe(
      createHash("sha256").update(white).digest("hex"),
    );
  });

  test("the preview names the baseline build's shots no key asked about as removed", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const ask = (keys: object[]) =>
      call(
        deps,
        "POST /api/v1/baselines",
        held.acme.token,
        JSON.stringify({ commitSha: sha(2), branch: "feat/x", mergeBaseSha: sha(1), keys }),
      );
    const asked = await ask([{ ...KEY, name: "other", theme: "light" }]);
    const reply: { removed: unknown[] } = await asked.json();
    expect(reply.removed).toEqual([{ ...KEY, theme: "light" }]);
  });

  test("a branch's second upload can fetch its own earlier build's images long after it asked", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    // The branch's first build: main has none, so it has no baseline and fetches nothing.
    const first = await run(
      held,
      held.acme.token,
      { branch: "feat/x", commit: sha(1), png: white },
      deps,
    );
    expect(first.pick.baseline).toBeNull();

    // The next push opens a build and asks for every pick at once, as `pixelslash upload` does.
    const opened = await call(
      deps,
      "POST /api/v1/builds",
      held.acme.token,
      JSON.stringify({ commitSha: sha(2), branch: "feat/x", clientDiff: true }),
    );
    const asked = await call(
      deps,
      `POST /api/v1/builds/${await idOf(opened)}/baselines`,
      held.acme.token,
      JSON.stringify({ keys: [{ ...KEY, theme: "light" }] }),
    );
    const { baselines }: { baselines: BaselinePick[] } = await asked.json();
    const named = baselines.flatMap((b) => [b.baseline, b.accepted]).filter((p) => p !== null);
    expect(named.map((p) => p.id)).toEqual([first.row.id]);

    // It reaches a shot's baseline only when it gets to that shot: here half an hour in, as for a
    // build of a few thousand shots. Every image the reply named is still served.
    const later = Date.now() + 30 * 60 * 1000;
    for (const p of named) {
      const got = await serveSignedImage(new URL(p.image_url), {
        secret: deps.imageSecret(),
        store: held.blobs.store,
        now: later,
      });
      expect({ url: p.image_url, status: got.status }).toEqual({ url: p.image_url, status: 200 });
      expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(white))).toBe(true);
    }
  });

  test("another org's build is a 404 and a bad key is a 400", async () => {
    const held = await ciProject();
    const started = await call(
      held.deps,
      "POST /api/v1/builds",
      held.acme.token,
      JSON.stringify({ commitSha: sha(1), branch: "main", clientDiff: true }),
    );
    const id = await idOf(started);
    const keys = JSON.stringify({ keys: [{ ...KEY, theme: "light" }] });
    const foreign = await call(
      held.deps,
      `POST /api/v1/builds/${id}/baselines`,
      held.other.token,
      keys,
    );
    expect(foreign.status).toBe(404);
    const bad = await call(
      held.deps,
      `POST /api/v1/builds/${id}/baselines`,
      held.acme.token,
      JSON.stringify({ keys: [{ ...KEY, theme: "sepia" }] }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("the default diff location", () => {
  test("a project made without one diffs on the server", async () => {
    const held = await setup();
    expect(held.acme.project.diffLocation).toBe("server");
    const made = await createProject(held.db, held.acme.user.id, held.acme.org.id, {
      name: "app",
      diffLocation: "ci",
    });
    expect(made.diffLocation).toBe("ci");
  });

  test("the hosted env names ci; anything else, or nothing, is server", () => {
    expect(diffLocationOf("ci")).toBe("ci");
    expect(diffLocationOf("server")).toBe("server");
    expect(diffLocationOf(undefined)).toBe("server");
    expect(diffLocationOf("CI")).toBe("server");
  });
});
