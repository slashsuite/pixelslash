import { expect, test } from "vitest";
import { bindingsFrom, missingConfig, publicOrigin } from "./start";

const kept = (name: string) => `kept-${name}`;

test("the environment wins over the build's vars and the self-host defaults", () => {
  const bindings = bindingsFrom(
    {
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      DEFAULT_DIFF_LOCATION: "client",
      APP_NAME: "",
      DIFF_LIMIT_MPX: "30",
      PATH: "/usr/bin",
    },
    ["GITHUB_CLIENT_ID", "DEFAULT_DIFF_LOCATION", "APP_NAME"],
    kept,
  );
  expect(bindings).toMatchObject({
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    DEFAULT_DIFF_LOCATION: "client",
    SENTRY_ENVIRONMENT: "self-host",
    // A self-host default the build's vars do not name is still overridden by the environment.
    DIFF_LIMIT_MPX: "30",
  });
  // An empty one keeps the default: the Docker self-host always has a limit.
  expect(bindingsFrom({ DIFF_LIMIT_MPX: "" }, [], kept)["DIFF_LIMIT_MPX"]).toBe("24.5");
  // An empty value is unset, and a name that is neither a var nor a secret is not a binding.
  expect(bindings).not.toHaveProperty("APP_NAME");
  expect(bindings).not.toHaveProperty("PATH");
});

test("the signing and sealing secrets come from the volume unless the environment sets them", () => {
  const generated = bindingsFrom({}, [], kept);
  expect(generated["IMAGE_SIGNING_SECRET"]).toBe("kept-IMAGE_SIGNING_SECRET");
  expect(generated["MODEL_KEY_SECRET"]).toBe("kept-MODEL_KEY_SECRET");
  expect(bindingsFrom({ IMAGE_SIGNING_SECRET: "env" }, [], kept)["IMAGE_SIGNING_SECRET"]).toBe(
    "env",
  );
});

test("refuses to start without the GitHub OAuth app", () => {
  expect(missingConfig({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })).toBeNull();
  expect(missingConfig({ GITHUB_CLIENT_ID: "id" })).toMatch(/^GITHUB_CLIENT_SECRET must be set/);
  expect(missingConfig({})).toMatch(/^GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set/);
});

test("the public URL is seen as its origin, and a URL that is not one stops the start", () => {
  expect(publicOrigin("https://review.example.com/")).toBe("https://review.example.com");
  expect(publicOrigin("https://Review.example.com:8443/x?y")).toBe(
    "https://review.example.com:8443",
  );
  expect(publicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  expect(publicOrigin("review.example.com")).toBeNull();
  expect(publicOrigin("ftp://review.example.com")).toBeNull();
  const app = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" };
  expect(missingConfig({ ...app, PIXELSLASH_PUBLIC_URL: "https://review.example.com" })).toBeNull();
  expect(missingConfig({ ...app, PIXELSLASH_PUBLIC_URL: "review.example.com" })).toMatch(
    /^PIXELSLASH_PUBLIC_URL must be an http or https URL/,
  );
});

const miniflarePin = async (path: string): Promise<string | undefined> =>
  (await Bun.file(new URL(path, import.meta.url)).json()).dependencies.miniflare;

test("the image installs the Miniflare the app builds and tests against", async () => {
  expect(await miniflarePin("../../../../docker/self-host/package.json")).toBe(
    await miniflarePin("../../package.json"),
  );
});
