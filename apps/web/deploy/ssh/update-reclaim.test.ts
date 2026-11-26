import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, deploy, pack, setup } from "./update-harness";

afterEach(cleanup);

describe("update.sh frees the old checkout's disk", () => {
  test("its installed packages and Miniflare's trace store go; the D1 and R2 state stay", () => {
    const s = setup();
    const checkout = join(s.home, "pixelslash");
    const trash = [
      join(checkout, "node_modules"),
      join(s.legacyWeb, "node_modules"),
      join(checkout, "packages/engine/node_modules"),
      join(s.legacyWeb, ".wrangler/state/v3/observability"),
    ];
    for (const dir of trash) {
      mkdirSync(join(dir, "pkg"), { recursive: true });
      writeFileSync(join(dir, "pkg/index.js"), "x\n");
    }
    const { status, stderr } = deploy(s, pack("aaaaaaa"));
    expect({ status, stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    for (const dir of trash) {
      expect({ dir, there: existsSync(dir) }).toEqual({ dir, there: false });
      expect(stderr).toContain(`removing ${dir}`);
    }
    expect(readFileSync(join(s.legacyWeb, ".wrangler/state/v3/builds"), "utf8")).toBe(
      "42 builds\n",
    );
    expect(readFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "utf8")).toContain("ct-secret");
    // The release serves from its own install, which is not the old checkout's.
    expect(existsSync(join(s.releases, "aaaaaaa"))).toBe(true);
  });
});
