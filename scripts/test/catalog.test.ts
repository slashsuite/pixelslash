import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// One version per dependency. Shared versions live in the root package.json: `catalog` for most,
// `catalogs.<name>` for a group that must move together (playwright, react, tailwind, tanstack). A
// package names them as `catalog:` or `catalog:<name>`; Dependabot bumps the catalog itself.

type Manifest = {
  workspaces?: string[];
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = join(import.meta.dirname, "../..");
function read(dir: string): Manifest {
  const manifest: Manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  return manifest;
}
const rootManifest = read(".");

const workspaceDirs = (rootManifest.workspaces ?? []).flatMap((pattern) =>
  pattern.endsWith("/*")
    ? [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })].map((f) =>
        f.replace(/\/package\.json$/, ""),
      )
    : [pattern],
);

// `npm pack` ships a published package's runtime `dependencies` as written, so those keep a plain
// version, which must equal the catalog's.
const PUBLISHED = new Set(["packages/cli", "packages/playwright"]);
// The UISlash kit packages are upgraded on their own; they stay out of the catalog for now.
const OWN_VERSION = new Set(["@slashsuite/themes", "@slashsuite/ui-react"]);
// The sample is installed with npm, outside the workspace, so it cannot read the catalog; what it
// shares with the workspace is at the catalog's version, except @types/node: it runs on Node 24.
const EXAMPLE = "examples/playwright-node";
const EXAMPLE_OWN = new Set(["@types/node"]);

function resolve(name: string, spec: string): string {
  if (spec === "catalog:") return rootManifest.catalog?.[name] ?? `missing from catalog`;
  if (spec.startsWith("catalog:")) {
    const group = spec.slice("catalog:".length);
    return rootManifest.catalogs?.[group]?.[name] ?? `missing from catalogs.${group}`;
  }
  return spec;
}

type Use = { dir: string; field: "dependencies" | "devDependencies"; spec: string };
const FIELDS = ["dependencies", "devDependencies"] as const;
const uses = new Map<string, Use[]>();
const allUses = [".", ...workspaceDirs].flatMap((dir) => {
  const manifest = read(dir);
  return FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, spec]) => ({
      name,
      use: { dir, field, spec },
    })),
  );
});
for (const { name, use } of allUses) {
  if (use.spec.startsWith("workspace:")) continue;
  uses.set(name, [...(uses.get(name) ?? []), use]);
}
const catalogVersion = (name: string): string | undefined =>
  rootManifest.catalog?.[name] ??
  Object.values(rootManifest.catalogs ?? {}).find((group) => name in group)?.[name];

describe("the dependency catalog", () => {
  test("every workspace dependency resolves to one version", () => {
    const split = [...uses]
      .map(([name, list]) => [name, new Set(list.map((u) => resolve(name, u.spec)))] as const)
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => `${name}: ${[...versions].join(", ")}`);
    expect(split).toEqual([]);
  });

  test("a dependency two packages share comes from the catalog", () => {
    const loose = [...uses]
      .filter(([name, list]) => list.length > 1 && !OWN_VERSION.has(name))
      .flatMap(([name, list]) =>
        list
          .filter((u) => !u.spec.startsWith("catalog:"))
          .filter((u) => !(PUBLISHED.has(u.dir) && u.field === "dependencies"))
          .map((u) => `${u.dir} ${u.field} ${name}@${u.spec}`),
      );
    expect(loose).toEqual([]);
  });

  test("every catalog entry is used, and named in only one catalog", () => {
    const groups = [rootManifest.catalog ?? {}, ...Object.values(rootManifest.catalogs ?? {})];
    const names = groups.flatMap((group) => Object.keys(group));
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    expect(names.filter((name) => !uses.has(name))).toEqual([]);
  });

  test("the npm sample matches the catalog where it shares a dependency", () => {
    const sample = read(EXAMPLE);
    const drift = Object.entries({ ...sample.dependencies, ...sample.devDependencies })
      .filter(([name]) => !EXAMPLE_OWN.has(name))
      .filter(([name, spec]) => catalogVersion(name) !== undefined && catalogVersion(name) !== spec)
      .map(([name, spec]) => `${name}@${spec}, catalog ${catalogVersion(name)}`);
    expect(drift).toEqual([]);
  });
});
