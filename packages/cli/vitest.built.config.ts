import { defineConfig } from "vitest/config";

// Integration on the built artifact: the bundle as a child process (`moon run cli:test-built`). Kept out of
// vitest.config.ts so `moon run cli:test` never needs a build.
export default defineConfig({
  test: {
    environment: "node",
    include: ["built/**/*.test.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
  },
});
